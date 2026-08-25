# Jwander 暫存區

部署於 Cloudflare 的私人預設暫存檔案服務。前端由 Worker Static Assets 提供，Worker
負責驗證、配額、上傳、受控下載、刪除與排程；檔案本體放在既有的 `cdn` R2 bucket
之 `temp-storage/objects/` namespace，metadata 與容量帳本放在獨立 D1。

## 目前正式環境

- 原始碼：GitHub private repository `Jwander0820/temp-storage`，production branch 為 `main`。
- Worker：`jwander-temp-storage`，公開入口為 `https://upload.jwander.net`。
- 管理頁：`https://upload.jwander.net/admin`，桌面與手機共用。
- 公開媒體：沿用既有 `cdn` R2 bucket 與 `https://cdn.jwander.net` Custom Domain。
- Metadata／邀請／session／配額：D1 `jwander-temp-storage-db`，目前 migrations 到
  `0005_invitation_unlimited_files.sql`。
- 自動部署：GitHub 已連接 Cloudflare Workers Builds；推送新的 commit 到 `main` 後，依序
  執行 `pnpm run build:client` 與 `pnpm run deploy:cloudflare`。


Build 結果可在 **Workers & Pages → jwander-temp-storage → Deployments → Build history** 查看。

## 預設服務限制

- 全站容量：3 GiB。
- 單檔上限：50 MiB。
- 保存期限：90 天。
- 單次加入：10 個檔案；同時處理：2 個上傳。
- 主要清理：每小時 Worker Cron。
- 漏刪保險：R2 `temp-storage/objects/` prefix 的 90 天 Lifecycle Rule。
- 預覽白名單：JPEG、PNG、WebP、GIF、AVIF、MP4、WebM、常見音訊。
- PDF、壓縮檔、執行檔、Office 文件與未知 binary 只能下載。
- HTML、XHTML、SVG、JavaScript、CSS、XML、XSLT、WASM、SWF 會被拒絕。

`cdn.jwander.net` 保留為既有 R2 Custom Domain；Public Development URL（`r2.dev`）應維持
關閉。只有通過內容偵測白名單的媒體會回傳直接 CDN 預覽 URL；下載仍經過 Worker 的
`/d/:id`，未知或不可預覽檔案不回傳 R2 object URL。

以上數字都是 [`wrangler.jsonc`](./wrangler.jsonc) 的非秘密環境變數預設值，不寫死在
Worker 或前端原始碼；正式環境改 `vars`，本機可由 `.dev.vars` 或 `.env` 覆寫。

## 架構

```text
Browser
  ├─ invitation URL fragment + Turnstile ── exchange ── short-lived HttpOnly session
  ├─ Static Assets ─────────────── upload.jwander.net only
  ├─ reserve / raw PUT ────────── session + invitation quota
  ├─ safe media preview ───────── cdn.jwander.net/temp-storage/objects/* ── R2 Custom Domain
  └─ controlled download ──────── upload.jwander.net/d/:id ── Worker + R2 binding

Cron (hourly)
  ├─ release expired reservations
  ├─ delete expired files
  ├─ purge 7-day-old deleted metadata
  └─ reconcile D1/R2 daily at 03:00 UTC
```

## 需求

- Node.js 22 或目前 Wrangler 支援的 LTS。
- pnpm 11。
- Cloudflare 帳號，網域 `jwander.net` 已在該帳號管理。
- 已建立 Turnstile widget。

安裝：

```powershell
corepack enable
pnpm install
```

若 PowerShell 阻擋 `pnpm.ps1`，可直接改用 `pnpm.cmd`。

## 使用 GitHub 交由 Cloudflare 部署

這是推薦流程，**不需要在自己的電腦執行 `pnpm deploy`**。

本專案不是單純的 Cloudflare Pages 靜態網站，而是一個同時包含 Worker API 與 Static
Assets 的 Workers 專案。GitHub 保存原始碼；Cloudflare Workers Builds 會在每次推送
`main` 後建置前端、套用 D1 migrations，再部署 Worker 與前端資產。

