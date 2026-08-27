<p align="center">
  <img src="./public/brand-icon-128.png" width="128" height="128" alt="Jwander 暫存區品牌標誌" />
</p>

<h1 align="center">暫存區</h1>

<p align="center">
  部署於 Cloudflare 的邀請制共享暫存檔案服務。它提供類似私有雲端硬碟的上傳、瀏覽、預覽與下載體驗，並以期限、容量及邀請權限控制使用範圍。
</p>

## 線上服務

個人正式服務部署於 [upload.jwander.net](https://upload.jwander.net)，僅供持有有效邀請的使用者使用，不是公開上傳空間。

## 主要功能

- 建立可命名、可撤銷、具期限與額度的邀請。
- 支援「上傳與瀏覽」及「僅瀏覽與下載」兩種權限。
- 提供響應式檔案清單、媒體預覽、受控下載與管理刪除。
- 使用 reservation 與 D1 帳本避免超額上傳。
- 自動清理到期檔案，並對 D1 與 R2 執行 reconciliation。
- 支援亮色與暗色模式，桌面與手機共用相同操作流程。

## 預設限制

| 項目             |    預設值 |
| ---------------- | --------: |
| 全站容量         |     3 GiB |
| 單檔上限         |    50 MiB |
| 保存期限         |     90 天 |
| 單次加入         | 10 個檔案 |
| 同時上傳         |      2 個 |
| 每 IP 每小時上傳 |   500 MiB |
| 每 IP 每日上傳   |     1 GiB |

這些是本專案的預設策略，不全是 Cloudflare 硬限制。各數值的設計理由、平台邊界與修改注意事項見 [`docs/reference/configuration.md`](./docs/reference/configuration.md)。

## 技術組成

- Cloudflare Workers + Hono
- Worker Static Assets + Vite + TypeScript
- Cloudflare D1 metadata 與配額帳本
- Cloudflare R2 檔案儲存
- Turnstile、HttpOnly sessions 與 Workers Rate Limiting

## 系統架構

```text
Browser
  │
  ▼
Cloudflare Worker
  ├── Auth / Invitation
  ├── Quota Ledger ───── D1
  ├── Upload ─────────── R2
  └── Management
```

完整拓樸、權限模型與檔案生命週期見 [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md)。

## 快速開始

需求：Node.js 22 或目前 Wrangler 支援的 LTS，以及 pnpm 11。

```powershell
corepack enable
pnpm install
Copy-Item .dev.vars.example .dev.vars
pnpm run db:migrate:local
pnpm dev
```

填妥本機 `.dev.vars` 後，開啟 `http://localhost:8976`。PowerShell 若阻擋 `pnpm.ps1`，將命令中的 `pnpm` 改成 `pnpm.cmd`。

完整啟動、測試帳號與手動驗收流程見 [`docs/development/local-testing.md`](./docs/development/local-testing.md)。

## 常用命令

| 命令         | 用途                                    |
| ------------ | --------------------------------------- |
| `pnpm dev`   | 啟動本機 Worker、D1、R2 與前端 watch    |
| `pnpm check` | 執行型別、lint、測試與 build 檢查       |
| `pnpm test`  | 執行 Workers、D1 與 R2 整合測試         |
| `pnpm build` | 建置前端並驗證 Worker deployment bundle |

## 部署

Production branch 為 `main`。推送至 `main` 後，由 Cloudflare Workers Builds 自動建置前端、套用 D1 migrations 並部署 Worker；日常更新不需要在本機執行 deploy。

Cloudflare resources、runtime secrets、Workers Builds 與手動備援流程見 [`docs/development/deployment.md`](./docs/development/deployment.md)。

## 文件

完整文件入口：[`docs/README.md`](./docs/README.md)

| 想做的事              | 文件                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| 理解系統與權限模型    | [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md)           |
| 遵循 UI/UX 設計原則   | [`docs/design/ui-ux-guidelines.md`](./docs/design/ui-ux-guidelines.md)                     |
| 啟動與測試            | [`docs/development/local-testing.md`](./docs/development/local-testing.md)                 |
| 建立或管理邀請        | [`docs/development/invitation-management.md`](./docs/development/invitation-management.md) |
| 部署與維護 Cloudflare | [`docs/development/deployment.md`](./docs/development/deployment.md)                       |
| 查詢 API              | [`docs/reference/api.md`](./docs/reference/api.md)                                         |

已完成功能的規格與交接記錄放在 `docs/archive/`，日常工作不會預設調閱；只有需要追溯歷史需求或設計原因時才按需查詢。

## 安全提醒

- 不要提交 `.dev.vars`、`.env`、token、secret、`dist/` 或 `.wrangler/`。
- 邀請 URL 是 bearer capability，應為不同對象建立不同邀請並在不需要時撤銷。
- 檔案操作限定 R2 `temp-storage/objects/`，不得影響共用 bucket 的其他內容。

更完整的安全邊界、資料流與檔案生命週期見 [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md)。
