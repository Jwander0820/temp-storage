# 系統架構總覽

> 狀態：現行架構  
> 最後更新：2026-08-27  
> 適用版本：D1 migrations `0001`–`0008`

## 1. 系統目標

Jwander Temp Storage 是私有、邀請制的共享暫存檔案服務。系統提供：

- 可命名、可撤銷、具期限與額度的邀請。
- 「上傳與瀏覽」及「僅瀏覽與下載」兩種權限。
- 檔案 reservation、內容檢測、R2 儲存、共享瀏覽與受控下載。
- 管理員邀請管理與檔案刪除。
- 到期清理、D1/R2 reconciliation 與 R2 lifecycle 保險。

它不是永久雲端硬碟，也不提供資料夾、版本控制、帳號系統或細粒度單檔 ACL。檔案在有效期間對所有持有有效 invitation session 的受邀者可見；取得公開單檔 URL 後，可在檔案有效期間直接開啟或下載。

## 2. 技術棧

| 層級           | 技術                                      | 責任                                                 |
| -------------- | ----------------------------------------- | ---------------------------------------------------- |
| Web UI         | TypeScript、HTML、CSS、Vite               | 邀請驗證、上傳、共享瀏覽、檔案預覽與管理介面         |
| Edge API       | Cloudflare Workers、Hono                  | 驗證、配額、檔案政策、媒體串流、清理與 API           |
| Metadata       | Cloudflare D1                             | 檔案狀態、reservation、邀請、session、配額與清理紀錄 |
| Object storage | Cloudflare R2 `cdn` bucket                | `temp-storage/objects/` 下的檔案本體                 |
| Public media   | R2 Custom Domain                          | 只提供白名單 inline 媒體的直接預覽                   |
| Bot protection | Cloudflare Turnstile                      | 邀請交換與管理員登入前的人機驗證                     |
| Rate limiting  | Workers Rate Limiting binding + D1 events | 檔案清單極端輪詢與上傳 IP／流量限制                  |
| Scheduled work | Worker Cron + R2 Lifecycle                | 每小時清理、每日 reconciliation 與漏刪保險           |

## 3. 高階拓樸

```text
Browser
  │
  ├─ https://upload.jwander.net
  │    └─ Cloudflare Worker (Hono)
  │         ├─ Static Assets → dist/client
  │         ├─ API / session / quota / file policy
  │         ├─ D1 binding: DB
  │         └─ R2 binding: FILES
  │
  └─ https://cdn.jwander.net
       └─ R2 Custom Domain
            └─ temp-storage/objects/*（僅安全 inline 預覽）

Cron 0 * * * *
  └─ Worker scheduled handler
       ├─ 每小時 cleanup
       └─ 03:00 UTC reconciliation
```

Worker 的 hostname boundary 只接受 `UPLOAD_ORIGIN` hostname。`cdn.jwander.net` 不由 Worker 接管，仍是既有 R2 Custom Domain。

## 4. 程式結構

```text
public/                 # 瀏覽器 UI、樣式與純前端 helpers
src/index.ts            # Hono 組裝、共用 middleware、scheduled handler
src/routes/             # HTTP route 與 request/response 邊界
src/middleware/         # session、admin、hostname、headers、request ID、rate limit
src/services/           # 業務流程、內容分類、R2、清理與刪除
src/repositories/       # D1 query 與交易邊界
src/domain/             # 核心型別、錯誤與常數
migrations/             # 依序套用的 D1 schema
test/                   # Workers runtime、D1 與 R2 整合測試
```

依賴方向原則：route 呼叫 service/repository；service 可以組合 repository 與 R2；repository 不依賴 HTTP context 或 UI。

## 5. 信任與權限模型

| 能力                | 取得方式                                  | 主要用途                                                             |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| 匿名公開能力        | 公開 route 或不可猜測的單檔 URL           | Health/config、有效單檔頁面、預覽或下載                              |
| Invitation token    | 邀請 URL fragment                         | 經 Turnstile 交換 invitation session；不直接當 API Bearer token 使用 |
| Invitation session  | HttpOnly Cookie                           | 共享檔案清單、容量、上傳；每次請求重新驗證邀請狀態與期限             |
| Browse-only session | `can_upload = 0` 的 invitation session    | 可瀏覽、預覽與下載；所有 `/api/uploads/*` 由後端回覆 403             |
| Admin bootstrap     | Access 後通過限流、Turnstile 與管理 token | 只可由 `POST /api/admin/session` 交換 admin session                  |
| Admin session       | 4 小時 HttpOnly Cookie                    | 邀請管理、共享檔案 capability 與管理員刪除                           |
| Delete token        | 完成上傳時一次回傳的 capability           | 刪除對應單檔，不授予其他檔案或管理能力                               |

