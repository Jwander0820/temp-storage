# Jwander 暫存區

部署於 Cloudflare 的私人預設暫存檔案服務。前端由 Worker Static Assets 提供，Worker
負責驗證、配額、上傳、預覽、下載、刪除與排程；檔案本體放在 private R2，metadata
與容量帳本放在 D1。

## 服務限制

- 全站容量：3 GiB。
- 單檔上限：50 MiB。
- 保存期限：30 天。
- 同時上傳：瀏覽器最多 2 個。
- 主要清理：每小時 Worker Cron。
- 漏刪保險：R2 `objects/` prefix 的 30 天 Lifecycle Rule。
- 預覽白名單：JPEG、PNG、WebP、GIF、AVIF、MP4、WebM、常見音訊。
- PDF、壓縮檔、執行檔、Office 文件與未知 binary 只能下載。
- HTML、XHTML、SVG、JavaScript、CSS、XML、XSLT、WASM、SWF 會被拒絕。

R2 bucket 不可開啟 Public Development URL 或 Public Bucket；公開內容只能經過
`/p/:id` 與 `/d/:id` Worker 路由取得。

## 架構

```text
Browser
  ├─ invitation URL fragment + Turnstile ── exchange ── short-lived HttpOnly session
  ├─ Static Assets ─────────────── upload.jwander.net only
  ├─ reserve / raw PUT ────────── session + invitation quota
  └─ preview / download ───────── cdn.jwander.net GET/HEAD ── private R2 stream

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

### Cloudflare 前置資源

先在 Cloudflare Dashboard 建立：

1. R2 bucket：`jwander-temp-storage`，保持 private。
2. D1 database：`jwander-temp-storage-db`，複製其 UUID。
3. Turnstile widget：只允許 `upload.jwander.net`，記下 site key 與 secret key。

接著在 [`wrangler.jsonc`](./wrangler.jsonc)：

1. 將 `database_id` 的全零 placeholder 換成 D1 UUID。
2. 將 `TURNSTILE_SITE_KEY` 換成 Turnstile site key；site key 可以提交 Git。

雖然 Wrangler 支援在部署時自動建立 R2 與 D1，但 Git 部署不會把產生的 resource ID
寫回 repository，且本專案還要設定固定 bucket 名稱與 Lifecycle，因此建議先在 Dashboard
建立並明確綁定。

### 推送至 GitHub

本專案的 `.gitignore` 已排除 secrets、套件、建置結果與本機 Cloudflare 狀態。請勿強制
加入 `.dev.vars`、`.env`、`node_modules`、`dist` 或 `.wrangler`。

建立 GitHub private repository 後，在本機只需要設定 remote 並推送：

```powershell
git remote add origin https://github.com/<你的帳號>/<repository>.git
git push -u origin main
```

### 連接 Workers Builds

在 Cloudflare Dashboard：

1. 進入 **Workers & Pages → Create application → Import a repository**。
2. 選擇剛才建立的 GitHub repository。
3. Worker 名稱使用 `jwander-temp-storage`。
4. Production branch 設為 `main`。
5. Root directory 設為 `/`。
6. Build command 設為 `pnpm run build:client`。
7. Deploy command 設為 `pnpm run deploy:cloudflare`。

`deploy:cloudflare` 會先以 `DB` binding 套用正式 migrations，再部署 Worker。Workers Builds
使用的 API token 必須包含 Workers Scripts、D1、R2 與 Workers Routes 的 Edit 權限；若
自動建立的 token 缺少 D1 權限，請在 Build settings 改用具有 D1 Edit 的自訂 token。

首次 Worker 建立後，到 **Settings → Variables & Secrets** 加入以下 runtime secrets：

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

最後到 R2 bucket 的 **Settings → Object Lifecycle Rules**，為 `objects/` prefix 新增 30
天 expiration rule。這是一次性設定，不應在每次 Git 部署時重複建立。

## 建立 Cloudflare resources

先登入：

```powershell
pnpm exec wrangler login
```

建立 private R2 bucket 與 D1：

```powershell
pnpm run cf:r2:create
pnpm run cf:d1:create
```

`cf:d1:create` 會輸出 database UUID。將
[`wrangler.jsonc`](./wrangler.jsonc) 中的
`00000000-0000-0000-0000-000000000000` 換成該 UUID。

套用正式環境 migrations：

```powershell
pnpm run db:migrate:remote
```

建立 R2 Lifecycle Rule 並確認：

```powershell
pnpm run cf:lifecycle:add
pnpm run cf:lifecycle:list
```

該規則只處理 `objects/`，物件滿 30 天後到期。Lifecycle 並非精確排程器，也不會同步
D1 帳本，因此 Cron 仍是主要清理機制。

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
`dist/client`。本機 Turnstile 請使用 Cloudflare 提供的測試 widget key 與對應測試
secret，不要把正式 secret 放入版本控制。

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

確認以下項目後部署：

1. D1 UUID 已寫入 `wrangler.jsonc`。
2. Turnstile site key 已更新。
3. 四個必要 secrets 與可選的 `UPLOAD_ACCESS_CODE` 已設定。
4. D1 migrations 已套用。
5. R2 Lifecycle Rule 已建立。
6. R2 bucket 仍為 private。

```powershell
pnpm deploy
```

`wrangler.jsonc` 已宣告兩個 Custom Domains：

- `upload.jwander.net`：公開邀請頁、邀請交換、受 session 保護的上傳 API 與管理 API。
- `cdn.jwander.net`：只接受 `/p/:id`、`/d/:id` 的 `GET`/`HEAD`；其他路徑一律 404。

Static Assets 設為 `run_worker_first: true`，確保 `cdn.jwander.net` 的首頁或前端資產不會
繞過 Worker 的 hostname 邊界直接由資產層送出。

首次部署時 Wrangler 會為 Custom Domain 建立或接管所需 DNS 設定。部署後確認：

```text
GET https://upload.jwander.net/api/health
GET https://upload.jwander.net/api/storage
```

健康檢查應回傳：

```json
{ "status": "ok" }
```

## API

公開：

```text
GET    /api/health
GET    /api/config
GET    /api/storage
POST   /api/invitations/exchange  body: { token, turnstileToken, accessCode? }; sets HttpOnly session cookie
GET    /api/invitations/session   requires invitation session cookie
DELETE /api/invitations/session   revokes current session
POST   /api/uploads/reserve       requires invitation session
PUT    /api/uploads/:uploadId     requires the same invitation session
GET    /api/files/:fileId
DELETE /api/files/:fileId       Authorization: DeleteToken {token}
GET    /p/:fileId
HEAD   /p/:fileId
GET    /d/:fileId
HEAD   /d/:fileId
```

管理 API 使用 `Authorization: Bearer {ADMIN_TOKEN}`：

```text
GET    /api/admin/status
GET    /api/admin/files
POST   /api/admin/invitations
GET    /api/admin/invitations
DELETE /api/admin/invitations/:invitationId
POST   /api/admin/cleanup
POST   /api/admin/reconcile
DELETE /api/admin/files/:fileId
```

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

接著執行本機邀請指令。未指定選項時預設名稱為 `upload`、有效 7 天、最多 10 個檔案、
總計 300 MiB：

```powershell
pnpm invite:create
pnpm invite:create --label "upload" --days 7 --files 10 --mb 300
```

Windows CMD 也可以直接執行根目錄的批次檔：

```bat
invite-create.cmd
invite-create.cmd --label "upload" --days 7 --files 10 --mb 300
```

若不想每次設定環境變數，可在專案根目錄建立已被 Git 忽略的 `.env`：

```dotenv
ADMIN_TOKEN=你的管理Token
```

邀請腳本依序使用目前程序的 `ADMIN_TOKEN`、`.env.local`、`.env`、`.dev.vars`，且不會顯示
管理 token 的內容。

建立成功後，指令會顯示邀請 ID、到期時間與 `inviteUrl`，並在 Windows 自動將網址複製
到剪貼簿。`ADMIN_TOKEN` 只從環境變數讀取，不應寫入 repository。

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
`POST /api/invitations/exchange` 交換成最多 12 小時的 `HttpOnly; Secure;
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