### 現有 Cloudflare 資源

正式環境目前使用：

1. 沿用 R2 bucket：`cdn`；確認 `cdn.jwander.net` Custom Domain 為 active，且不修改現有物件。
2. D1 database：`jwander-temp-storage-db`；binding 與 UUID 已寫入 `wrangler.jsonc`。
3. Turnstile widget：正式 hostname 為 `upload.jwander.net`；site key 已寫入公開設定，secret
   只保存在 Worker runtime secrets。

若要在另一個 Cloudflare 帳號重建環境，再於 [`wrangler.jsonc`](./wrangler.jsonc)：

1. 將 `database_id` 換成新 D1 UUID。
2. 將 `TURNSTILE_SITE_KEY` 換成新 Turnstile site key；site key 可以提交 Git。
3. 確認 Worker 只宣告 `upload.jwander.net` Custom Domain；`cdn.jwander.net` 繼續由既有
   `cdn` R2 bucket 提供，不由 Worker 接管。

新暫存物件固定寫入 `temp-storage/objects/`，cleanup、reconciliation 與 Lifecycle 也只處理
這個 prefix，不會掃描或刪除 `cdn` bucket 的既有其他物件。D1 應先建立並將 UUID 寫回
repository，避免 Git 部署產生無法追蹤的新資源。

### 推送至 GitHub

本專案的 `.gitignore` 已排除 secrets、套件、建置結果與本機 Cloudflare 狀態。請勿強制
加入 `.dev.vars`、`.env`、`node_modules`、`dist` 或 `.wrangler`。

目前 remote 已設定為 `https://github.com/Jwander0820/temp-storage.git`。日常更新只需確認
變更、建立 commit，再推送 `main`：

```powershell
git status
git push origin main
```

### 連接 Workers Builds

GitHub repository 已完成連接。若日後需要重新連接或檢查設定，在 Cloudflare Dashboard：

1. 進入 **Workers & Pages → jwander-temp-storage → Settings → Builds**。
2. 選擇 **Connect**，連接 GitHub repository `Jwander0820/temp-storage`。
3. Production branch 設為 `main`。
4. Root directory 設為 `/`。
5. Build command 設為 `pnpm run build:client`。
6. Deploy command 設為 `pnpm run deploy:cloudflare`。

既有 Worker 名稱必須與 [`wrangler.jsonc`](./wrangler.jsonc) 的 `name` 相同；本專案兩者皆為
`jwander-temp-storage`。連接完成後，每次推送 `main` 都會觸發正式 build 與 deployment。

`deploy:cloudflare` 會先以 `DB` binding 套用正式 migrations，再部署 Worker。Workers Builds
使用的 API token 必須包含 Workers Scripts、D1、R2 與 Workers Routes 的 Edit 權限；若
自動建立的 token 缺少 D1 權限，請在 Build settings 改用具有 D1 Edit 的自訂 token。

正式 Worker 必須在 **Settings → Variables & Secrets** 保留以下 runtime secrets；建立新環境
時需重新加入，GitHub 連線不會替你複製這些值：

```text
TURNSTILE_SECRET_KEY
DELETE_TOKEN_PEPPER
IP_HASH_PEPPER
ADMIN_TOKEN
```

`UPLOAD_ACCESS_CODE` 是可選的第二道私人上傳碼。邀請 session 永遠是必要條件；設定這個
secret 後，持有邀請連結的人仍須在兌換 session 時另外輸入上傳碼。這些值只放
Cloudflare，不放 GitHub Builds variables，也不可提交 repository。設定完成後重新執行
一次 deployment。

### 非秘密執行參數

正式預設值集中在 [`wrangler.jsonc`](./wrangler.jsonc) 的 `vars`。本機開發可以在
`.dev.vars` 或 `.env` 使用相同名稱覆寫；`.dev.vars.example` 已列出完整範例。

