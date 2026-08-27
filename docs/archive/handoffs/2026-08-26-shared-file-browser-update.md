# 共享檔案瀏覽更新移交報告

- 狀態：歷史快照（不作為現行規格）
- 讀取政策：冷封存；只在使用者明確要求時調閱
- 移交日期：2026-08-26
- 專案：`jwander-temp-storage`
- 依據：`docs/archive/specifications/shared-file-browser.md`
- 範圍：共享檔案瀏覽頁、collection API、管理檔案 UI、索引 migration、自動化測試，以及後續的請求競態與讀取限流修正
- 部署狀態：本機實作與 dry-run 已完成，尚未部署正式環境

## 本次更新內容

### 1. 新增受邀者共享檔案目錄

- 新增 `/files` 頁面，只有有效 invitation session 可以取得共享檔案清單。
- 清單包含所有 invitation 上傳、仍為 `active` 且尚未到期的檔案。
- 支援 `all`、`image`、`video`、`audio`、`other` 白名單類型篩選。
- 支援以 `created_at DESC, id DESC` 排序的 keyset pagination 與「載入更多」。
- 顯示檔名、大小、偵測類型、上傳時間、到期時間與剩餘時間。
- 圖片縮圖使用 lazy loading；影片與音訊不在清單頁預載完整內容。
- session 無效時顯示邀請提示，不會以空清單混淆使用者。
- UI 補上共享區公開性警語、空狀態、錯誤重試與手機單欄版面。

### 2. 新增共享檔案 collection API

新增 `GET /api/files?cursor=<opaque>&limit=24&type=all`：

- 使用既有 `uploadSessionMiddleware`，每次請求重新驗證 session 與 invitation。
- 固定 `Cache-Control: private, no-store`。
- 從 D1 產生目錄，不呼叫 `R2Bucket.list()`。
- 只查詢 `status = 'active' AND expires_at > now`。
- cursor 同時包含 `created_at` 與 `id`，並完整驗證格式。
- 預設每頁 24 筆，最大 60 筆。
- 對外資料使用既有 public file serializer，不回傳 R2 key、token hash、uploader hash、SHA-256、invitation ID 或 reservation 資料。

新增 `migrations/0006_shared_file_browser.sql`，建立：

```sql
CREATE INDEX idx_files_browse_active
ON files(status, created_at DESC, id DESC);
```

查詢計畫驗證會使用 `idx_files_browse_active`，未產生 temporary sort B-tree。

### 3. 擴充 Admin 檔案管理 UI

- `/admin` 登入後可載入 active 檔案清單與更多分頁。
- 顯示檔名、大小、MIME、狀態、建立時間、到期時間、預覽及下載入口。
- 新增 native dialog 刪除確認，內容包含檔名與停止公開存取的提示。
- 刪除送出後停用該筆按鈕，成功後移除項目並刷新容量。
- 後端繼續使用既有 `deleteFileAsAdmin()`，維持 R2、D1 與容量帳本一致。
- 使用者提供的檔名以 `textContent` 呈現，不在 DOM 或儲存空間暴露管理 token、delete token 或 R2 key。

### 4. 修正共享清單請求競態

快速切換類型或在前一個清單請求尚未完成時再次讀取，原本可能由較舊、較慢的回應覆蓋最新結果與 pagination cursor。

本次新增 latest-request coordinator：

- 新請求開始時透過 `AbortController` 取消上一個請求。
- 每個請求保留 generation；只有最新 generation 可以更新清單、cursor 與載入狀態。
- 已取消或已過期的請求安靜結束，不顯示錯誤也不覆蓋新狀態。
- 請求開始時固定本次使用的 type 與 cursor，避免讀取期間全域狀態改變。

### 5. 為 `GET /api/files` 加入寬鬆讀取限流

新增 Cloudflare Workers Rate Limiting binding：

- Binding：`FILE_BROWSER_RATE_LIMITER`
- 門檻：每個有效 invitation session 每 60 秒 120 次
- Key：通過驗證的 `upload_sessions.id`
- 超過門檻：回傳 HTTP `429`、錯誤碼 `RATE_LIMITED` 與 `Retry-After: 60`
- 觀測事件：`file_browser.rate_limited`
- 不寫入上傳用途的 D1 `rate_limit_events`

限流在 invitation session 驗證後執行，因此到期或撤銷的 session 仍優先回傳 `401 INVITATION_REQUIRED`。
它會阻止超量請求繼續執行檔案清單查詢，但 Worker 程式內 binding 無法阻止請求先進入 Worker，session 驗證查詢也仍會執行；若需在 Worker 前攔截流量，必須另設 Cloudflare WAF／Rate Limiting Rules。

這是近似、最終一致且依 Cloudflare location 計數的濫用護欄，不是精準配額系統。120 次／分鐘刻意保持寬鬆，只攔截極端輪詢，不影響正常篩選與分頁。

### 6. 明確未處理項目

管理頁「已到期但 cleanup 尚未執行的 active 檔案仍顯示公開中」維持現況，本次沒有修改。

## 完整搬移檔案清單

以下路徑皆相對於專案根目錄。包含本移交文件共 **18 個檔案：7 個新增、11 個更新**。

### 新增檔案（7）

