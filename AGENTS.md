# AGENTS.md

本檔案是 Jwander Temp Storage 的 repository-wide Codex 工作規範。完整背景與長篇規格放在
[`docs/`](./docs/README.md)，不要把所有內容複製進本檔案。

## 專案摘要

- 這是部署於 Cloudflare Workers 的邀請制共享暫存檔案服務。
- 前端是 TypeScript、HTML 與 CSS，由 Vite 建置後透過 Worker Static Assets 提供。
- Worker 使用 Hono；metadata、邀請、session 與配額放在 D1，檔案本體放在 R2。
- 正式入口為 `upload.jwander.net`；允許安全 inline 預覽的媒體可由 `cdn.jwander.net` 提供。
- 開始架構或權限變更前，先讀 [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md)。

## 規格來源

- 文件入口：[`docs/README.md`](./docs/README.md)
- 系統架構：[`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md)
- UI/UX：[`docs/design/ui-ux-guidelines.md`](./docs/design/ui-ux-guidelines.md)
- Commit 通則：[`docs/development/commit-conventions.md`](./docs/development/commit-conventions.md)
- 本機驗收：[`docs/development/local-testing.md`](./docs/development/local-testing.md)
- 部署：[`docs/development/deployment.md`](./docs/development/deployment.md)
- 邀請管理：[`docs/development/invitation-management.md`](./docs/development/invitation-management.md)
- API：[`docs/reference/api.md`](./docs/reference/api.md)
- 執行參數：[`docs/reference/configuration.md`](./docs/reference/configuration.md)

若文件與程式行為不一致，先查明哪一方過期；不要靜默選一邊。安全與權限邏輯以後端實作和測試為準，長期產品決策應同步更新文件。

## 文件讀取策略

- 預設只讀取任務直接相關的現行文件；不要在開始工作時預讀或遞迴掃描整個 `docs/`。
- 根目錄 `README.md` 只負責 GitHub 首頁導覽、快速開始與常用入口；部署、API、設定或架構細節應放入對應的 `docs/` 文件並更新索引。
- `docs/archive/**` 是冷封存區。只有使用者明確要求查詢歷史規格、交接紀錄或過往設計理由時，才可搜尋、讀取或摘要其中內容。
- 一般文字或檔案搜尋必須排除封存區，例如使用 `--glob '!docs/archive/**'`；若使用的工具無法排除路徑，應限制搜尋目錄，不要掃描封存區。
- 封存文件只代表當時狀態，不得覆蓋現行程式、測試、架構與設計指引。

## 工作方式

- 先閱讀相關檔案與既有測試，再修改程式。
- 保留使用者尚未提交的變更；不要覆蓋、重設或順手格式化無關檔案。
- 優先做範圍小、可驗證的修改，不為單一需求加入大型依賴或平行實作。
- 新功能必須處理成功、失敗、空資料、載入中、權限不足與到期狀態。
- API、資料表或權限行為變更時，同步補 migration、測試與相關文件。
- 不要在未獲明確要求時執行 commit、push、正式 migration 或部署。

## 套件與本機環境

- 使用 `pnpm@11.9.0`；不要執行 `npm install`，也不要產生 `package-lock.json`。
- Windows PowerShell 若無法執行 `pnpm`，使用 `pnpm.cmd` 執行相同命令。
- 本機秘密只使用 `.dev.vars`。不得建立、覆寫、輸出或提交 `.dev.vars`、`.env` 或任何 token。
- 本機資料初始化：`pnpm run db:migrate:local`。
- 本機服務：`pnpm dev`，入口為 `http://localhost:8976`。
- `.wrangler/` 只保存本機 D1/R2 狀態；除非使用者明確授權，不得加上 `--remote`。

## 架構與安全界線

- 邀請 token 放在 URL fragment，交換成功後改用 HttpOnly invitation session。
- 「僅瀏覽與下載」邀請對外額度為 `0 個 / 0 B`，後端必須拒絕所有上傳入口；不能只隱藏 UI。
- 一般邀請額度用完後只拒絕新 reservation，仍可在邀請與 session 有效時瀏覽及下載。
- Admin session、invitation session、delete token 是不同能力，不得互相推導或擴權。
- 不得在 API 回應、log、文件或前端暴露 R2 object key、token hash、pepper、原始管理 token 或 IP hash。
- 檔案類型同時依宣告、副檔名與內容偵測判斷；禁止類型必須 fail closed。
- R2 操作限定 `temp-storage/objects/` prefix，不得影響同 bucket 的其他既有物件。

## UI/UX 規則

- 介面遵循「Quiet Utility Minimalism」：暖中性色、克制重點色、熟悉的雲端硬碟心智模型。
- 不使用藍紫漸層、霓虹科技感、Emoji 結構圖示或純裝飾動畫。
- 沿用 `public/cloud-drive.css` 的語意色彩與元件，不在單一頁面新增任意色碼或重複元件。
- 所有 UI 變更同時檢查亮暗模式、375px 手機、鍵盤操作、Focus、Disabled 與無水平溢位。
- 頂層導覽已有相同功能時，不在頁面 Header 或空狀態重複放相同連結。
- 新增或改變長期設計原則時，同步更新 UI/UX 指引。

## 驗證

依變更風險執行最小充分驗證；交付前通常至少執行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build:client
```

- D1 migration、配額、session、權限與檔案生命週期變更必須執行完整測試。
- UI 變更除自動檢查外，需實際檢查受影響的桌面與手機尺寸。
- 沙箱造成 `spawn EPERM` 時，在取得允許後於沙箱外重跑原命令；不要把環境限制誤判為程式失敗。

## Commit message

- 使用 Conventional Commits：`type(optional-scope): 繁體中文摘要`。
- 常用 type：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`、`ci`、`perf`。
- 摘要使用祈使／完成意圖，描述使用者或系統結果，不列檔名、不寫「update files」。
- Body 說明重要行為、理由、權限或 migration 影響與測試；不要逐檔抄寫 diff。
- 功能程式與純文件原則上分開 commit；若使用者指定排除 docs，連同 `README.md`、`docs/**` 與相關 `.gitignore` 變更保持未暫存。
- Commit 前先檢查 `git diff --cached --check` 與 staged 檔案清單。
- 不在 commit message 加入 Codex、AI 共同作者或工具署名，除非使用者明確要求。

範例：

```text
feat: 新增僅瀏覽邀請並強化暫存區介面

- 允許受邀者瀏覽與下載，同時由後端拒絕上傳
- 統一桌面與手機導覽並補齊權限測試
```
