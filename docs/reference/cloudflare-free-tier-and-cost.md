# Cloudflare 免費額度與成本護欄

> 狀態：現行參考文件
> 最後更新：2026-08-28
> 適用設定：`wrangler.jsonc` 與 D1 migrations `0001`–`0011`

這份文件用來估算 Jwander Temp Storage 在 Cloudflare Workers Free、D1 Free 與 R2 Standard
下的用量，並說明遭遇異常流量時哪些資源會停止服務、哪些資源可能產生帳單。

價格與限制會變動；實際判定以 Cloudflare Dashboard、每次 D1 query 的 `meta.rows_read`／
`meta.rows_written` 與下列官方文件為準。本文件的 request、row 與 operation 數字是容量規劃值，
不是帳單保證。

## 1. 官方免費額度摘要

| 產品           |                                                    免費額度 | 超額行為或價格                                                                              | 本專案的主要消耗來源                                        |
| -------------- | ----------------------------------------------------------: | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Workers        |                        100,000 requests／日；每次 10 ms CPU | Free plan 達上限後請求失敗；Paid 為每月 1,000 萬 requests 內含，之後 US$0.30／百萬 requests | 所有 `upload.jwander.net` 請求；目前靜態資產也會執行 Worker |
| D1             | 500 萬 rows read／日、10 萬 rows written／日、帳號合計 5 GB | Free plan 達每日或儲存上限後 query 失敗，不自動轉成超額帳單                                 | session 驗證、檔案清單、reservation、quota、cleanup         |
| R2 Standard    |   10 GB-month／月、100 萬 Class A／月、1,000 萬 Class B／月 | US$0.015／GB-month、US$4.50／百萬 Class A、US$0.36／百萬 Class B；以計費單位進位            | PutObject、ListObjects、GetObject、HeadObject               |
| R2 egress      |                                                        免費 | 無 R2 Internet egress 費                                                                    | 上傳後的預覽與下載 bytes 本身不計 egress                    |
| Turnstile Free |                 unlimited challenges／verification requests | 免費                                                                                        | 邀請交換與管理員登入                                        |
| Workers Logs   |                             20 萬 log events／日、保留 3 日 | Free plan 額度；Paid 每月 2,000 萬內含，之後 US$0.60／百萬 events                           | invocation log 與應用程式 `console.*`                       |

Workers Traces 在 **2026-10-01 前仍為免費 beta**；之後每個 span 會與 Workers Logs 共用
observability event 額度。專案目前 logs sampling 為 `1`、traces sampling 為 `0.1`，升級 Paid plan
前應重新估算這一項。

官方來源：

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)

## 2. 現行專案硬限制

| 項目             |             現值 | 直觀換算                                                      |
| ---------------- | ---------------: | ------------------------------------------------------------- |
| 全站有效檔案容量 |            3 GiB | 3.221 GB，約占 R2 免費儲存 32.2%                              |
| 單檔             |           50 MiB | 全站同時最多容納 61 個滿額檔案                                |
| 預設邀請         |   10 檔／300 MiB | 最多 6 個滿額檔案                                             |
| 每 IP 每小時上傳 |          500 MiB | 最多 10 個滿額檔案                                            |
| 每 IP 每日上傳   |            1 GiB | 最多 20 個滿額檔案                                            |
| reservation 頻率 | 每 10 分鐘 10 次 | 單一 IP 理論上最多 1,440 次／日，仍受 byte 額度限制           |
| 保留期限         |            90 日 | 若不提前刪除，長期平均只能新增約 34.1 MiB／日才不會填滿 3 GiB |

3 GiB 是專案帳本上限，不是 Cloudflare 帳號的 R2 使用量。R2 免費儲存額度會把同帳號所有
buckets 加總；`cdn` bucket 既有的其他物件也必須計入。

若所有檔案都完整保留 90 日，依平均檔案大小估算可持續新增量：

