# 執行參數與服務限制

> 狀態：現行參考文件  
> 最後更新：2026-08-28
> 用途：查詢非秘密 runtime 參數、預設限制與秘密名稱

正式非秘密參數集中在 [`../../wrangler.jsonc`](../../wrangler.jsonc) 的 `vars`。Worker 啟動時由 `src/env.ts` 驗證型別與參數關係；設定錯誤會 fail closed，不會靜默改用硬編碼值。

## 使用者可感知的預設限制

| 項目               |              預設值 |
| ------------------ | ------------------: |
| 全站容量           |               3 GiB |
| 單檔上限           |              50 MiB |
| 檔案保存           |               90 天 |
| 單次加入           |           10 個檔案 |
| 同時上傳           |                2 個 |
| 每 IP 每小時上傳   |             500 MiB |
| 每 IP 每日上傳     |               1 GiB |
| 邀請預設期限       |                7 天 |
| 邀請期限範圍       |            1–365 天 |
| 邀請預設額度       |  10 個檔案、300 MiB |
| Invitation session |             12 小時 |
| Admin session      |              4 小時 |
| Admin 登入限流     |   每 IP 每分鐘 5 次 |
| 邀請交換限流       |  每 IP 每分鐘 20 次 |
| 公開單檔限流       | 每 IP 每分鐘 300 次 |

## 預設值的設計依據

| 項目                 | 對應設定                      | 性質與原因                                                                                                                                                        |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全站容量 3 GiB       | `MAX_STORAGE_BYTES`           | 專案的成本與濫用護欄，不是 R2 bucket 上限。只計算 `temp-storage/objects/`，不包含共用 `cdn` bucket 的其他內容。                                                   |
| 單檔上限 50 MiB      | `MAX_FILE_BYTES`              | 專案主動採用的保守上限，不是 R2 單檔硬限制。它低於 Cloudflare Free／Pro 帳號的 100 MB Worker request body 上限，並配合每小時 500 MiB、每日 1 GiB 的後端流量護欄。 |
| 保存期限 90 天       | `FILE_RETENTION_SECONDS`      | 產品定位是暫存區，因此以 90 天作為生命週期；Worker Cron 是主要清理，R2 Lifecycle Rule 是漏刪保險。這不是 Cloudflare 強制期限。                                    |
| 單次加入 10 個       | `CLIENT_MAX_FILES_PER_BATCH`  | 前端操作與佇列可理解性的限制，不是安全邊界。後端仍獨立驗證 invitation、reservation 與配額。數值也和預設邀請的 10 個檔案額度一致。                                 |
| 同時上傳 2 個        | `CLIENT_MAX_PARALLEL_UPLOADS` | 前端 backpressure 策略，避免同一裝置同時建立過多長時間上傳，並讓進度與錯誤回饋保持清楚；不是 Cloudflare 硬限制。                                                  |
| 每 IP 每小時 500 MiB | `UPLOAD_HOURLY_BYTES`         | 防止單一來源短時間大量消耗 Worker、D1 與 R2；相較舊值 100 MiB，保留較充足的大量傳檔空間。                                                                         |
| 每 IP 每日 1 GiB     | `UPLOAD_DAILY_BYTES`          | 防止單一來源長時間無限制消耗資源；全站仍受 3 GiB 帳本限制，邀請本身也有獨立容量。                                                                                 |

### 流量限制是否隱藏

`UPLOAD_HOURLY_BYTES` 與 `UPLOAD_DAILY_BYTES` 是 `wrangler.jsonc` 裡可提交的非秘密 Worker vars，不是 secret。它們目前不由 `/api/config` 回傳，也不顯示在前端；後端在建立 upload reservation 時，依每日輪替的 peppered IP hash 計算近一小時與近一日用量，超過時回覆 429。系統不保存原始 IP。

一般使用者會看到 invitation 的檔案數與容量額度，但看不到這兩個 IP 層級護欄。預設 invitation 容量仍是 300 MiB；需要一次分享更多資料時，必須在管理頁建立較高容量的邀請，且仍不得超過全站剩餘容量。

### 為什麼單檔是 50 MiB

目前可以確認的依據如下：

