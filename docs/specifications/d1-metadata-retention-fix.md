# D1 已刪除檔案 metadata 清理修正規格

> 狀態：已實作，待正式環境 migration 與排程驗收
> 最後更新：2026-08-28
> 影響範圍：D1、排程清理、檔案生命週期

## 問題摘要

檔案本體從 R2 刪除後，`files` row 會先保留一段 audit retention，再由
`purgeDeletedMetadata()` 清除。現行資料表關係為：

```text
files (parent)
└─ upload_reservations.file_id (child, UNIQUE, FOREIGN KEY，沒有 ON DELETE CASCADE)
```

修正前的 purge 會直接刪除 `files` parent row：

```sql
DELETE FROM files
WHERE status = 'deleted'
  AND deleted_at <= ?1;
```

D1 預設執行 foreign key constraint。只要該檔案仍有 `upload_reservations` row，這個刪除就會以
`FOREIGN KEY constraint failed` 失敗。R2 物件可能早已刪除，但 D1 metadata 與 reservation 會持續累積，
cleanup run 也可能被標成 partial 或 failed。

這不是「管理員從網站刪除」本身造成的問題；管理頁刪除、delete token 刪除與到期清理最後都可能走到
同一個 metadata retention purge。直接從 R2 Dashboard 刪除則會製造另一種不一致：物件消失，但 D1
仍可能顯示檔案存在。因此日常刪除應使用網站管理頁，不應直接刪除
`temp-storage/objects/` 內的 R2 物件。

## 修正目標

- 到達 metadata retention cutoff 後，先刪除該檔案的 reservation child row，再刪除 file parent row。
- 每次只處理固定批次，避免單次 cron 產生過多 D1 rows read／written 或執行時間。
- 同一批 child 與 parent 操作位於同一個 D1 batch transaction。
- 清理可重複執行；沒有符合資料時回傳 `0`，不視為失敗。
- 不改變 R2 object 刪除、storage quota 釋放或七日 metadata retention 的現有語意。
- 不碰同一個 R2 bucket 的其他 prefix。

## 已完成實作

### 1. 以程式明確控制 child-first 刪除

`purgeDeletedMetadata()` 已增加 `limit`，並以同一 cutoff、排序與批次上限建立兩個 statement：

1. 刪除目標 files 對應的 `upload_reservations`。
2. 刪除同一批 `files`。

兩個 statement 依此順序交給 `database.batch()`。概念 SQL 如下；實作時應使用 binding，不拼接輸入：

```sql
DELETE FROM upload_reservations
WHERE file_id IN (
  SELECT id
  FROM files
  WHERE status = 'deleted'
    AND deleted_at <= ?1
  ORDER BY deleted_at, id
  LIMIT ?2
);

DELETE FROM files
WHERE id IN (
  SELECT id
  FROM files
  WHERE status = 'deleted'
    AND deleted_at <= ?1
  ORDER BY deleted_at, id
  LIMIT ?2
);
```

不建議只捕捉 foreign key error 後忽略，也不建議暫時關閉 foreign key enforcement。這兩種做法都會
保留不一致資料。

### 2. 用 migration 補 purge 查詢索引

已新增 migration `0009_add_deleted_metadata_purge_index.sql`：

```sql
CREATE INDEX IF NOT EXISTS idx_files_status_deleted_at_id
ON files(status, deleted_at, id);
```

這個 migration 是為了降低定期 purge 的掃描成本；必要的 correctness 修正仍是 child-first deletion。
目前不建議為了加入 `ON DELETE CASCADE` 重建 `upload_reservations` 整張表：明確刪除更容易稽核，變更
範圍也較小。若未來有更多依附 `files` 的資料表，再以獨立 ADR 評估 cascade。

### 3. 保留與清理政策

| 資料                     | 建議政策                                                        |
| ------------------------ | --------------------------------------------------------------- |
| R2 object                | 使用者刪除或到期時立即刪除；Lifecycle Rule 是漏刪保險           |
| `files` deleted metadata | 維持現行七日 retention，之後由 cron 分批 purge                  |
| `upload_reservations`    | 與對應的 deleted file metadata 同批刪除                         |
| `cleanup_runs`           | 另訂固定天數或筆數上限；不納入本次 correctness 修正             |
| `rate_limit_events`      | 另行設計，不可直接刪除仍被 invitation lifetime quota 使用的 row |

`rate_limit_events` 目前同時是 quota 帳本，不能只因為資料變多就按日期清除，否則可能讓 invitation 重新取得
已使用的檔案數或 byte 額度。這應作為後續獨立規格。

## 自動測試涵蓋

本機測試涵蓋以下行為：

1. 建立 `files` 與對應 `upload_reservations`，將檔案標成 deleted 且早於 cutoff；purge 後兩者都不存在。
2. deleted file 尚未到 cutoff 時，兩者都保留。
3. `failed` 等非 deleted 狀態不會被 metadata purge。
4. 一次超過 batch limit 時只刪除最舊一批，下一次執行能完成剩餘資料。
5. 重複執行 purge 不報錯，第二次刪除數為 `0`。
6. cleanup service 正確記錄 purged count，不出現 foreign key error。
7. 驗證 storage usage 不會在 metadata purge 再扣一次，避免重複釋放 quota。

## 部署與驗收順序

1. 在本機 D1 套用新 migration。
2. 執行 repository、cleanup service 與完整測試。
3. 建立一筆測試檔案，經網站管理頁刪除；確認 R2 物件消失但 D1 metadata 在 retention 內仍存在。
4. 以本機時間或 fixture 讓資料跨過 cutoff，執行 cleanup，確認 reservation 與 file row 一起消失。
5. 正式環境先套 migration，再部署相容的新程式；不得由本規格自動執行 remote migration 或部署。
6. 部署後檢查數次 `cleanup_runs`，確認沒有 foreign key error，並觀察 D1 rows read／written。

## 完成條件

- 所有上述測試通過。
- cleanup 可清除超過 retention 的 metadata，且沒有 orphan row 或 foreign key error。
- 文件、migration 編號與實際 repository method signature 一致。
- 正式環境經至少兩次排程清理後仍無異常，才將本規格移入 archive。
