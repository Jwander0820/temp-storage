# Cloudflare R2 邊緣防護指南

> 狀態：公開操作原則
> 最後更新：2026-08-29
> 適用範圍：使用 Cloudflare Worker、R2 Custom Domain 與公開 CDN 的部署

本文件說明如何設計 R2 CDN 的 WAF、Cache、Rate Limiting、HTTPS 與成本護欄。它不記錄任何正式環境的
Enabled／Disabled 狀態、實際門檻、告警金額、Security Events 或緊急封鎖規則；正式狀態應保存於不公開的
Operations 紀錄。

免費額度與成本模型見
[`../reference/cloudflare-free-tier-and-cost.md`](../reference/cloudflare-free-tier-and-cost.md)。Cloudflare
Dashboard 名稱、方案限制與可用欄位可能調整，實際操作前應重新查閱官方文件並以帳號當下畫面為準。

## 核心原則

- 服務專屬規則必須限制 hostname 與必要的 path prefix，避免影響同 zone 或共用 bucket 的其他內容。
- 所有變更一次只套用一項並立即驗證，保留可逆的回復方式。
- WAF、Rate Limiting、Cache、Access 與應用程式授權處理不同風險，不能互相取代。
- 不把 Budget Alert 當成 hard cap，也不以刪除 bucket、object、D1、Worker 或 DNS 作為日常止血方式。
- 不在公開文件、log、issue 或截圖中保存 object key、invitation URL、token、Cookie、secret 或告警收件者。

## 1. 限制 R2 公開入口

正式公開讀取應使用 R2 Custom Domain，讓請求經過目標 zone 的 WAF、Cache 與其他 edge controls。若已使用
Custom Domain，Public Development URL `r2.dev` 應保持 Disabled，避免產生不受相同規則控制的第二入口。

R2 Custom Domain 不會自動提供 bucket 根目錄 listing；仍需確認應用程式沒有把 `R2.list()` 結果當成
匿名 API 回傳。S3 API credentials 是另一個管理入口，必須採最小權限並保存在 runtime secret 或受控工具，
不能放進前端或 repository。

參考 [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)。

## 2. 建立 HTTP contract WAF

先根據應用程式的真實協定定義 CDN 公開路徑，例如：

```text
host = <cdn-host>
path starts with /<project-prefix>/
allowed methods = GET, HEAD
query string = 不使用時一律拒絕
Range header = 允許
```

若 object URL 不使用 signed query parameter，可在 WAF 拒絕所有 query string，降低 query cache-busting
風險。若未來需要 query 授權，必須重新設計授權、cache key 與有效期，不能只把 query 從 cache key 忽略。

直接公開 R2 object 通常不需要 POST、PUT 或 DELETE；這些 method 應由 Worker、S3 API 或其他已授權入口
處理。不要封鎖 `Range` header，因為圖片、音訊與影片預覽可能依賴 Range request。

同一 zone 若有多個網站，可另建立常見敏感路徑探測規則，阻擋 `.env`、`.git`、錯誤暴露的設定檔或開發
工具入口。這類規則只會保護經過 Cloudflare proxy 的 hostname，且必須先確認沒有同名合法路徑。

參考 [Create a custom rule](https://developers.cloudflare.com/waf/custom-rules/create-dashboard/)。

## 3. 讓 Cache 尊重 origin policy

公開 CDN path 可設為 Eligible for cache，但不應用 Edge TTL 強制覆蓋 origin `Cache-Control`：

- Edge TTL：Respect origin Cache-Control。
- Browser TTL：保留 origin 設定。
- Cache key：維持預設，除非已完成授權與 query 行為設計。
- 不強制快取 `private` 或 `no-store`。

應用程式可以讓安全 inline preview 回傳 public cache policy，而 download-only、需要授權或不可共用的內容
回傳 `private, no-store`。Cache Rule 只決定回應是否具備快取資格，不能取代應用程式的資料分類與授權。

R2 刪除具有強一致性，但 edge 已快取內容可能保留到 TTL 到期。需要立即失效時，應 purge 單一完整 URL；
大量或日常刪除仍必須走應用程式的 metadata 與 object 生命週期，不能直接從 Dashboard 刪 object 取代。

參考 [Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)、
[Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/) 與
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)。

## 4. 使用 Smart Tiered Cache

若目前方案提供 Smart Tiered Cache，可使用 Smart topology，讓多個 edge location 共用 upper-tier miss，減少
直接回源 R2 的 Class B operations。不要在未確認費用前啟用 Regional、Custom 或其他付費 topology。

參考 [Enable Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/)。

## 5. 校正 Rate Limiting

Rate Limiting Rule 應先從 Security Analytics 取得正常尖峰，再決定 hostname、path、計數特徵、週期與門檻。
公開文件不保存正式門檻，因為它會隨檔案數量、影音 Range、共享 NAT、快取行為與使用模式改變。