1. Cloudflare Worker 接收的是單次 raw `PUT` request。Cloudflare Free／Pro 帳號的 request body 上限為 **100 MB**；超過會在進入應用程式前回覆 413。注意官方使用十進位 MB，100 MB 約為 95.37 MiB。
2. 本專案將 `MAX_FILE_BYTES` 設為 **52,428,800 bytes（50 MiB）**，明顯低於上述平台邊界，保留方案差異與營運上的安全餘裕。
3. R2 本身不是 50 MiB 的來源。R2 單一物件上限為 5 TiB，single-part upload 上限約 4.995 GiB；但透過 Worker 接收入站檔案時，仍先受到 Worker request body 上限約束。
4. 上傳內容以 stream 寫入 R2，只額外檢查最多 4,096 bytes 的前綴，因此 50 MiB 不是因為 Worker 需要把整個檔案載入記憶體。
5. `src/env.ts` 會驗證 `MAX_FILE_BYTES <= UPLOAD_HOURLY_BYTES <= UPLOAD_DAILY_BYTES`。目前為單檔 50 MiB、每小時 500 MiB、每日 1 GiB。

原始規格沒有留下「為何精確選擇 50 MiB」的決策紀錄，因此不能把它描述成 Cloudflare 規定。依現行設定與實作，它應視為在 100 MB 平台邊界以下、兼顧暫存用途與濫用成本的專案政策。

官方限制來源：