| 類別                      | 變數                                                                                           |          預設值 |
| ------------------------- | ---------------------------------------------------------------------------------------------- | --------------: |
| 全站容量                  | `MAX_STORAGE_BYTES`                                                                            |           3 GiB |
| 單檔上限                  | `MAX_FILE_BYTES`                                                                               |          50 MiB |
| 檔案保存                  | `FILE_RETENTION_SECONDS`                                                                       |           90 天 |
| reservation 到期          | `RESERVATION_TTL_SECONDS`                                                                      |         15 分鐘 |
| IP reservation 視窗／次數 | `UPLOAD_RESERVATION_WINDOW_SECONDS` / `UPLOAD_RESERVATION_LIMIT`                               |  10 分鐘／10 次 |
| IP 短期流量               | `UPLOAD_HOURLY_WINDOW_SECONDS` / `UPLOAD_HOURLY_BYTES`                                         | 1 小時／100 MiB |
| IP 長期流量               | `UPLOAD_DAILY_WINDOW_SECONDS` / `UPLOAD_DAILY_BYTES`                                           |   1 天／300 MiB |
| 邀請最短／預設／最長期限  | `INVITATION_MIN_TTL_SECONDS` / `INVITATION_DEFAULT_TTL_SECONDS` / `INVITATION_MAX_TTL_SECONDS` |    1／7／365 天 |
| 邀請預設／最多檔案        | `INVITATION_DEFAULT_MAX_FILES` / `INVITATION_MAX_FILES`                                        |         10／100 |
| 邀請預設容量              | `INVITATION_DEFAULT_MAX_BYTES`                                                                 |         300 MiB |
| 上傳 session              | `UPLOAD_SESSION_TTL_SECONDS`                                                                   |         12 小時 |
| 管理 session              | `ADMIN_SESSION_TTL_SECONDS`                                                                    |          4 小時 |
| 前端單批／並行            | `CLIENT_MAX_FILES_PER_BATCH` / `CLIENT_MAX_PARALLEL_UPLOADS`                                   |           10／2 |
| 公開預覽快取              | `MEDIA_PREVIEW_CACHE_SECONDS`                                                                  |          1 小時 |
| 公開設定快取              | `PUBLIC_CONFIG_CACHE_SECONDS`                                                                  |          1 分鐘 |
| 每次清理批次              | `CLEANUP_BATCH_LIMIT`                                                                          |          100 筆 |
| 已刪 metadata 保留        | `DELETED_METADATA_RETENTION_SECONDS`                                                           |            7 天 |
| 對帳 metadata／R2 批次    | `RECONCILE_METADATA_LIMIT` / `RECONCILE_OBJECT_LIMIT`                                          |   500／1,000 筆 |
| R2 orphan 安全等待        | `RECONCILE_ORPHAN_GRACE_SECONDS`                                                               |          1 小時 |

Worker 啟動時會驗證設定關係，例如邀請必須符合 `min <= default <= max`、單檔上限不可
超過小時／每日流量上限、每日視窗不可超過 24 小時。錯誤設定會 fail closed 回傳 500，
不會默默退回硬編碼值。

最後到 `cdn` R2 bucket 的 **Settings → Object Lifecycle Rules**，只為
`temp-storage/objects/` prefix 新增 90 天 expiration rule。這是一次性設定，不應在每次
Git 部署時重複建立。

## 重建 Cloudflare resources

以下命令只用於建立新環境或修復資源；目前正式的 D1、R2、Turnstile 與 Custom Domain
都已存在，日常 GitHub 部署不需要重跑資源建立命令。

先登入：

```powershell
pnpm exec wrangler login
```

確認既有 R2 bucket；只有新環境才建立 D1：

```powershell
pnpm run cf:r2:info
pnpm run cf:d1:create
```

`cf:d1:create` 會輸出 database UUID。新環境需將 [`wrangler.jsonc`](./wrangler.jsonc) 的
`database_id` 換成該 UUID；正式環境目前已完成。

套用正式環境 migrations：

```powershell
pnpm run db:migrate:remote
```

建立 R2 Lifecycle Rule 並確認：

