# Cloudflare 環境與部署

> 狀態：現行操作文件  
> 最後更新：2026-08-27  
> 用途：建立或維護 Cloudflare 資源、Workers Builds 與正式部署

日常部署優先透過 GitHub 與 Cloudflare Workers Builds 完成。只有重建環境、修復資源或自動部署無法使用時，才需要執行本文件中的手動命令。

## 正式環境

| 項目              | 現況                                                |
| ----------------- | --------------------------------------------------- |
| Production branch | `main`                                              |
| Worker            | `jwander-temp-storage`                              |
| 公開入口          | `https://upload.jwander.net`                        |
| R2                | `cdn` bucket，僅使用 `temp-storage/objects/` prefix |
| R2 Custom Domain  | `https://cdn.jwander.net`                           |
| D1                | `jwander-temp-storage-db`                           |
| Migration         | `0001`–`0007`                                       |
| Scheduled trigger | `0 * * * *`                                         |

`cdn.jwander.net` 由既有 R2 Custom Domain 提供，不由 Worker 接管。Worker 只宣告 `upload.jwander.net`，且所有 R2 清理與 reconciliation 都必須限制在 `temp-storage/objects/`。

## 推薦部署流程

1. 在功能分支完成驗證與 review。
2. 將核准的 commit 合併或推送至 `main`。
3. Cloudflare Workers Builds 執行 `pnpm run build:client`。
4. Deploy command 執行 `pnpm run deploy:cloudflare`，先套用 D1 migrations，再部署 Worker 與 Static Assets。
5. 在 **Workers & Pages → jwander-temp-storage → Deployments → Build history** 確認結果。

不要在同一次更新同時使用自動部署與本機手動部署，避免重複執行 migration 或產生難以追蹤的部署順序。

## Workers Builds 設定

若需要重新連接 GitHub：

1. 開啟 **Workers & Pages → jwander-temp-storage → Settings → Builds**。
2. 連接 repository `Jwander0820/temp-storage`。
3. Production branch 設為 `main`。
4. Root directory 設為 `/`。
5. Build command 設為 `pnpm run build:client`。
6. Deploy command 設為 `pnpm run deploy:cloudflare`。

Workers Builds 使用的 API token 必須具備 Workers Scripts、D1、R2 與 Workers Routes 的必要編輯權限。GitHub 連線不會複製 Worker runtime secrets。

## Cloudflare bindings

正式 binding 與非秘密設定都在 [`../../wrangler.jsonc`](../../wrangler.jsonc)：

- `ASSETS`：Vite 產生的 `dist/client`。
- `DB`：D1 `jwander-temp-storage-db`。
- `FILES`：R2 `cdn` bucket。
- `FILE_BROWSER_RATE_LIMITER`：共享檔案清單的 session 級限流。

在其他 Cloudflare 帳號重建時，必須更新 D1 `database_id`、Turnstile site key，並確認 Rate Limiting `namespace_id` 沒有和該帳號其他 binding 共用。

## Runtime secrets

正式 Worker 必須設定：

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

Secret 只能放在 Cloudflare runtime secrets 或本機 `.dev.vars`，不得寫入 GitHub Builds variables、repository、文件、log 或前端。

設定正式 secret：

```powershell
pnpm run cf:secret:turnstile
pnpm run cf:secret:delete-pepper
pnpm run cf:secret:ip-pepper
pnpm run cf:secret:admin
```

需要第二道共用存取碼時：

```powershell
pnpm exec wrangler secret put UPLOAD_ACCESS_CODE
```

## 建立新環境

下列命令不是日常部署流程，只在建立新環境時使用：

```powershell
pnpm exec wrangler login
pnpm run cf:r2:info
pnpm run cf:d1:create
pnpm run db:migrate:remote
pnpm run cf:lifecycle:add
pnpm run cf:lifecycle:list
```

`cf:d1:create` 會輸出新的 database UUID，必須寫回 `wrangler.jsonc`。R2 Lifecycle Rule 只對 `temp-storage/objects/` 設定 90 天 expiration；它是漏刪保險，不取代 Worker Cron，也不會同步 D1 帳本。

Wrangler 的 R2 object 命令可能預設操作本機模擬 bucket。任何正式 R2 操作都必須明確確認 remote resource；未取得使用者授權時不得加上 `--remote`。

## 手動備援部署

只有使用者明確要求跳過 GitHub 自動部署時才執行：

```powershell
pnpm run deploy:cloudflare
```

部署前確認：

- D1 UUID、Turnstile site key 與所有 bindings 正確。
- Runtime secrets 已設定。
- 新 migration 已完成驗證並可安全依序套用。
- `cdn.jwander.net` 仍由 R2 Custom Domain 提供，`r2.dev` 保持關閉。
- R2 Lifecycle Rule 只涵蓋 `temp-storage/objects/`。
- Worker route 只接管 `upload.jwander.net`。

## 部署後驗證

```text
GET https://upload.jwander.net/api/health
GET https://upload.jwander.net/api/config
```

Health 預期回傳：

```json
{ "status": "ok" }
```

`GET /api/storage` 需要有效 invitation session，不是匿名健康檢查。部署後仍應透過瀏覽器驗證邀請交換、檔案清單、上傳或僅瀏覽權限、預覽、下載與管理頁。

## 邊緣防護與成本護欄

應在 Cloudflare Security rules 針對下列路徑建立 host-scoped WAF 或 Rate Limiting 規則，先以 Log 觀察，再決定 Block 或 Managed Challenge：

- `upload.jwander.net/api/invitations/exchange`
- `upload.jwander.net/api/uploads/reserve`
- `upload.jwander.net/api/uploads/*`
- `upload.jwander.net/api/admin/*`
- `cdn.jwander.net/temp-storage/objects/*`

影音 Range request 會產生多次正常請求，CDN 規則必須依 Security Events 調整，且不得影響同 bucket 其他 prefix。另建議開啟用量通知與低額 Budget Alert；通知不是硬性斷路器，緊急時以邀請撤銷、配額與 `UPLOADS_ENABLED=false` 控制風險。