| 平均檔案大小 |                              約可持續新增 |
| -----------: | ----------------------------------------: |
|       50 MiB |                               0.68 檔／日 |
|       10 MiB |                                3.4 檔／日 |
|        1 MiB |                                 34 檔／日 |
|      100 KiB |                                349 檔／日 |
|       10 KiB | 3,495 檔／日；此時 D1 writes 會先成為限制 |

提前刪除會提高吞吐量；上表只描述「一直保留到 90 日」的穩態。

## 3. 一次操作會消耗什麼

| 使用者操作          |                  Workers | D1                                                 | R2                                                                   |
| ------------------- | -----------------------: | -------------------------------------------------- | -------------------------------------------------------------------- |
| 冷啟動頁面          |         約 5–10 requests | 依頁面有 0–數次 query                              | 無；inline preview 另計                                              |
| 邀請交換            |                1 request | token lookup、usage aggregate、1 session write     | 無                                                                   |
| 讀取共享清單        |                1 request | session／invitation aggregate + 最多 25 個檔案 row | 無                                                                   |
| 建立 reservation    |                1 request | 多次 indexed count／sum + 約 4 個資料 row 變更     | 無                                                                   |
| 完成一個上傳        |                1 request | claim／complete 約 4 個資料 row 變更               | 1 Class A PutObject                                                  |
| Worker 下載或 Range | 每個 GET／HEAD 1 request | 約 1 個 indexed file row                           | 每個 GET／HEAD 1 Class B                                             |
| CDN inline preview  |                0 Workers | 0 D1                                               | edge cache miss 才是 1 Class B                                       |
| 每小時 cleanup      |                 排程執行 | 至少新增、更新各 1 個 cleanup row；有資料時另計    | DeleteObject 免費                                                    |
| 每日 reconciliation |                 排程執行 | 分頁掃描所有 active file rows，並逐物件 lookup     | 每 1,000 objects 一次 ListObjects + 每個 active file 一次 HeadObject |

D1 計費 row 不等於 SQL statement 數。寫入 indexed 欄位時 index 也會增加 rows written。以目前
schema，成功上傳從 reserve 到 active 的資料表本體約變更 8 個 rows；規劃時應保守抓
**15–25 billable rows written／檔案**，再用正式 D1 Metrics 校正。用 25 rows／檔案估算，
10 萬 daily writes 約能承受 4,000 個成功上傳；實際上 3 GiB 容量、IP byte 額度與 Workers
requests 通常會更早成為瓶頸。

共享清單每次都會重新驗證 session，並以 `rate_limit_events` 彙總該 invitation 的使用量。
若 invitation 有 `E` 筆事件，預設 24 檔清單可先用約 `E + 27` rows read 粗估：

- 預設 10 檔邀請：約 37 rows／次，500 萬 reads 約 13.5 萬次清單讀取。
- 100 檔邀請：約 127 rows／次，500 萬 reads 約 3.9 萬次清單讀取。
- `unlimited_files` invitation 的事件若長期累積，單次 session 驗證成本會繼續增加。

這是保守容量模型，不取代 D1 回傳的實測 `rows_read`／`rows_written`。

## 4. 最容易先撞到的界線

### Workers requests

`assets.run_worker_first` 目前是 `true`，因此命中靜態檔案的 request 也先執行 Worker，不能享有
「Static Assets requests 免費且無上限」的特性。100,000 requests／日等於：

- 全天平均約 **1.16 requests／秒**。
- 一小時內打滿約 **27.8 requests／秒**。
- 若一次冷頁面瀏覽平均產生 10 個 Worker requests，約 **10,000 次冷瀏覽／日**。

瀏覽器本地 cache 會降低回訪量，但 Cloudflare edge cache 不會免除已執行 Worker 的 request
計數。長期應把 `run_worker_first` 限縮到 `/api/*`、`/p/*`、`/d/*` 等必須執行程式的路徑，
並另外確認 SPA fallback 與 security headers 的提供方式。

### D1 rows read

