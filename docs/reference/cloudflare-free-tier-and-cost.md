# Cloudflare 免費額度與成本護欄

> 狀態：現行參考文件
> 最後更新：2026-09-21
> 適用設定：`wrangler.jsonc` 與現行檔案生命週期

這份文件提供自架者可重用的用量量測與成本管理原則。方案額度、價格及可用功能以 Cloudflare
官方文件和帳號 Dashboard 為準，不將歷史價格或單次稽核結果當作目前保證。

專案容量、檔案大小、期限、上傳流量與查詢預算的預設值，統一查閱
[執行參數與服務限制](./configuration.md)。正式環境的預警水位、個別入口耗盡額度所需流量、
帳單情境、規則內容與告警收件者應留在 repository 外的私人 Operations 紀錄。

## 1. 計費與額度來源

| 產品          | 規劃時應觀察的用量                        | 官方來源                                                                                                                                                      |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers       | 動態請求、CPU 時間與方案上限              | [Pricing](https://developers.cloudflare.com/workers/platform/pricing/)／[Limits](https://developers.cloudflare.com/workers/platform/limits/)                  |
| Static Assets | 請求是否先執行 Worker                     | [Billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)                                                   |
| D1            | rows read、rows written、資料與索引儲存量 | [Pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                                                                             |
| R2            | 帳號總儲存量、Class A 與 Class B 操作     | [Pricing](https://developers.cloudflare.com/r2/pricing/)                                                                                                      |
| Logs／Traces  | 事件、span、sampling 與保留期間           | [Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)／[Traces](https://developers.cloudflare.com/workers/observability/traces/) |
| Turnstile     | 方案能力與使用條件                        | [Plans](https://developers.cloudflare.com/turnstile/plans/)                                                                                                   |

R2 Internet egress 免費不代表儲存或讀取操作免費。免費額度還需考慮同帳號其他資源的用量；
本專案的 D1 容量帳本僅計算 `temp-storage/objects/`，不能用來推算整個 Cloudflare 帳單。

## 2. 如何量測正常使用成本

使用無私人資料的受控測試檔，分別觀察邀請交換、清單、上傳、下載與背景清理：

| 操作           | 主要量測項目                                                |
| -------------- | ----------------------------------------------------------- |
| 邀請交換與瀏覽 | session 驗證、同邀請或同私密分區的使用量彙總、清單查詢      |
| 上傳           | reservation、檔案 metadata、配額帳本與 R2 寫入              |
| 預覽與下載     | Worker 是否參與、CDN cache 命中率、R2 讀取及 Range 使用情況 |
| 到期與分區清理 | 每批處理量、失敗重試、metadata retention 與帳本釋放         |
| Reconciliation | 掃描頁數、D1 查詢、R2 list／head 及 checkpoint 進度         |

D1 的計費 rows 不等於 SQL statement 數或回傳筆數；索引與資料分布也會影響用量。以 query
`meta.rows_read`、`meta.rows_written` 和 Dashboard 實測校正，不使用固定的每次請求成本保證。
私密分區共享所有同區憑證的累計額度，估算 session 查詢成本時也應納入整個分區的事件量。

若使用平均檔案大小與保留期限估算容量，需另外計入提前刪除、分區到期、尚未完成的 reservation
及清理重試。容量、請求、資料庫操作與儲存操作是不同限制，應分別量測。

## 3. 應用程式的成本邊界

- `assets.run_worker_first` 目前為 `true`；靜態資產要求也先執行 Worker。若日後調整路由，必須一起驗證 SPA fallback 與 security headers。
- 公開單檔連結可直接讀取，CDN Custom Domain 不經 Worker session 驗證。CDN 與 Worker 的流量護欄應分別檢查。
- Session 級限流、IP 流量限制與 invitation／partition 額度各有不同範圍，不能把任何單一限制當作全站用量上限。
- 清理與 reconciliation 採批次或頁數預算；資料量增加時，同時觀察成本與跨次續跑是否完成。
- 方案的拒絕服務行為、付費產品的超額計價和應用程式容量限制彼此不同，升級方案前須重新評估。

程式限制見 [設定參考](./configuration.md)，邊緣設定及受控驗證方法見
[R2 邊緣防護指南](../development/cloudflare-edge-protection.md)。公開文件說明設計與方法，
不作為線上控制已套用或當下有效的證明。

## 4. 告警與應變

[Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) 是費用通知，不是硬性支出上限，
不能代替營運者判斷與處置。警戒值、收件者和恢復順序保存在私人 Operations 紀錄。

1. 先比對 Workers、D1、R2、cache 與 Security Events，找出異常的來源與時間範圍。
2. 依現行邊緣防護指南，選擇範圍最小且可回復的控制，驗證正常上傳、預覽、下載與 Range 行為。
3. 記錄調整前後的用量與結果；公開 issue 或文件不放 token、Cookie、object key 或真實邀請連結。
4. 恢復時逐步解除控制，每一步都確認服務行為與成本趨勢。

詳細線上操作依私人 runbook 執行；本文件不授權變更正式設定或進行流量壓力測試。

## 5. 定期檢查

- [ ] 依當下方案檢查 Workers、D1、R2 與 observability 用量，保留適當安全餘裕。
- [ ] 確認容量帳本、實際 R2 用量及同帳號其他資源的差異可解釋。
- [ ] 觀察 cache 命中率、正常 Range 流量與錯誤率，確認護欄沒有誤擋。
- [ ] 確認 cleanup 與 reconciliation 持續推進，沒有長期失敗或無界增長的歷史資料。
- [ ] 核對 budget alerts、通知收件者、Access、WAF、HTTPS／HSTS 與公開儲存入口設定。
- [ ] 依賴、schema、配額或流量模式改變後，重新量測每操作成本。

例行監測的執行時間與結果由營運者保存；沒有驗證紀錄時應標示待核對，不能從文件推定已完成。