這些能力彼此獨立。永久 `ADMIN_TOKEN` 不能直接操作管理 API；Admin session 不自動授予上傳權限；browse-only invitation 不可因額度欄位或 UI 狀態繞過後端限制。正式環境以 Cloudflare Access 只包住 `/admin`、`/admin/*` 與 `/api/admin/*`，不得讓一般邀請流程經過 Access。

## 6. 核心流程

### 6.1 邀請建立與交換

1. 管理員使用 admin session 建立具 label、期限、權限與額度的邀請。
2. Worker 只保存 invitation token hash；原始 token 放在邀請 URL fragment。同一邀請可新增多條有效連結，並共用期限、權限與額度。
3. 瀏覽器讀取 fragment，連同 Turnstile token 與選用 access code 呼叫 `/api/invitations/exchange`。
4. Worker 驗證後建立短期 HttpOnly invitation session，回傳權限與剩餘額度。
5. 複製邀請會新增等效連結，原連結與既有 session 保持有效；重新簽發或撤銷時，所有舊連結與相關 session 一併失效。

### 6.2 管理員登入

```text
Cloudflare Access（正式環境）
  → ADMIN_LOGIN_RATE_LIMITER（5 次／分鐘／IP）
  → Turnstile
  → timing-safe ADMIN_TOKEN 比對
  → 4 小時 HttpOnly Admin Session
```

所有後續 `/api/admin/*` 只接受 admin session。`GET /api/session/capabilities` 位於 Access 範圍外，只回傳 `admin: true/false` 給 `/files` 與 `/file/:id` 使用；真正管理動作仍由伺服器重新授權。

### 6.3 上傳

```text
POST /api/uploads/reserve
  → 驗證 invitation session 與 can_upload
  → 檢查全站、邀請、IP 與時間窗配額
  → D1 transaction 建立 file + reservation 並預留 bytes

PUT /api/uploads/:uploadId
  → 驗證 session、invitation ownership、Content-Length 與 reservation
  → 讀取內容前綴並分類檔案
  → blocked: 取消 reservation
  → allowed: 串流寫入 R2
  → 驗證實際大小
  → D1 將 file 標為 active 並消耗 reservation
  → 回傳 public file metadata + 一次性 delete token
```

物件 key 固定在 `temp-storage/objects/YYYY/MM/DD/:fileId`。檔案宣告 MIME、副檔名與內容偵測都會參與政策判斷；HTML、SVG、JavaScript 等主動內容 fail closed。

### 6.4 瀏覽、預覽與下載

- `/api/files` 需要有效 invitation 或 admin session，使用 `created_at + id` cursor 分頁。
- 清單只回傳 `active` 且未到期的安全 public serializer，不含 object key、hash 或 invitation ID。
- `/file/:id` 是前端單檔頁面。
- 白名單媒體可使用 `cdn.jwander.net` 的 R2 URL inline 預覽。
- `/p/:id` 是 Worker 預覽 fallback。
- `/d/:id` 永遠先由 Worker 查 D1 狀態，再從 R2 串流附件下載並支援 HEAD/Range。

邀請檔案數或容量用完時，只拒絕新的 reservation；既有有效 session 仍可瀏覽與下載。

### 6.5 刪除

1. Delete-token route 或 admin route 將檔案進入刪除流程。
2. D1 狀態避免重複扣除容量。
3. R2 物件刪除後，metadata 保留一段時間供稽核與重試。
4. 已刪除或到期檔案不再出現在共享清單，public item/download 回覆 404。

### 6.6 Cleanup 與 reconciliation

每小時 Cron：

- 釋放到期 reservation。
- 刪除到期檔案。
- 清除逾期 invitation/admin session。
- 移除超過保留期的 deleted metadata。
- 寫入 `cleanup_runs` 並輸出結構化事件 log。

每日 03:00 UTC 另外執行 reconciliation：

- D1 顯示 active 但 R2 遺失的檔案標為 deleted。
- R2 prefix 中沒有 D1 metadata 且超過安全等待時間的 orphan object 會被刪除。

R2 Lifecycle Rule 對 `temp-storage/objects/` 提供 90 天漏刪保險，但不取代 Worker cleanup，也不更新 D1 帳本。

## 7. D1 資料模型