一般匿名 `/api/files/:id` 或 `/d/:id` 查詢使用 primary key，成本低。較高成本的是：

- invitation session lookup 同時 aggregate 該邀請全部 `rate_limit_events`。
- reservation 一次執行多個時間窗與 invitation count／sum 子查詢。
- 有效 session 可以反覆建立新 session，現有 file-browser limiter 又以 session ID 為 key；單一
  invitation 可換 session 來取得新的 limiter bucket。

若平均一次要求讀 125 rows，約 40,000 requests 就會用完 500 萬 daily reads，會比 Workers
100,000 requests 更早停止服務。

### R2 Class B

每月 1,000 萬 Class B 約等於：

- 333,333 cache misses／日。
- 連續 30 日平均 3.86 cache misses／秒。

R2 egress 免費不表示讀取完全免費；每個 uncached GET／HEAD／Range 仍是 Class B。正常作品集流量
通常很安全，但知道公開 object URL 的攻擊者若用不同 query string 製造 cache miss，R2 是目前
最實際的 denial-of-wallet 入口。應在 `cdn.jwander.net/temp-storage/objects/*` 阻擋不需要的 query
string、只允許 GET／HEAD，並啟用合適的 Cache Rule 與 Smart Tiered Cache。

R2 超過免費量的直觀例子：

| 月用量                        |       約超額費用，不含其他產品 |
| ----------------------------- | -----------------------------: |
| 10,000,001–11,000,000 Class B | 最低約 US$0.36，計費單位會進位 |
| 100,000,000 Class B           |                    約 US$32.40 |
| 1,000,000,000 Class B         |                   約 US$356.40 |
| 平均 20 GB Standard storage   |                 約 US$0.15／月 |
| 平均 100 GB Standard storage  |                 約 US$1.35／月 |

## 5. DDoS 與 denial-of-wallet 的差別

Cloudflare 對所有 plans 提供 L3、L4、L7 的 unmetered、unlimited DDoS protection，且官方表示
被辨識為 DDoS 的 attack traffic 不收費：

