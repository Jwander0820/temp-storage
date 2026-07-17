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
  ├─ Static Assets ─────────────── upload.jwander.net
  ├─ reserve / raw PUT ────────── Worker ── D1 quota + metadata
  ├─ preview / download ───────── Worker ── private R2 stream
  └─ Turnstile ────────────────── Worker server-side Siteverify

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
3. Turnstile widget：允許 `upload.jwander.net`，記下 site key 與 secret key。

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

`UPLOAD_ACCESS_CODE` 是可選的私人上傳碼。這些值只放 Cloudflare，不放 GitHub Builds
variables，也不可提交 repository。設定完成後重新執行一次 deployment。

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

若要限制只有持有分享碼的人能建立 reservation，再設定：

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
3. 五個 secrets（含可選的 `UPLOAD_ACCESS_CODE`）已設定。
4. D1 migrations 已套用。
5. R2 Lifecycle Rule 已建立。
6. R2 bucket 仍為 private。

```powershell
pnpm deploy
```

`wrangler.jsonc` 已宣告兩個 Custom Domains：

- `upload.jwander.net`：UI、API、下載與管理 API。
- `cdn.jwander.net`：媒體預覽；仍由同一 Worker 驗證 D1 policy 後讀取 R2。

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
POST   /api/uploads/reserve
PUT    /api/uploads/:uploadId
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
POST   /api/admin/cleanup
POST   /api/admin/reconcile
DELETE /api/admin/files/:fileId
```

`GET /api/admin/files` 支援 `status`、`mime`、`createdBefore`、`createdAfter`、
`expiresBefore`、`cursor` 與最大 100 的 `limit`。

## 安全設計

- reservation 使用 D1 conditional update 與 batch，不以先讀後寫方式計算配額。
- 檔案 ID 為 128-bit cryptographically secure random base64url。
- delete token 為 256-bit random，D1 只保存 peppered SHA-256 hash。
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
- `cdn.jwander.net` 是同一 Worker 的 Custom Domain，因此其他路徑也會到達 Worker；
  服務沒有公開 listing，媒體本體仍須通過 D1 policy。
- 使用者取消已送出的 request 時，Worker 會在寫入失敗流程釋放 reservation；若連線在
  reservation 後、PUT 前中斷，15 分鐘後由 Cron 回收。