| 路徑                                                             | 用途                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `migrations/0006_shared_file_browser.sql`                        | 新增共享清單查詢索引。                                          |
| `src/services/file-browser-service.ts`                           | 集中處理清單白名單、cursor、查詢、分頁與 public serialization。 |
| `test/file-browser.test.ts`                                      | 共享清單、權限、分頁、管理刪除與讀取限流整合測試。              |
| `public/latest-request.ts`                                       | 管理前端最新請求、取消舊請求與判斷 stale response。             |
| `src/middleware/file-browser-rate-limit.ts`                      | 共用清單的 session 級 Rate Limiting middleware。                |
| `test/latest-request.test.ts`                                    | 驗證新請求會取消舊請求，且只有最新請求維持 current。            |
| `docs/archive/handoffs/2026-08-26-shared-file-browser-update.md` | 本移交報告。                                                    |

### 更新檔案（11）

| 路徑                                | 更新內容                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `public/index.html`                 | 新增 `/files` 畫面、類型篩選、清單狀態、Admin 檔案區與刪除 dialog。            |
| `public/styles.css`                 | 新增共享清單、檔案卡、篩選器、Admin 檔案列、dialog 與響應式樣式。              |
| `public/app.ts`                     | 新增共享清單與 Admin 檔案互動，並接入 latest-request coordinator。             |
| `src/routes/files.ts`               | 新增受 session 保護的 collection route，並套用檔案瀏覽限流。                   |
| `src/routes/admin.ts`               | 將既有 Admin files API 回應接到 public serializer 與管理 UI 所需欄位。         |
| `src/app-types.ts`                  | 新增 Hono context variable `uploadSessionId`。                                 |
| `src/middleware/upload-session.ts`  | 驗證成功後保存 `session.session_id`，供限流使用。                              |
| `wrangler.jsonc`                    | 宣告 `FILE_BROWSER_RATE_LIMITER`，門檻為 120 requests / 60 seconds。           |
| `src/worker-configuration.d.ts`     | Wrangler 產生的新 Rate Limit binding 型別；可搬移或在目的電腦重新產生。        |
| `README.md`                         | 補充共享檔案功能、Rate Limiting binding、跨帳號 namespace 與邊緣防護說明。     |
| `docs/development/local-testing.md` | 新增共享清單、跨 invitation、Admin 刪除、手機版與 session 撤銷的手動驗收流程。 |

`docs/archive/specifications/shared-file-browser.md` 是需求來源文件，不是本次程式修改產物；若目的電腦需要保留規格脈絡，可以一併搬移，但不計入上述 18 個檔案。

本次沒有新增 npm dependency，因此 `package.json` 與 `pnpm-lock.yaml` 沒有因本功能變更。

## 目的電腦還原步驟

1. 將上述 18 個檔案依原相對路徑覆蓋或新增到另一台電腦的同版本專案。
2. 建議額外搬移需求來源 `docs/archive/specifications/shared-file-browser.md`，方便後續追蹤。
3. 不要搬移 `node_modules/`、`dist/`、`.wrangler/`、`.tmp/` 或 `.dev.vars`。
4. 若目標是不同 Cloudflare 帳號，確認 `wrangler.jsonc` 中 Rate Limiting binding 的 `namespace_id` 未與該帳號其他 binding 重複。
5. 安裝既有依賴並重新產生 Worker 型別：

   ```powershell
   pnpm install --frozen-lockfile
   pnpm types
   ```

6. 套用本機 migration 並執行完整驗證：

   ```powershell
   pnpm db:migrate:local
   pnpm check
   ```

7. 確認 dry-run 顯示：

   ```text
   env.FILE_BROWSER_RATE_LIMITER (120 requests/60s)  Rate Limit
   ```

8. 正式部署必須先套用 `0006_shared_file_browser.sql`。專案既有指令會先執行 remote migrations 再部署 Worker：

   ```powershell
   pnpm deploy:cloudflare
   ```

正式 secrets 不應透過移交報告或 `.dev.vars` 複製；請使用既有安全管道或在目標環境重新設定。

## 已完成驗證

2026-08-26 執行 `pnpm check`，結果如下：

- Wrangler binding 型別檢查通過。
- TypeScript 與 ESLint 通過。
- Vitest：12 個測試檔、47 個測試全部通過。
- invitation script syntax check 通過。
- Vite production build 通過。
- Wrangler deploy dry-run 通過，正確辨識 `FILE_BROWSER_RATE_LIMITER`。
- SQLite `EXPLAIN QUERY PLAN` 確認使用 `idx_files_browse_active`。
- `/files` 已以 320、375、768 與橫向手機尺寸檢查，無 console 錯誤或水平溢出。
- `/admin` 未登入狀態與刪除 dialog 語意已檢查；登入後 API 與刪除流程由整合測試涵蓋。

新增或擴充的自動化測試涵蓋：

- 匿名 collection request 回傳 401，且不洩漏檔案資料。
- 不同 invitation 上傳的 active、未到期檔案會出現在共用清單。
- 非 active 或已到期檔案被排除。
- 回應不包含內部欄位。
- 相同 `created_at` 跨頁無重複或遺漏。
- 無效 cursor、limit 與 type 回傳 400。
- invitation 撤銷或 session 到期後回傳 401。
- Admin 可列出並刪除 active 檔案，公開 URL 失效且容量只扣一次。
- 第二個前端請求開始後，第一個請求已被 abort 且不再是 current。
- 同一有效 session 超過 120 次／分鐘後回傳 429、`Retry-After: 60` 與 `RATE_LIMITED`。
- 讀取限流不新增 D1 `rate_limit_events`。