- [DDoS Protection overview](https://developers.cloudflare.com/ddos-protection/about/)
- [DDoS billing FAQ](https://developers.cloudflare.com/ddos-protection/frequently-asked-questions/)

但「大量、格式正常、成功命中公開檔案」可能被視為應用程式濫用而不是 DDoS。不能只依賴自動
DDoS 判定：

- Workers Free 與 D1 Free 主要風險是額度耗盡造成當日 outage，不是帳單暴增。
- R2 是 pay-as-you-go subscription；公開 bucket custom domain 的成功讀取可能超過免費 operations。
- Budget alert 只通知，不會暫停或限制費用。官方說明見
  [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)。

## 6. 建議的免費層防護

### Cloudflare Dashboard

1. 保持 Workers Free，除非已完成 Paid plan 成本模型；Free plan 的 daily cap 是天然斷路器。
2. 在 Billing 依營運者可接受損失建立至少兩級 account-wide budget alerts；正式金額與收件者保存在私人 Operations 紀錄。它們不是 hard cap。
3. 確認 Free Managed Ruleset、HTTP DDoS protection、Security Events 與 Bot Fight Mode 的實際狀態。
4. 先依 Dashboard 當下額度安排 WAF custom rules 與 rate limiting rule。Custom Rules 優先保護驗證交換、上傳 mutation、管理 API 與公開 CDN prefix；實際名稱、expression、數量與門檻保存在私人 Operations 紀錄。
   Free Rate Limiting 可用欄位、計數特徵、週期及 cached-assets 行為會依方案演進，設定前必須以官方文件與 Dashboard 為準。
5. CDN temp prefix 只允許 GET／HEAD，拒絕不需要的 query string；影音 Range 必須先在 Security Events
   觀察，避免誤傷正常播放器。
6. 啟用 Smart Tiered Cache，讓不同 edge locations 的 miss 優先共用 upper tier，降低 R2 Class B。
7. 保持 `r2.dev` 關閉。Custom Domain 會讓整個 bucket 的已知 key 公開，不只本專案 prefix；共用
   `cdn` bucket 的其他物件必須被視為同一公開邊界。
8. 確認 Cloudflare Access 只涵蓋 `/admin`、`/admin/*`、`/api/admin/*`，並定期測試未登入阻擋。
9. 確認應用程式與 CDN hostname 的 HTTP 請求會轉往 HTTPS。HSTS 應先從 host-scoped、短 Max Age 漸進驗證；整個 zone 尚未完成 HTTPS 盤點時，不開啟 zone-wide `includeSubDomains` 或 preload。

WAF Free plan 能力與規則數量見 [WAF overview](https://developers.cloudflare.com/waf/)、
[Custom rules](https://developers.cloudflare.com/waf/custom-rules/) 與
[Rate limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/)。

### Worker 內部

現行程式已完成 access code oracle、D1 deleted metadata foreign key、大型 JSON、公開讀取／邀請交換／
上傳 mutation 限流、session mutation CSRF、固定長度 capability 驗證、reconciliation 分頁 checkpoint 與歷史資料
保留政策。metadata purge 會在同一 D1 batch 先刪 reservation child，再刪 file parent；migration
`0009`、`0010` 與 `0011` 分別加入 metadata purge 索引、歷史清理索引與 reconciliation checkpoint。`rate_limit_events` 只會跟著超過保留期且已
無檔案關聯的退休 invitation 清除，不會重設有效 invitation 的終身額度。這些程式與 migration 仍需
正式部署後才在 production 生效。

仍可評估將 inline preview 放到獨立公開 bucket／prefix，或全部經 Worker 授權。現在所有檔案都在
可推導的 `YYYY/MM/DD/:fileId` key；Custom Domain 本身不能依 D1 status 或 preview policy 授權。

Cloudflare Dashboard 的完整設定值、驗證與回復步驟見
[`../development/cloudflare-edge-protection.md`](../development/cloudflare-edge-protection.md)；D1 metadata foreign
key 修正方案見
[`../specifications/d1-metadata-retention-fix.md`](../specifications/d1-metadata-retention-fix.md)。

Rate Limiting binding 行為見
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## 7. 事件應變原則

公開文件只保留通用判斷與可逆處理原則。正式環境的 WAF expressions、Rate Limiting 門檻、告警
收件者、緊急規則與逐步恢復順序，應保存在 repository 外的私人 Operations runbook。

1. 先比對 Security Events、Workers、D1、R2 與 cache 指標，辨識真正的成本來源。
2. 優先對明確攻擊入口套用範圍最小、可快速撤銷的邊緣或應用層控制。
3. 保留事件時間、指標與變更紀錄；文件或 issue 不應包含 token、object key 或 invitation URL。
4. 恢復時一次只解除一層控制，並在每一步確認流量與成本沒有再次異常。
5. Budget Alert 只是可能延遲的通知，不是 hard cap；收到告警後仍需人工判斷與處置。

## 8. 每月檢查表

- [ ] Workers requests 的最高日是否仍低於私人 Operations 紀錄中的預警水位。
- [ ] D1 rows read／written 是否接近方案額度與營運者保留的安全餘裕。
- [ ] R2 account-wide storage、Class A／B 是否接近方案額度與成本預警水位。
- [ ] CDN cache hit ratio 是否穩定，是否出現大量唯一 query string 或異常 Range。
- [ ] `cleanup_runs`、`rate_limit_events`、`upload_reservations` 與 `files` row count 是否持續單向增長。
- [ ] Workers Logs 是否接近 200,000 events／日；2026-10-01 後把 trace spans 一併計入。
- [ ] Budget alerts、通知收件者、Cloudflare Access、WAF、HTTPS／HSTS 與 `r2.dev` 狀態是否正確。
- [ ] 使用 D1 query `meta` 或 Dashboard 校正本文件的每操作 row 估算。