設定前必須確認帳號方案實際支援：

- expression 可使用哪些欄位；
- counting characteristic 與 period；
- 是否能排除 cached assets；
- action 與 mitigation timeout；
- 可建立的規則數量。

如果 cache hit 也會計數，影音 Range、多檔案並行載入與共享 NAT 都可能造成誤判。沒有足夠流量基準時，先
保持 Disabled 或暫緩；啟用後觀察 Security Events，合法流量被擋時先停用規則，再依實際尖峰調整。

不要對圖片或影片子資源使用 Managed Challenge，因為 `<img>`／`<video>` 無法可靠完成互動挑戰。

參考 [Create a rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)、
[Rate limiting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) 與
[Find the correct rate limit](https://developers.cloudflare.com/waf/rate-limiting-rules/find-rate-limit/)。

## 6. DDoS、Managed WAF 與 Access

HTTP DDoS protection 是基線能力，但不能阻止所有格式正常、成功讀取大量公開 object 的濫用。Managed WAF
與可用 ruleset 依方案而異；Dashboard 只有升級入口時，不應為了符合文件而購買方案。

Security Analytics 與 Security Events 應能用來觀察 custom rule、rate limit 與異常來源。公開服務的管理面
可以使用 Cloudflare Access，但只保護管理 path；不要讓一般首頁、邀請、檔案瀏覽、preview、download 或
一般 API 經過 Access，除非產品明確要求所有使用者具有 Access identity。

## 7. HTTPS 與 HSTS

先確認所有受影響 hostname 的 HTTPS、憑證、preview、download 與 Range 都正常，再啟用 HTTP → HTTPS
轉址。HSTS 是長期瀏覽器承諾，只有完成整個 zone 的 HTTPS 盤點後才考慮 zone-wide `includeSubDomains`
或 preload。

若只有部分 hostname 完成盤點，優先使用 hostname-scoped Response Header Transform Rule，從較短 Max Age
開始觀察。不要在仍有 HTTP-only、DNS-only 或可能離開 Cloudflare 的子網域時啟用 zone-wide HSTS。

參考 [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)、
[HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/) 與
[Response Header Transform Rules](https://developers.cloudflare.com/rules/transform/response-header-modification/)。

## 8. Budget Alert 與成本觀察

Pay-as-you-go 帳號若提供 Budget Alert，應依可接受損失與日常流量建立低額早期通知及較高事件通知。收件者
必須由帳號管理員確認，不在公開文件記錄實際 email 或正式金額。

Budget Alert 只有通知效果，不會自動停用 R2、Worker、D1 或 Custom Domain，而且用量處理與寄信可能延遲。
真正的成本防護仍來自 cache、rate limit、應用程式配額及事先準備的可逆事故流程。

參考 [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)。

## 9. 驗證模板

使用不含 token、invitation 或私人 object key 的受控測試物件：

```powershell
$testUrl = "https://<cdn-host>/<project-prefix>/<test-object-key>"
curl.exe -I $testUrl
curl.exe -I $testUrl
curl.exe -I "$testUrl?cache-bust=1"
curl.exe -I -X POST $testUrl
curl.exe -I -H "Range: bytes=0-1023" $testUrl
curl.exe -I "https://<upload-host>/api/health"
```

依服務 contract 驗證：

| 檢查 | 預期 |
| ---- | ---- |
| GET／HEAD | 正常讀取；可快取內容後續為 HIT 或 REVALIDATED |
| Query string | 不使用 query 的 CDN contract 應在 edge 拒絕 |
| 非預期 method | 應在到達 R2 或 Worker 前拒絕 |
| Range | 不被 WAF 誤擋，依內容回 206 或正常可讀回應 |
| Private／download-only | 不成為可重複使用的 public cache HIT |
| Security Events | 可看到受控阻擋測試，且一般頁面沒有誤擋 |

每項 Dashboard 變更套用後立即執行最小驗證。全部完成後再觀察至少 24 小時與一週，確認 cache hit ratio、
R2 operations、Worker／D1 用量及 Security Events 沒有異常。

## 10. 事故處理的公開原則

- 先記錄告警時間、產品與用量斜率，再使用最小範圍的可逆 Block。
- 區分 R2 Custom Domain、Worker route、D1 與上傳寫入，不一次停掉所有服務。
- 優先停用或縮小規則；不要刪除 bucket、object、D1、Worker、DNS 或 Custom Domain configuration。
- `r2.dev` 應在平時保持 Disabled，避免事故時存在繞過 Custom Domain 的公開入口。
- 一次只恢復一層並立即驗證，事故結束後保留時間線、影響、費用與永久修正。
- 完整正式規則、門檻、告警收件者與緊急操作順序只保存在私人 Operations runbook。
