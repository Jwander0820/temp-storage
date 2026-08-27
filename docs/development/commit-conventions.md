# Commit message 與拆分通則

> 狀態：現行規範  
> 最後更新：2026-08-27

## 目的

Commit 應讓另一位開發者只看歷史紀錄，就能理解「改變了什麼行為、為什麼改、是否包含 migration 或風險」。本專案使用 Conventional Commits，摘要與說明以繁體中文為主。

## 格式

```text
type(optional-scope): 簡短摘要

必要時補充變更行為、原因、相容性、migration 與驗證方式。
```

### Type

| Type       | 使用時機                                 |
| ---------- | ---------------------------------------- |
| `feat`     | 新增使用者能力、API、權限或可觀察行為    |
| `fix`      | 修正錯誤、安全問題或與既定規格不符的行為 |
| `refactor` | 不改外部行為的結構整理                   |
| `perf`     | 改善效能、查詢或資源使用                 |
| `test`     | 只新增或調整測試                         |
| `docs`     | 只修改文件                               |
| `chore`    | 工具、維護或不屬於產品行為的工作         |
| `ci`       | CI、Cloudflare Builds 或自動化流程       |

Scope 是選用的；只有能穩定代表子系統時才使用，例如 `feat(invitation): ...`。不要為單一檔名創造 scope。

## 摘要原則

- 描述完成後的結果，例如「新增僅瀏覽邀請」，不要寫「更新 invitation files」。
- 使用具體名詞，避免「調整一些 UI」、「misc fixes」或「WIP」。
- 摘要不要列檔名、測試數量或實作細節。
- 一個 commit 只表達一個可回復的核心意圖；若摘要需要使用多個無關的「以及」，通常應拆分。
- 不加入句號、issue 模板文字、Codex／AI 署名或 `Co-authored-by`，除非使用者明確要求。

## Body 原則

Body 不是逐檔 diff，應優先說明：

1. 使用者或系統行為如何改變。
2. 為什麼需要這個改變，尤其是安全、權限或相容性原因。
3. 是否包含 D1 migration、API contract 或部署注意事項。
4. 已完成哪些關鍵驗證。

小型且完全自明的變更可以只有摘要。大型功能建議使用 2–6 個條列，避免把所有 implementation detail 塞進 commit message。

## 拆分通則

- 功能程式與純文件通常分開 commit。
- Migration 必須和依賴它的程式、型別與測試一起提交，避免中間狀態無法運作。
- 同一個安全修正所需的前後端 enforcement 應放在一起，不能只提交 UI 限制。
- 純格式化若影響大量無關檔案，獨立 commit。
- Handoff 與研究筆記不應混入功能 commit，除非它們是該功能的必要交付物。
- 使用者指定排除 docs 時，確認 `README.md`、`docs/**` 及為文件追蹤而改的 `.gitignore` 都未 staged。

## Commit 前檢查

```powershell
git status --short
git diff --cached --stat
git diff --cached --check
```

確認：

- staged 清單只包含這次意圖需要的檔案。
- 沒有 `.dev.vars`、`.env`、secret、token、`dist/` 或 `.wrangler/`。
- 測試與 build 結果符合變更風險。
- 需要的 migration、測試與文件沒有遺漏。
- 使用者只要求撰寫 message 時，不自行 commit；只有明確要求 commit 才執行。
- Commit、push、部署是三個獨立授權，不可由前一步推論下一步。

## 範例

### 功能

```text
feat: 重塑暫存區介面並新增僅瀏覽邀請

- 統一上傳、檔案與管理頁面的響應式導覽
- 允許受邀者瀏覽與下載，並由後端拒絕所有上傳入口
- 加入 D1 migration 與權限測試
```

### 修正

```text
fix: 避免額度耗盡後錯誤阻擋檔案瀏覽
```

### 文件

```text
docs: 整理專案架構與協作規範
```