```powershell
pnpm run cf:lifecycle:add
pnpm run cf:lifecycle:list
```

該規則只處理 `temp-storage/objects/`，物件滿 90 天後到期，不會影響 `cdn` bucket 其他
路徑。Lifecycle 並非精確排程器，也不會同步 D1 帳本，因此 Cron 仍是主要清理機制。

目前 Wrangler 的 `r2 object get`、`put`、`delete` 預設操作本機模擬 bucket。若要手動
處理正式 `cdn` bucket，必須明確加上 `--remote`，並在輸出中確認
`Resource location: remote`；不得只憑 `Delete complete` 判定正式物件已刪除。

## Secrets 與 Turnstile

依序輸入正式值：

```powershell
pnpm run cf:secret:turnstile
pnpm run cf:secret:delete-pepper
pnpm run cf:secret:ip-pepper
pnpm run cf:secret:admin
```

其中：

- `TURNSTILE_SECRET_KEY`：Turnstile widget 的 secret key。
- `DELETE_TOKEN_PEPPER`：至少 32 bytes 的隨機 secret。
- `IP_HASH_PEPPER`：至少 32 bytes 的隨機 secret。
- `ADMIN_TOKEN`：至少 32 bytes 的隨機 Bearer token。

若要在邀請 session 之外再疊加一組短期共用上傳碼，設定：

```powershell
pnpm exec wrangler secret put UPLOAD_ACCESS_CODE
```

接著把 [`wrangler.jsonc`](./wrangler.jsonc) 的 `TURNSTILE_SITE_KEY` 換成公開 site key。
site key 可以公開；secret key 不可寫入 repository 或前端。

## 本機開發

複製開發 secrets：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

填入 `.dev.vars` 後執行：

```powershell
pnpm run db:migrate:local
pnpm dev
```

Wrangler 提供 Worker、D1 與 R2 local environment；Vite watch 會持續重建
`dist/client`，管理頁位於 `http://localhost:8976/admin`。本機固定使用 8976，避開部分
Windows/Hyper-V 會保留的 8787 port range；`--local-upstream localhost` 也避免正式 custom
domain route 讓本機 hostname boundary 誤判。本機 Turnstile 請使用 Cloudflare 提供的測試
widget key 與對應測試 secret，並保留 `.dev.vars` 的 `TURNSTILE_TEST_MODE=true`。此模式只在
secret 完全符合官方 always-pass dummy secret 時生效；不要把正式 secret 放入版本控制。

若 `.dev.vars` 存在，Wrangler 會優先使用它；若不用 `.dev.vars`，也可以直接在 `.env`
放入同名非秘密參數作為本機覆寫。兩者都已被 Git 忽略。

可用 `--test-scheduled` 暴露的 Wrangler scheduled endpoint 測試 Cron；正式環境由
`0 * * * *` 每小時觸發。

## 驗證

完整檢查：

```powershell
pnpm check
```

個別執行：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

測試使用目前的 `@cloudflare/vitest-pool-workers`、真實 D1 migrations 與 local R2
binding，涵蓋配額邊界、檔案政策、串流上傳、Range/HEAD、刪除、到期清理與
reconciliation。

## 部署

推薦流程是提交並 push 到 `main`，交由 Workers Builds 自動套用 migrations 與部署。下方
`pnpm run deploy:cloudflare` 是需要跳過 GitHub 自動部署時的手動備援，不要在同一次更新
同時使用兩種方式重複部署。

確認以下項目後部署：

1. D1 UUID 已寫入 `wrangler.jsonc`。
2. Turnstile site key 已更新。
3. 四個必要 secrets 與可選的 `UPLOAD_ACCESS_CODE` 已設定。
4. D1 migrations 已套用。
5. R2 Lifecycle Rule 已建立。
6. `cdn` R2 bucket 的 `cdn.jwander.net` Custom Domain 仍為 active，且 `r2.dev` 關閉。
7. Workers plan 維持 Free，並確認超額行為為 fail closed。
8. Worker 只綁定 `upload.jwander.net`；不得接管或移除既有的 `cdn.jwander.net` R2
   Custom Domain。
