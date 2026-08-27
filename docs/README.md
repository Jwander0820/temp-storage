# 專案文件索引

> 狀態：現行索引  
> 最後更新：2026-08-27

這裡保存 Jwander Temp Storage 的現行架構、設計決策與開發流程。根目錄 `README.md` 負責快速啟動與部署入口；日常工作只依任務需要讀取下列現行文件。

## 依任務查閱

不要預讀全部文件，只開啟和目前任務直接相關的項目。

| 任務                   | 文件                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| 理解系統、權限或資料流 | [`architecture/system-overview.md`](./architecture/system-overview.md)           |
| 修改介面或互動         | [`design/ui-ux-guidelines.md`](./design/ui-ux-guidelines.md)                     |
| 啟動與手動測試         | [`development/local-testing.md`](./development/local-testing.md)                 |
| Cloudflare 資源與部署  | [`development/deployment.md`](./development/deployment.md)                       |
| 建立或撤銷邀請         | [`development/invitation-management.md`](./development/invitation-management.md) |
| 撰寫或拆分 commit      | [`development/commit-conventions.md`](./development/commit-conventions.md)       |
| 查詢 API               | [`reference/api.md`](./reference/api.md)                                         |
| 查詢限制與環境變數     | [`reference/configuration.md`](./reference/configuration.md)                     |

## 分類方式

```text
docs/
├─ README.md                 # 文件入口與維護方式
├─ architecture/            # 現行系統架構、資料流與未來 ADR
├─ design/                   # UI/UX、內容語言、品牌資產與視覺規範
├─ development/             # 本機開發、測試、Git 與協作流程
├─ reference/               # API、設定值與穩定技術參考
├─ specifications/          # 尚在規劃、實作或驗收的功能規格
└─ archive/                 # 預設不讀取的歷史規格與交接快照
   ├─ specifications/
   └─ handoffs/
```

### `architecture/`

保存目前仍成立的系統結構與架構決策。若未來需要記錄重大取捨，可新增 `architecture/decisions/NNNN-title.md`，採用 ADR 格式說明背景、決定與後果。

### `design/`

保存介面、互動、內容語言與設計 token。設計規範是 living document，程式改變長期 UI 原則時應同步更新。

### `development/`

保存開發者與 Codex 共同遵守的流程，例如本機啟動、測試、commit、release checklist。可執行命令應以 repository 當下的 `package.json` 為準。

### `reference/`

保存需要按名稱查詢的穩定技術資料，例如 API 路由、runtime 參數、預設限制與 secret 名稱。Reference 說明「目前是什麼」，不保存歷史討論。

### `specifications/`

只保存尚在規劃、實作或驗收中的規格。功能完成且不再需要日常調閱後，移至 `archive/specifications/`。

### `archive/`

保存完成規格與特定日期的交接快照。這是冷封存區，日常工作不得主動搜尋或讀取；只有使用者明確要求查詢歷史需求、交接內容或過往設計理由時，才從 [`archive/README.md`](./archive/README.md) 進入並按需調閱。

## Codex 指令放置

Repository-wide 指令放在根目錄 [`../AGENTS.md`](../AGENTS.md)，因為 Codex 會從 Git root 向目前工作目錄組合 `AGENTS.md`。只放在 `docs/AGENTS.md` 會讓規則主要作用於 `docs` 子目錄，無法可靠涵蓋 `src`、`public` 與測試。

本專案只維護根目錄 `AGENTS.md`，不建立 `docs/AGENTS.md` 或 `.agents/` 平行規則來源，避免規範分散與內容衝突。

Codex 的實際尋找順序與 scope 規則，以 [OpenAI 官方 AGENTS.md 文件](https://learn.chatgpt.com/docs/agent-configuration/agents-md)為準。

## 文件維護規則

- 長期有效文件使用穩定檔名，不在檔名加入日期。
- 歷史交接、調查或事件記錄使用日期前綴。
- 使用相對連結，搬移文件時同步修正所有引用。
- 一份文件只保有一個主要責任；README 當索引，不複製完整內容。
- 文件開頭標示狀態與最後更新日期；歷史文件標示為 snapshot。
- 不寫入 token、Cookie、secret、private key、真實邀請連結、個人檔名或 `.dev.vars` 內容。
- 新增文件後同步更新本索引。
- 完成功能的規格與交接記錄移入 `archive/`，並移除現行文件對它們的日常閱讀連結。
- 一般搜尋排除 `docs/archive/**`；只有使用者明確要求調閱歷史資料時例外。

## 現有文件

### Architecture

- [`system-overview.md`](./architecture/system-overview.md)：現行 Cloudflare Worker、D1、R2、權限與生命週期總覽。

### Design

- [`ui-ux-guidelines.md`](./design/ui-ux-guidelines.md)：Quiet Utility Minimalism 設計系統與驗收規則。
- [`assets/brand/`](./design/assets/brand/)：品牌標誌原始 SVG、點陣輸出與概念展示稿。

### Development

- [`local-testing.md`](./development/local-testing.md)：完整本機手動測試流程。
- [`deployment.md`](./development/deployment.md)：Cloudflare 資源、Workers Builds、secrets 與部署檢查。
- [`invitation-management.md`](./development/invitation-management.md)：管理頁、CLI、邀請 URL 與撤銷方式。
- [`commit-conventions.md`](./development/commit-conventions.md)：Conventional Commits 與拆分原則。

### Reference

- [`api.md`](./reference/api.md)：公開、invitation session 與 admin API 路由。
- [`configuration.md`](./reference/configuration.md)：服務限制、非秘密 runtime 參數與 secret 名稱。

### Specifications

- [`README.md`](./specifications/README.md)：進行中規格的狀態與封存方式；目前沒有進行中的規格。

### Archive

- [`README.md`](./archive/README.md)：冷封存政策與按需調閱入口。主索引不逐份列出封存文件。