- [Cloudflare Workers request body limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)
- [Cloudflare R2 object and upload limits](https://developers.cloudflare.com/r2/platform/limits/)

### 調整單檔上限時

提高 `MAX_FILE_BYTES` 前必須一起確認：

- 正式 Cloudflare account plan 的 request body 上限；不能只看 Workers plan。
- `UPLOAD_HOURLY_BYTES`、`UPLOAD_DAILY_BYTES`、邀請容量與 `MAX_STORAGE_BYTES` 是否仍合理。
- 現行上傳是單次 request，尚未實作 multipart upload。
- 大檔上傳的中斷、逾時、reservation 釋放、手機網路與成本風險。
- 更新 `wrangler.jsonc` 後執行 `pnpm types`，並同步測試與本文件。

## 非秘密變數

| 類別           | 變數                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全站與檔案限制 | `MAX_STORAGE_BYTES`, `MAX_FILE_BYTES`, `FILE_RETENTION_SECONDS`                                                                                                                      |
| Reservation    | `RESERVATION_TTL_SECONDS`, `UPLOAD_RESERVATION_WINDOW_SECONDS`, `UPLOAD_RESERVATION_LIMIT`                                                                                           |
| IP 流量        | `UPLOAD_HOURLY_WINDOW_SECONDS`, `UPLOAD_HOURLY_BYTES`, `UPLOAD_DAILY_WINDOW_SECONDS`, `UPLOAD_DAILY_BYTES`                                                                           |
| 邀請           | `INVITATION_MIN_TTL_SECONDS`, `INVITATION_DEFAULT_TTL_SECONDS`, `INVITATION_MAX_TTL_SECONDS`, `INVITATION_DEFAULT_MAX_FILES`, `INVITATION_MAX_FILES`, `INVITATION_DEFAULT_MAX_BYTES` |
| Session        | `UPLOAD_SESSION_TTL_SECONDS`, `ADMIN_SESSION_TTL_SECONDS`                                                                                                                            |
| 前端批次       | `CLIENT_MAX_FILES_PER_BATCH`, `CLIENT_MAX_PARALLEL_UPLOADS`                                                                                                                          |
| Cache          | `MEDIA_PREVIEW_CACHE_SECONDS`, `PUBLIC_CONFIG_CACHE_SECONDS`                                                                                                                         |
| Cleanup        | `CLEANUP_BATCH_LIMIT`, `DELETED_METADATA_RETENTION_SECONDS`                                                                                                                          |
| Reconciliation | `RECONCILE_METADATA_LIMIT`, `RECONCILE_OBJECT_LIMIT`, `RECONCILE_ORPHAN_GRACE_SECONDS`                                                                                               |
| 開關與 origin  | `UPLOADS_ENABLED`, `UPLOAD_ORIGIN`, `CDN_ORIGIN`                                                                                                                                     |
| 公開 Turnstile | `TURNSTILE_SITE_KEY`                                                                                                                                                                 |

完整數值以 `wrangler.jsonc` 為準。修改時必須確認：

- invitation TTL 符合 `min <= default <= max`。
- 單檔上限不超過小時與每日流量上限。
- 每日視窗不超過 24 小時。
- Origin 是合法且符合實際 hostname boundary 的 URL。
- `UPLOADS_ENABLED=false` 只作為緊急停止新上傳的開關，不應取代正常權限與配額。

## Secrets

必要：

```text
TURNSTILE_SECRET_KEY
DELETE_TOKEN_PEPPER
IP_HASH_PEPPER
ADMIN_TOKEN
```

選用：

```text
UPLOAD_ACCESS_CODE
```

`TURNSTILE_TEST_MODE=true` 是只放在本機環境的測試旗標，不是正式 secret；只有搭配官方測試 secret 才可啟用。任何 secret 都不得寫入 `wrangler.jsonc`、Git、前端、文件或 log。

`ADMIN_TOKEN` 是只供 `POST /api/admin/session` 使用的 bootstrap credential，不是 Admin API master key。程式要求 43–512 個 URL-safe 字元；正式值應以 `python -c "import secrets; print(secrets.token_urlsafe(32))"` 產生並放入 Worker secret。其他 `/api/admin/*` 只接受有效 admin session。

## Rate Limiting bindings

| Binding                            | 限制         | Key                                                   |
| ---------------------------------- | ------------ | ----------------------------------------------------- |
| `FILE_BROWSER_RATE_LIMITER`        | 120 次／分鐘 | invitation/admin session principal                    |
| `ADMIN_LOGIN_RATE_LIMITER`         | 5 次／分鐘   | `CF-Connecting-IP`；本機使用固定開發 key              |
| `INVITATION_EXCHANGE_RATE_LIMITER` | 20 次／分鐘  | `CF-Connecting-IP`；在 JSON 與 Turnstile 前執行       |
| `PUBLIC_FILE_RATE_LIMITER`         | 300 次／分鐘 | `CF-Connecting-IP`；metadata、刪除、Worker 預覽與下載 |

所有 binding 必須使用不同 namespace。管理員登入與邀請交換限流都在 Turnstile 前執行；公開單檔限流則在 D1 與 R2 操作前執行。超限一律回覆 429 與 `Retry-After: 60`。CDN Custom Domain 的直接物件流量不經 Worker，仍須使用 Cloudflare WAF／Rate Limiting Rule 保護。

## JSON request body

會解析 JSON 的 mutation route 固定限制為 16 KiB，包含邀請交換、管理員登入、建立邀請與 upload reservation。上限同時處理 `Content-Length` 與串流 request body；超限回覆 413，格式錯誤回覆 400。Raw file `PUT` 不使用此限制，仍依 reservation 與 `MAX_FILE_BYTES` 驗證。

## Session mutation Origin

帶有 `jwander_admin_session` 或 `jwander_upload_session` Cookie 的 `POST`、`PUT`、`PATCH`、`DELETE`，`Origin` 必須與正規化後的 `UPLOAD_ORIGIN` 完全一致。一般同源瀏覽器要求不需額外操作；缺少 Origin、`Origin: null` 及其他子網域會在 session 與資料存取前回覆 403。沒有本系統 session Cookie 的公開 capability 仍依各端點原有的 Turnstile、Authorization 或匿名規則處理。

## 檔案政策

- 可 inline 預覽：JPEG、PNG、WebP、GIF、AVIF、MP4、WebM 與常見音訊。
- 僅下載：PDF、壓縮檔、執行檔、Office 文件與未知 binary。
- 拒絕：HTML、XHTML、SVG、JavaScript、CSS、XML、XSLT、WASM、SWF 等主動內容。

實際判斷會同時參考宣告 MIME、副檔名與內容偵測。未知或衝突的主動內容必須 fail closed。

## 已知限制

- 不提供防毒、壓縮檔內容掃描、轉碼、影像最佳化或 multipart upload。
- 單次 request 同時受程式的 50 MiB 限制與 Cloudflare 帳號當下 request body 上限約束。
- Reconciliation 採批次處理，超出單次上限的資料由後續排程繼續。
- 公開預覽可能保留至 `MEDIA_PREVIEW_CACHE_SECONDS` 到期。
- D1 的容量帳本只計算 `temp-storage/objects/`，不包含共用 `cdn` bucket 其他物件。
- 邀請 URL 是 bearer capability；被轉傳時，其他人可在邀請有效與額度範圍內使用。