9. 先依下方「邊緣成本護欄」建立 WAF／rate limiting 規則並觀察 Log。

```powershell
pnpm run deploy:cloudflare
```

`wrangler.jsonc` 只宣告一個 Worker Custom Domain：

- `upload.jwander.net`：公開邀請頁、邀請交換、受 session 保護的上傳 API 與管理 API。

`cdn.jwander.net` 維持既有 `cdn` R2 Custom Domain。Worker 上傳後只會為 inline 白名單
媒體回傳 `https://cdn.jwander.net/temp-storage/objects/...`；受控下載則使用
`https://upload.jwander.net/d/:id`。Static Assets 設為 `run_worker_first: true`，確保只有
`upload.jwander.net` 能取得前端與 Worker API。

首次部署時 Wrangler 只會為 `upload.jwander.net` Worker Custom Domain 建立 DNS 與憑證，
不應修改 `cdn.jwander.net`。部署後確認：

```text
GET https://upload.jwander.net/api/health
GET https://upload.jwander.net/api/config
```

健康檢查應回傳：

```json
{ "status": "ok" }
```

`GET /api/storage` 現在必須帶有效邀請 session，避免匿名爬蟲把每個容量查詢轉成 D1
讀取。請在完成邀請交換後由瀏覽器 UI 驗證，不再把它當匿名健康檢查。

## API

公開或以 URL capability／刪除 token 存取：

```text
GET    /api/health
GET    /api/config
POST   /api/invitations/exchange  body: { token, turnstileToken, accessCode? }; sets HttpOnly session cookie
GET    /api/files/:fileId
DELETE /api/files/:fileId       Authorization: DeleteToken {token}
GET    /p/:fileId
HEAD   /p/:fileId
GET    /d/:fileId
HEAD   /d/:fileId
```

`/p/:fileId` 是 Worker 預覽 fallback；正常 inline 預覽 URL 直接使用
`cdn.jwander.net/temp-storage/objects/...`。`/d/:fileId` 永遠由 Worker 查 D1 狀態後串流下載。

邀請 session 保護：

```text
GET    /api/storage
GET    /api/invitations/session
DELETE /api/invitations/session
POST   /api/uploads/reserve
PUT    /api/uploads/:uploadId
```

管理 API 可使用 `Authorization: Bearer {ADMIN_TOKEN}`，或先在 `/admin` 以管理 token 與
Turnstile 換取短效 HttpOnly admin session：

```text
POST   /api/admin/session
GET    /api/admin/session
DELETE /api/admin/session
GET    /api/admin/status
GET    /api/admin/files
POST   /api/admin/invitations
GET    /api/admin/invitations
DELETE /api/admin/invitations/:invitationId
POST   /api/admin/cleanup
POST   /api/admin/reconcile
DELETE /api/admin/files/:fileId
```

`/admin` 是桌面與手機共用的響應式管理頁，可建立、複製、顯示 QR Code、列出與撤銷邀請。
QR Code 完全在瀏覽器內產生，不會把邀請 token 傳給第三方服務。永久 `ADMIN_TOKEN` 只用於
建立 admin session，不寫入 localStorage、sessionStorage 或前端 cookie；後續管理請求只帶
HttpOnly session cookie。CLI 與自動化工具仍可直接使用 Bearer token。

`GET /api/admin/files` 支援 `status`、`mime`、`createdBefore`、`createdAfter`、
`expiresBefore`、`cursor` 與最大 100 的 `limit`。

### 建立與撤銷邀請

每個邀請都有獨立到期時間、檔案數與總容量限制。建立 API 只回傳一次明文 token；D1
只保存 peppered hash。先將部署時使用的 `ADMIN_TOKEN` 放入目前的終端機環境變數：

```bat
set ADMIN_TOKEN=你的管理Token
```

PowerShell 使用：

```powershell
$env:ADMIN_TOKEN = "你的管理Token"
```