| Table                      | 角色                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `files`                    | 檔案 metadata、狀態、MIME、期限、R2 key 與 invitation 關聯                    |
| `upload_reservations`      | 上傳前的 byte reservation 與釋放狀態                                          |
| `storage_usage`            | 全站 used/reserved/max bytes 單列帳本                                         |
| `rate_limit_events`        | IP hash 與 invitation 維度的 reservation／流量事件                            |
| `upload_invitations`       | 主要 token hash、label、期限、檔案／容量額度、`unlimited_files`、`can_upload` |
| `upload_invitation_tokens` | 同一邀請額外簽發的 token hash；不保存明文 token                               |
| `upload_sessions`          | Invitation 的短期 HttpOnly session hash 與撤銷狀態                            |
| `admin_sessions`           | 管理員短期 HttpOnly session hash 與撤銷狀態                                   |
| `cleanup_runs`             | 排程清理的開始、結果與錯誤統計                                                |

Schema 只透過 `migrations/` 依序演進。不得修改已在正式環境套用的舊 migration；新增下一個編號並讓程式在 migration 前後的部署順序可預期。

## 8. API 分區

### 公開／URL capability

- `GET /api/health`
- `GET /api/config`
- `POST /api/invitations/exchange`
- `GET /api/files/:fileId`
- `DELETE /api/files/:fileId`（DeleteToken）
- `GET|HEAD /p/:fileId`
- `GET|HEAD /d/:fileId`

### Invitation session

- `GET /api/storage`
- `GET /api/files`
- `GET|DELETE /api/invitations/session`
- `POST /api/uploads/reserve`
- `PUT /api/uploads/:uploadId`

### Admin session

- `GET /api/session/capabilities`（公開、只回傳 capability）
- `GET|POST|DELETE /api/admin/session`
- `POST /api/admin/sessions/revoke-all`
- `GET /api/admin/status`
- `GET /api/admin/invitations`
- `POST /api/admin/invitations`
- `POST /api/admin/invitations/:invitationId/copy`
- `POST /api/admin/invitations/:invitationId/reissue`
- `DELETE /api/admin/invitations/:invitationId`
- `GET /api/admin/files`
- `DELETE /api/admin/files/:fileId`
- `POST /api/admin/cleanup`
- `POST /api/admin/reconcile`

實際 request schema 與狀態碼以 route、domain error 與測試為準；新增 endpoint 時同步更新本節與 README API 摘要。

## 9. 設定與秘密

非秘密設定集中在 `wrangler.jsonc` 的 `vars`，啟動時由 `src/env.ts` 驗證相依關係。Cloudflare bindings 包含 `ASSETS`、`DB`、`FILES`、`FILE_BROWSER_RATE_LIMITER` 與獨立的 `ADMIN_LOGIN_RATE_LIMITER`。

必要秘密：

- `TURNSTILE_SECRET_KEY`
- `DELETE_TOKEN_PEPPER`
- `IP_HASH_PEPPER`
- `ADMIN_TOKEN`

選用秘密：

- `UPLOAD_ACCESS_CODE`
- `TURNSTILE_TEST_MODE`（只用於本機測試）

秘密只放 `.dev.vars` 或 Cloudflare runtime secrets，不放 Git、前端、文件、log 或 Workers Builds 的公開變數。

## 10. 部署與可觀測性

- Production branch 為 `main`，GitHub 連接 Cloudflare Workers Builds。
- `deploy:cloudflare` 先套用遠端 D1 migrations，再部署 Worker 與 Static Assets。
- `wrangler.jsonc` 開啟 invocation logs；log 使用 JSON event 名稱、request ID 與非秘密識別資訊。
- Trace 採樣率與 Rate Limiting binding 由 Wrangler 設定控制。
- 日常應透過 GitHub/Workers Builds 部署；手動 deploy 是需要明確授權的備援流程。

## 11. 架構變更檢查

- [ ] 權限是否在後端 enforcement，而不只是 UI？
- [ ] D1 與 R2 是否可能留下 reservation、orphan 或重複扣帳？
- [ ] 是否只操作 `temp-storage/objects/`？
- [ ] API 是否避免回傳 object key、hash、pepper 或 secret？
- [ ] Session 到期、撤銷、額度耗盡與重試路徑是否有測試？
- [ ] 新 schema 是否使用新的 migration 編號？
- [ ] Cleanup、reconciliation、Range/HEAD 與 public URL 是否仍相容？
- [ ] `AGENTS.md`、本文件、README 與相關規格是否需要同步更新？
