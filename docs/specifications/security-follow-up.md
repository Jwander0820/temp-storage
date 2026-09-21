# 安全維護待辦

> 狀態：待驗證事項
> 最後更新：2026-09-21

公開前的實作與治理已完成；本文件只追蹤仍需驗證的項目，不以舊稽核結果代表目前線上狀態。
詳細操作沿用 [部署與驗收流程](../development/deployment.md)。

## CSP 候選政策

目前 Worker 仍送出 `Content-Security-Policy-Report-Only`，前端另有既有 CSP meta policy。
候選 header 尚未強制執行，不能把「已有 CSP」等同於候選政策已完成驗收。

- [ ] 取得正式站首頁、邀請、上傳、預覽、下載與管理頁的候選 CSP 觀察紀錄。
- [ ] 將 violation 區分為必要來源、程式問題與瀏覽器擴充噪音，完成至少一週觀察。
- [ ] 確認沒有未處理的應用程式 violation，再另行評估強制 header 的變更與回復方式。

## 正式環境驗收紀錄

- [ ] 重新核對公開後監測是否已完成；舊文件沒有足夠的新紀錄可在本次標記完成。
- [ ] 核對 D1 metadata retention 的正式排程結果；完成條件見 [驗收規格](./d1-metadata-retention-fix.md)。

正式部署 SHA、時間、清理結果、告警收件者與實際防護設定保存在 repository 外的私人 Operations
紀錄；公開文件只保留驗收方法。這份清單不表示正式站目前故障，也不會自動建立監控或修改線上設定。

## 持續維護

依賴更新後執行 `pnpm audit` 與 `pnpm check`，並確認預計合併至 `main` 的 lockfile 不再包含受影響版本。
本機修補通過與 GitHub 告警關閉是不同結果；告警狀態需在修補合併後重新確認。
日常用量與防護檢查見 [成本護欄](../reference/cloudflare-free-tier-and-cost.md)。