接著執行本機邀請指令。未指定限制時，期限、檔案數與容量由 Worker 的
`INVITATION_DEFAULT_*` 設定決定；目前預設為 7 天、10 個檔案、300 MiB。邀請可設定
1 至 365 天，長期邀請仍受獨立檔案數／容量限制，且可隨時撤銷：

```powershell
pnpm invite:create
pnpm invite:create --label "upload" --days 7 --files 10 --mb 300
pnpm invite:create:year -- --label "long-term" --files 10 --mb 300
```

Windows CMD 也可以直接執行根目錄的批次檔：

```bat
invite-create.cmd
invite-create.cmd --label "upload" --days 7 --files 10 --mb 300
invite-create-year.cmd --label "long-term" --files 10 --mb 300
```

若不想每次設定環境變數，可在專案根目錄建立已被 Git 忽略的 `.env`：

```dotenv
ADMIN_TOKEN=你的管理Token
```

邀請腳本依序使用目前程序的 `ADMIN_TOKEN`、`.env.local`、`.env`、`.dev.vars`，且不會顯示
管理 token 的內容。

建立成功後，指令會顯示邀請 ID、到期時間與 `inviteUrl`，並在 Windows 自動將網址複製
到剪貼簿。`ADMIN_TOKEN` 只從環境變數讀取，不應寫入 repository。

手機或電腦可改用 `/admin` 管理頁建立邀請。勾選「不限檔案數」時，只取消該邀請的
檔案 reservation 數量上限；總容量仍須設定，且每 IP、每小時、每日與全站容量限制仍會
照常執行。

也可以直接呼叫管理 API：

```powershell
$headers = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
$body = @{
  label = "朋友 A"
  expiresInSeconds = 604800
  maxFiles = 10
  maxBytes = 314572800
} | ConvertTo-Json

$invitation = Invoke-RestMethod `
  -Method Post `
  -Uri "https://upload.jwander.net/api/admin/invitations" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body

$invitation.inviteUrl
```

邀請 URL 使用 `/invite#token=...`。fragment 不會隨初始 HTTP request 傳到伺服器；前端
完成一次 Turnstile（以及選用的 `UPLOAD_ACCESS_CODE`）後，以
`POST /api/invitations/exchange` 交換成預設最多 12 小時的 `HttpOnly; Secure;
SameSite=Strict` session，隨後立即從網址列移除 token。session 有效期間，每個檔案不再
重複執行 Turnstile；上傳 API 只驗證 session、邀請期限與配額。

列出與撤銷：

```powershell
Invoke-RestMethod `
  -Uri "https://upload.jwander.net/api/admin/invitations" `
  -Headers $headers

Invoke-RestMethod `
  -Method Delete `
  -Uri "https://upload.jwander.net/api/admin/invitations/<invitation-id>" `
  -Headers $headers