- reservation 使用 D1 conditional update 與 batch，不以先讀後寫方式計算配額。
- 檔案 ID 為 128-bit cryptographically secure random base64url。
- delete token 為 256-bit random，D1 只保存 peppered SHA-256 hash。
- invitation token 與 session token 都是 256-bit random；D1 只保存帶 domain separation
  的 peppered SHA-256 hash。
- 每個邀請可獨立限制有效期、檔案數、總 bytes 並撤銷；所有 `/api/uploads/*` 都要求
  session，且 raw PUT 必須與建立 reservation 的邀請相同。
- Turnstile Siteverify 在兌換 session 時比對 `hostname=upload.jwander.net` 與
  `action=invite`；Turnstile 只負責防止自動化兌換，不取代邀請授權。
- `UPLOAD_ACCESS_CODE` 若設定，會在兌換 invitation session 時驗證一次。
- Worker 會在 Static Assets 前檢查 hostname；CDN hostname 只能讀取公開媒體路徑。
- uploader rate limit 只保存每日輪替的 peppered IP hash，不保存原始 IP。
- Worker 只緩衝最多 4096 bytes 進行 magic-byte detection；本體以 stream 寫入 R2。
- inline response 只使用 Worker 偵測出的 MIME；其他內容強制 attachment。
- 預覽與下載支援 HEAD、單一 byte Range、206 與 416。
- 所有錯誤都有 `requestId`；log 不記錄 token、secret、原始 IP 或 Authorization。

## 已知限制

- 第一版不做防毒、壓縮檔內容掃描、轉碼、影像最佳化與 multipart upload。
- 單次 request 仍受部署帳號當下的 Workers request body 上限約束；程式額外限制為
  50 MiB。
- reconciliation 每次最多檢查 500 筆 active metadata 與 1,000 個 R2 objects；超過時
  由後續每日執行繼續處理。
- 邀請 URL 是 bearer capability；收件者轉傳、NFC 被複製或裝置遭入侵時，其他人也能在
  到期與配額內使用。請為不同對象建立不同邀請，並在不需要時撤銷。
- 使用者取消已送出的 request 時，Worker 會在寫入失敗流程釋放 reservation；若連線在
  reservation 後、PUT 前中斷，15 分鐘後由 Cron 回收。
