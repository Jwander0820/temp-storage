# Cloudflare 免費額度與成本護欄

> 狀態：現行參考文件
> 最後更新：2026-08-28
> 適用設定：`wrangler.jsonc` 與 D1 migrations `0001`–`0009`

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

| 使用者操作          |                  Workers | D1                                                 | R2                                                  |
| ------------------- | -----------------------: | -------------------------------------------------- | --------------------------------------------------- |
| 冷啟動頁面          |         約 5–10 requests | 依頁面有 0–數次 query                              | 無；inline preview 另計                             |
| 邀請交換            |                1 request | token lookup、usage aggregate、1 session write     | 無                                                  |
| 讀取共享清單        |                1 request | session／invitation aggregate + 最多 25 個檔案 row | 無                                                  |
| 建立 reservation    |                1 request | 多次 indexed count／sum + 約 4 個資料 row 變更     | 無                                                  |
| 完成一個上傳        |                1 request | claim／complete 約 4 個資料 row 變更               | 1 Class A PutObject                                 |
| Worker 下載或 Range | 每個 GET／HEAD 1 request | 約 1 個 indexed file row                           | 每個 GET／HEAD 1 Class B                            |
| CDN inline preview  |                0 Workers | 0 D1                                               | edge cache miss 才是 1 Class B                      |
| 每小時 cleanup      |                 排程執行 | 至少新增、更新各 1 個 cleanup row；有資料時另計    | DeleteObject 免費                                   |
| 每日 reconciliation |                 排程執行 | 最多掃描 500 個 active file rows，並逐物件 lookup  | 1 Class A ListObjects + 最多 500 Class B HeadObject |

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
2. 在 Billing 建立至少兩級 account-wide budget alerts，例如 US$1 與 US$5。它們不是 hard cap。
3. 確認 Free Managed Ruleset、HTTP DDoS protection、Security Events 與 Bot Fight Mode 的實際狀態。
4. Free plan 有 5 個 WAF custom rules 與 1 個 rate limiting rule。Custom Rules 可精確保護：
   - `POST /api/invitations/exchange`
   - `POST /api/uploads/reserve`
   - `PUT /api/uploads/*`
   - `/api/admin/*`
   - `cdn.jwander.net/temp-storage/objects/*`
     Free Rate Limiting 只有 Path／Verified Bot expression、IP、10 秒週期，且會計入 cached assets；其唯一
     規則優先用在專屬 `/temp-storage/objects/` path，不能照 Custom Rule 的 Host／Method 條件設定。
5. CDN temp prefix 只允許 GET／HEAD，拒絕不需要的 query string；影音 Range 必須先在 Security Events
   觀察，避免誤傷正常播放器。
6. 啟用 Smart Tiered Cache，讓不同 edge locations 的 miss 優先共用 upper tier，降低 R2 Class B。
7. 保持 `r2.dev` 關閉。Custom Domain 會讓整個 bucket 的已知 key 公開，不只本專案 prefix；共用
   `cdn` bucket 的其他物件必須被視為同一公開邊界。
8. 確認 Cloudflare Access 只涵蓋 `/admin`、`/admin/*`、`/api/admin/*`，並定期測試未登入阻擋。

WAF Free plan 能力與規則數量見 [WAF overview](https://developers.cloudflare.com/waf/)、
[Custom rules](https://developers.cloudflare.com/waf/custom-rules/) 與
[Rate limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/)。

### Worker 內部

現行程式已完成 access code oracle 與 D1 deleted metadata foreign key 修正：access code 只在 Turnstile 與
有效 invitation token 後驗證；metadata purge 會在同一 D1 batch 先刪 reservation child，再刪 file
parent，並由 migration `0009` 加入 purge index。兩者仍需正式部署／migration 後才在 production 生效。

以下項目是現行實作仍應補強的成本與濫用護欄：

1. 對 invitation exchange、reserve、upload PUT、public metadata 與 download 分別加上便宜的
   Rate Limiting binding，且在 D1／R2 操作前執行。Workers Rate Limiting 是 local、eventually
   consistent，適合濫用防護，不可當精確 quota 帳本。
2. 對 JSON endpoint 在 `context.req.json()` 前限制 `Content-Length`，避免匿名 100 MB JSON 消耗
   128 MB Worker memory 與 10 ms CPU。
3. 所有 session-authenticated mutation 驗證 `Origin` 為完整 `UPLOAD_ORIGIN`，防止同一
   registrable domain 的其他子網域利用 same-site cookies 發動 CSRF。
4. 對 invitation session cookie 與 DeleteToken 先驗證固定長度，再做雜湊。
5. 為 `rate_limit_events`、歷史 invitations 與 `cleanup_runs` 設定可驗證的保留政策。
6. reconciliation 使用 R2 list cursor 與 D1 cursor；目前只掃第一批 1,000 objects／500 files。
7. 評估將 inline preview 放到獨立公開 bucket／prefix，或全部經 Worker 授權。現在所有檔案都在
   可推導的 `YYYY/MM/DD/:fileId` key；Custom Domain 本身不能依 D1 status 或 preview policy 授權。

Cloudflare Dashboard 的完整設定值、驗證與回復步驟見
[`../development/cloudflare-edge-protection.md`](../development/cloudflare-edge-protection.md)；D1 metadata foreign
key 修正方案見
[`../specifications/d1-metadata-retention-fix.md`](../specifications/d1-metadata-retention-fix.md)。

Rate Limiting binding 行為見
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## 7. 事件應變順序

完整的五分鐘止血流程、可直接複製的 WAF expressions、R2 Custom Domain Disable 步驟與恢復順序見
[`../development/cloudflare-cost-incident-response.md`](../development/cloudflare-cost-incident-response.md)。摘要如下：

1. 先看 Security Events、Workers requests、D1 row metrics、R2 Class A／B 與 cache status，判斷是
   Worker 路徑、D1 aggregate 或 CDN cache miss。
2. 對明確攻擊入口啟用 WAF Block；靜態媒體不要依賴 Managed Challenge。
3. 將 `UPLOADS_ENABLED=false`，停止新的 reservation；這不會阻擋瀏覽、下載或已知 CDN URL。
4. 撤銷遭濫用 invitation；必要時重新簽發其他 invitations。
5. 若 R2 Class B 仍暴增，暫時 WAF block temp prefix，最嚴重時 Disable R2 Custom Domain。注意 `cdn`
   是共用 bucket，停用會影響其他內容。
6. Budget Alert 觸發後仍要人工處置；它不會自動關閉 Worker、D1 或 R2，而且通知可能延遲到隔天。

## 8. 每月檢查表

- [ ] Workers requests 的最高日是否低於 70,000，預留攻擊與突發空間。
- [ ] D1 rows read／written 最高日是否低於免費額度 70%。
- [ ] R2 account-wide storage 是否低於 7 GB-month，Class A／B 是否低於免費量 70%。
- [ ] CDN cache hit ratio 是否穩定，是否出現大量唯一 query string 或異常 Range。
- [ ] `cleanup_runs`、`rate_limit_events`、`upload_reservations` 與 `files` row count 是否持續單向增長。
- [ ] Workers Logs 是否接近 200,000 events／日；2026-10-01 後把 trace spans 一併計入。
- [ ] Budget alerts、通知收件者、Cloudflare Access、WAF 與 `r2.dev` 狀態是否正確。
- [ ] 使用 D1 query `meta` 或 Dashboard 校正本文件的每操作 row 估算。