```

撤銷邀請會同步撤銷該邀請建立的所有 session。NFC 或 QR Code 應保存 `inviteUrl`，而非
管理員 token 或任何 Cloudflare secret。

## 安全設計

- 瀏覽器單次選取、拖放、貼上與並行數由 `CLIENT_MAX_*` 控制；這是操作介面限制，不作為
  安全邊界。
- reservation 使用 D1 conditional update 與 batch，不以先讀後寫方式計算配額。
- 檔案 ID 為 128-bit cryptographically secure random base64url。
- delete token 為 256-bit random，D1 只保存 peppered SHA-256 hash。
- invitation token 與 session token 都是 256-bit random；D1 只保存帶 domain separation
  的 peppered SHA-256 hash。
- admin session token 也是 256-bit random，D1 只保存 domain-separated peppered hash；
  永久管理 token 不會由管理頁保存於瀏覽器儲存空間。
- 每個邀請可獨立限制有效期、檔案數、總 bytes 並撤銷；所有 `/api/uploads/*` 都要求
  session，且 raw PUT 必須與建立 reservation 的邀請相同。
- Turnstile Siteverify 在兌換 session 時比對 `hostname=upload.jwander.net` 與
  `action=invite`；Turnstile 只負責防止自動化兌換，不取代邀請授權。
- `UPLOAD_ACCESS_CODE` 若設定，會在兌換 invitation session 時驗證一次。
- Worker 會在 Static Assets 前檢查 hostname，只接受 `upload.jwander.net`；CDN hostname
  由 R2 Custom Domain 處理，不進入 Worker。
- uploader rate limit 只保存每日輪替的 peppered IP hash，不保存原始 IP。
- Worker 端另限制同一 IP 每 10 分鐘最多 10 次 reservation、每小時 100 MiB、每日
  300 MiB；數值由 `UPLOAD_*` 設定提供。每個邀請與全站容量也會在寫入 R2 前於 D1
  交易中檢查。
- `/api/storage` 要求邀請 session；無效檔案 ID 會在查詢 D1 前拒絕。
- 只有 inline 白名單媒體的 R2 metadata 使用公開快取；Worker 下載、Range、session、
  檔案資訊與容量回應皆為 `private, no-store`。
- Worker 只緩衝最多 4096 bytes 進行 magic-byte detection；本體以 stream 寫入 R2。
- inline R2 object 只使用 Worker 偵測出的 MIME 與 `Content-Disposition: inline`；其他內容
  寫入 `attachment` metadata，且不回傳直接 CDN URL。
- 預覽與下載支援 HEAD、單一 byte Range、206 與 416。
- 所有錯誤都有 `requestId`；log 不記錄 token、secret、原始 IP 或 Authorization。

## 已知限制

- 第一版不做防毒、壓縮檔內容掃描、轉碼、影像最佳化與 multipart upload。
- 單次 request 仍受部署帳號當下的 Workers request body 上限約束；程式額外限制為
  50 MiB。
- reconciliation 每次預設檢查 500 筆 active metadata 與 1,000 個 R2 objects；數量由
  `RECONCILE_*` 設定，超過時由後續排程繼續處理。
- 公開預覽可能在 edge／browser cache 保留至 `MEDIA_PREVIEW_CACHE_SECONDS` 到期；若刪除
  後必須立即不可讀，應將此值設為 `0` 或很短的秒數。
- `cdn` 是共用既有 bucket；D1 的 3 GiB 上限只計算 `temp-storage/objects/` namespace，
  不包含 bucket 其他既有物件。
- 邀請 URL 是 bearer capability；收件者轉傳、NFC 被複製或裝置遭入侵時，其他人也能在
  到期與配額內使用。請為不同對象建立不同邀請，並在不需要時撤銷。
- 使用者取消已送出的 request 時，Worker 會在寫入失敗流程釋放 reservation；若連線在
  reservation 後、PUT 前中斷，15 分鐘後由 Cron 回收。

## 邊緣成本護欄

程式內配額只能限制已通過邀請 session 的上傳，不能避免匿名攻擊先產生 Worker request。
正式重啟前，在 Cloudflare Security rules 建立 host-scoped WAF／rate limiting，先以 Log
觀察誤判，再改為 Block 或 Managed Challenge：

- `upload.jwander.net/api/invitations/exchange`：依 IP 限制短時間 POST 嘗試。
- `upload.jwander.net/api/uploads/reserve`：依 IP 限制 POST；門檻不得低於正常單批上傳。
- `upload.jwander.net/api/uploads/*`：限制異常大量 PUT。
- `upload.jwander.net/api/admin/*`：嚴格限制並保留 Bearer 驗證。
- `cdn.jwander.net/temp-storage/objects/*`：針對異常高頻 GET/HEAD；影音 Range 會產生
  多次正常請求，必須先看 Security Events 再定門檻，且不得影響 bucket 其他路徑。

另開啟 Bot Fight Mode、Workers／D1／R2 用量通知與低額 Budget Alert。Budget Alert 只是
隔日通知，不是斷路器；真正的硬上限仍以 Workers Free、3 GiB 容量、邀請配額與
`UPLOADS_ENABLED=false` 緊急停用為主。
