# Cloudflare 環境與部署

> 狀態：現行操作文件  
> 最後更新：2026-08-28
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
| Migration files   | `0001`–`0009`                                       |
| 正式 migration    | `0009` 尚待正式套用與排程驗收                       |
| Scheduled trigger | `0 * * * *`                                         |
| Cloudflare Access | Admin paths 已設定，仍需完成部署後驗證              |
| CDN 邊緣防護      | 文件已完成，Dashboard 規則尚待設定與驗證            |

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
- `ADMIN_LOGIN_RATE_LIMITER`：`POST /api/admin/session` 的獨立 IP 級限流，預設每分鐘 5 次；不得與檔案瀏覽 binding 共用 namespace。

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

`ADMIN_TOKEN` 必須是 43–512 個 URL-safe 字元（`A-Z`、`a-z`、`0-9`、`_`、`-`）。建議直接產生 32 bytes 隨機材料，而不是自行設計密碼：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

公開 repository 前應輪替一次正式 `ADMIN_TOKEN`。Worker 會在處理請求前驗證 token 格式，缺少或強度格式不足時 fail closed。

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

## Cloudflare Access（手動設定）

程式部署並驗證後，再由 Cloudflare Zero Trust 建立 self-hosted Access application，只保護：

```text
upload.jwander.net/admin
upload.jwander.net/admin/*
upload.jwander.net/api/admin/*
```

`/admin` 與 `/admin/*` 必須分別列出。Allow policy 只加入管理員身分，初始 Access session 可設為 24 小時。不得保護 `/`、`/invite`、`/files`、`/file/*`、檔案傳輸路由或 `/api/session/capabilities`，以免一般受邀使用者被迫登入 Access。

Access 不由 Worker 程式模擬；本機只驗證 Turnstile、`ADMIN_TOKEN` 與 4 小時 admin session。正式環境的管理邊界為 Access + bootstrap token + admin session。

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
- `ADMIN_LOGIN_RATE_LIMITER` binding 已部署，且 namespace 未與其他 limiter 共用。
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

啟用 Access 後另以無痕視窗確認：

- `/`、`/invite`、`/files`、`/file/:id` 與 `/api/session/capabilities` 不出現 Access 登入。
- `/admin` 先通過 Access，再顯示管理 token gate。
- 沒有 Access 時 `/api/admin/status` 在 Worker 前被阻擋。
- 正確 `ADMIN_TOKEN` 直接放在其他 Admin API 的 Bearer header 仍回覆 401。

## ADMIN_TOKEN 疑似外洩

1. 輪替 Cloudflare Worker secret `ADMIN_TOKEN`。
2. 通過 Cloudflare Access，以新 token 建立 admin session。
3. 在管理頁執行「登出所有管理裝置」。
4. 檢查邀請狀態、檔案刪除與其他管理操作。
5. 檢查 Cloudflare／Worker logs；不得複製或輸出 Authorization、Cookie、Turnstile token 或 Access cookie。

## 邊緣防護與成本護欄

完整免費額度、每操作估算、denial-of-wallet 情境與每月檢查表見
[`../reference/cloudflare-free-tier-and-cost.md`](../reference/cloudflare-free-tier-and-cost.md)。
可直接照著 Dashboard 操作的 CDN WAF、Cache、Rate Limiting、Budget Alert 與驗證步驟見
[`cloudflare-edge-protection.md`](./cloudflare-edge-protection.md)。
帳單或用量異常時的 CDN／Worker WAF Block、R2 Custom Domain 暫停與恢復順序見
[`cloudflare-cost-incident-response.md`](./cloudflare-cost-incident-response.md)。

應先用 Security Analytics 觀察正常流量，再在 Cloudflare Security rules 針對下列路徑建立
host-scoped WAF Custom Rules。Free plan 的 Custom Rule 不提供 Log action，且唯一一條 Rate Limiting Rule
只能使用 Path／Verified Bot、IP 與 10 秒週期，不能直接套用下列所有 Host／Method 條件：

- `upload.jwander.net/api/invitations/exchange`
- `upload.jwander.net/api/uploads/reserve`
- `upload.jwander.net/api/uploads/*`
- `upload.jwander.net/api/admin/*`
- `cdn.jwander.net/temp-storage/objects/*`

影音 Range request 會產生多次正常請求，CDN 規則必須依 Security Events 調整，且不得影響同 bucket
其他 prefix。另建議開啟低額 Budget Alert；通知不是硬性斷路器，`UPLOADS_ENABLED=false` 也只停止新
reservation。真正緊急止血應依 runbook 使用 WAF Block，必要時 Disable R2 Custom Domain。
