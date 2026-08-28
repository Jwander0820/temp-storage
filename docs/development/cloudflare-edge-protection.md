# Cloudflare CDN 邊緣防護與成本設定

> 狀態：現行操作手冊
> 最後更新：2026-08-28
> 適用範圍：`cdn.jwander.net/temp-storage/objects/*`
> 正式套用狀態：待在 Cloudflare Dashboard 設定並驗證

本文件提供可在 Cloudflare Dashboard 直接操作的基準設定，目的為降低公開 R2 Custom Domain 遭到
cache-busting、非預期 method 或大量 cache miss 濫用時的 Class B 成本。免費額度換算與整體成本模型見
[`../reference/cloudflare-free-tier-and-cost.md`](../reference/cloudflare-free-tier-and-cost.md)。

Cloudflare Dashboard 名稱可能調整；若畫面與本文不同，以連結的官方文件為準。所有規則都必須同時限制
host 與 path prefix，因為 `cdn` bucket 也可能保存本專案以外的物件。

## 套用進度

這份文件與建議值已完成，但不代表規則已存在於正式 zone。實際完成後逐項勾選：

- [ ] `temp-storage CDN contract` WAF Custom Rule 已啟用並驗證。
- [ ] Cache Rule 已啟用，inline 與 `download_only` cache 行為符合預期。
- [ ] Smart Tiered Cache 已啟用。
- [ ] Free Rate Limiting Rule 已依正常流量校正後啟用。
- [ ] US$1、US$5 Budget Alerts 已建立；若帳號不提供此功能，已記錄原因。
- [ ] `r2.dev` 已確認停用。
- [ ] `upload.jwander.net` 與 `cdn.jwander.net` 的 HTTP 都會轉址到 HTTPS。
- [ ] HSTS 已在不啟用 `includeSubDomains`／preload 的保守設定下驗證。
- [ ] 設定後 24 小時與一週的觀察已完成。

## 上線前確認

- `cdn.jwander.net` 已連接 R2 `cdn` bucket 的 Custom Domain。
- Public Development URL `r2.dev` 已停用。
- 本專案 object key 都位於 `temp-storage/objects/`。
- 實際 inline preview URL 不需要 query string；GET、HEAD 與 Range request 可正常工作。
- 準備一個可公開預覽的測試物件 URL，以及一個 `download_only` 物件供驗證。

R2 Custom Domain 才能使用 WAF 與 Cloudflare Cache；`r2.dev` 不提供同等控制。參考
[R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) 與
[R2 與 Cache 的互動](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)。

R2 公開網域目前不提供 bucket 根目錄 listing，因此沒有額外的「listing 開關」需要啟用或關閉；仍需
確認應用程式沒有自行暴露 `R2.list()` 結果，並保持 S3 API credentials 最小權限。

## 1. 建立 WAF contract rule

前往目標 zone 的 **Security rules**，選擇 **Create rule → Custom rules**。建立：

- Rule name：`temp-storage CDN contract`
- Expression：

```text
(http.host eq "cdn.jwander.net"
 and starts_with(http.request.uri.path, "/temp-storage/objects/")
 and (
   (not http.request.method in {"GET" "HEAD"})
   or http.request.uri.query ne ""
 ))
```

- Action：`Block`

這條規則只允許 GET／HEAD，並拒絕任何 query string。現行 object URL 不以 query 授權，因此阻擋 query
比單純把 query 從 cache key 忽略更安全，也能直接阻止 `?a=1`、`?a=2` 製造不同 cache key。

不要封鎖 `Range` header；圖片、音訊與影片預覽可能需要 Range。若未來真的需要 signed query parameter，
必須先重新設計 cache key 與授權模型，不可直接停用這條規則。

建立方式參考 [Create a custom rule](https://developers.cloudflare.com/waf/custom-rules/create-dashboard/)。Free
plan 可用規則數有限，這裡將 method 與 query contract 合併為一條。

## 2. 建立 Cache Rule

前往 **Caching → Cache Rules → Create rule**，建立：

- Rule name：`temp-storage inline preview cache`
- Match expression：

```text
(http.host eq "cdn.jwander.net"
 and starts_with(http.request.uri.path, "/temp-storage/objects/"))
```

- Cache eligibility：`Eligible for cache`
- Edge TTL：不要設定「忽略 origin Cache-Control」的固定 TTL。
- Browser TTL：保留 origin 設定。
- Cache key：維持預設；因為 WAF 已拒絕 query string，不需要另設 Ignore Query String。

本專案由 R2 object metadata 決定可否 cache：inline preview 回應應是 `public, max-age=3600`；
`download_only` 應是 `private, no-store`。Cache Rule 只把符合路徑的回應列為可快取候選，不能用 Edge TTL
強制覆蓋 `private` 或 `no-store`，否則可能把只應下載的內容錯誤公開快取。

設定說明參考 [Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)、
[Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/) 與
[Custom cache keys](https://developers.cloudflare.com/cache/how-to/cache-keys/)。

### 刪除後的 cache 注意事項

R2 刪除具有強一致性，但已快取在 Cloudflare edge 的舊內容可能保留到 TTL 到期。現行 inline preview
TTL 最長約一小時；若個案要求立刻失效，需在 Cloudflare Cache 中 purge 該 CDN 完整 URL。大量或日常刪除
仍應由網站管理頁執行，不能以 R2 Dashboard 刪檔或 cache purge 取代應用程式的 D1 生命週期更新。

參考 [R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/)。

## 3. 啟用 Smart Tiered Cache

前往 **Caching → Tiered Cache**：

1. 啟用 Tiered Cache。
2. Topology 選擇 `Smart Tiered Cache`。

這讓多個 edge location 的 miss 優先由 upper tier 共用，減少直接回源 R2 的 Class B operations。Free plan
可使用 Smart topology。設定方式參考
[Enable Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/)。

## 4. 建立唯一一條免費 Rate Limiting Rule

Free plan 只有一條 zone-level rate limiting rule，而且目前有以下限制：

- Rule expression 可使用 Path 與 Verified Bot，不能使用 Host 或 Method。
- Counting characteristic 固定為 IP。
- Counting period 為 10 秒。
- 不能排除 cached assets，因此 cache hit 也會計數。

若主要目標是避免 R2 Class B 帳單，仍可優先將唯一規則用於本專案專屬 path。先在
**Security Analytics** 觀察正常流量尖峰，再前往
**Security rules → Create rule → Rate limiting rules** 建立：

- Rule name：`temp-storage CDN origin request limit`
- Match expression：

```text
starts_with(http.request.uri.path, "/temp-storage/objects/")
```

- Counting characteristic：IP。
- Counting period：`10 seconds`。
- Baseline threshold：`50 requests / 10 seconds / IP`。
- Action：`Block`。
- Mitigation timeout：`10 seconds`。

`50/10s/IP` 是把原先每分鐘 300 次換算成 Free plan 可用週期後的起始值，不是通用安全常數。因為 Free
plan 會把 cache hit 也計入，影音 Range、多檔案並行載入、共享 NAT 與監控服務都有可能造成誤判。至少觀察
一週 Security Events；若有誤判先停用 rate rule，再提高到 75 或 100 requests／10 秒。不要對圖片或影片
子資源使用 Managed Challenge，因為 `<img>`／`<video>` 無法可靠完成互動挑戰。

Rate Limiting expression 無法限制 Host 是 Free plan 的能力限制；本專案的
`/temp-storage/objects/` 是 R2 專用 path，不應在 `upload.jwander.net` 出現。Host、Method 與 query contract
仍由上一節的 WAF Custom Rule 精確限制。

設定與方案限制參考 [Create a rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)、
[Rate limiting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) 與
[Find the correct rate limit](https://developers.cloudflare.com/waf/rate-limiting-rules/find-rate-limit/)。

## 5. 開啟 Managed WAF 與 DDoS 基線

在 **Security** 確認：

- Free Managed Ruleset 已啟用。
- HTTP DDoS protection 沒有被自訂規則繞過。
- Security Events 可看到上述 custom rule 與 rate limiting rule 的命中。

Cloudflare 自動 DDoS 防護不能取代 rate limit：格式正常且成功讀取大量公開 object 的濫用，未必會被辨識
為 DDoS。Free plan 規則數與能力參考 [WAF overview](https://developers.cloudflare.com/waf/)。

## 6. 強制 HTTPS 並保守啟用 HSTS

先確認 `https://upload.jwander.net` 與 `https://cdn.jwander.net` 的憑證、預覽、下載及 Range request 都
正常，再處理 HTTP 轉址：

- 若 `jwander.net` zone 的所有 host 都支援 HTTPS，可在 **SSL/TLS → Edge Certificates** 開啟
  **Always Use HTTPS**。
- 若仍有其他 HTTP-only host，不要開啟 zone-wide 選項；改用 Redirect Rule 只涵蓋
  `upload.jwander.net` 與 `cdn.jwander.net`。

HTTP 轉址穩定後才啟用 HSTS。Cloudflare Dashboard 的 HSTS 設定是 zone 層級，會在該 zone 的 HTTPS
回應送出 header；只有所有 `jwander.net` host 都已完成 HTTPS 盤點，且不會暫停 Cloudflare 或改回 DNS
only 時，才使用 **SSL/TLS → Edge Certificates → HSTS**。初始建議：

- Max Age：1 個月。
- `includeSubDomains`：Off。
- Preload：Off。

若只準備好本服務的兩個 hostname，改在 **Rules → Transform Rules → Modify Response Header** 建立一條
hostname-scoped 規則：

```text
http.host in {"upload.jwander.net" "cdn.jwander.net"}
```

使用 **Set static** 設定 `Strict-Transport-Security: max-age=2592000`。這個值不含
`includeSubDomains`／preload，不會把未盤點的其他 host 納入。至少觀察一個 Max Age 週期，並確認不會
停用 Cloudflare、HTTPS、R2 Custom Domain 或有效憑證，再評估延長 Max Age。未完整盤點所有子網域前，
不啟用 `includeSubDomains` 或 preload，避免其他服務被瀏覽器長期鎖死。

參考 [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
、[HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)
與 [Response Header Transform Rules](https://developers.cloudflare.com/rules/transform/response-header-modification/)。

## 7. 建立低額 Budget Alerts

前往 account-level **Manage Account → Billing → Billable Usage → Create budget alert**，至少建立：

| Alert | 用途                                          |
| ----: | --------------------------------------------- |
|  US$1 | 早期通知，收到後當天檢查 R2 Class A／B 與流量 |
|  US$5 | 事件升級，依下方緊急應變決定是否封鎖 CDN      |

通知對象至少包含日常可立即處理事件的信箱。Budget Alert 只提供給 Pay-as-you-go 帳號；若 Dashboard
沒有此選項，先確認 R2 subscription 與 billing profile。Alert 只有通知效果，不是 hard cap，也不會自動
停用 R2 或 Custom Domain；用量資料按日處理，通知可能在超過門檻的隔天才到達。

設定方式參考 [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) 與
[Billing changelog](https://developers.cloudflare.com/changelog/product/billing/)。

## 8. 驗證

將 `$testUrl` 換成一個 inline preview 的完整 CDN URL，在 PowerShell 執行：

```powershell
$testUrl = "https://cdn.jwander.net/temp-storage/objects/<test-object-key>"
curl.exe -I $testUrl
curl.exe -I $testUrl
curl.exe -I "$testUrl?cache-bust=1"
curl.exe -I -X POST $testUrl
curl.exe -I -H "Range: bytes=0-1023" $testUrl
curl.exe -I http://upload.jwander.net/api/health
curl.exe -I https://upload.jwander.net/api/health
curl.exe -I http://cdn.jwander.net/temp-storage/objects/<test-object-key>
```

預期結果：

| 檢查                     | 預期                                                      |
| ------------------------ | --------------------------------------------------------- |
| 第一次與第二次 GET／HEAD | inline 物件由 `MISS` 轉為 `HIT` 或 `REVALIDATED`          |
| 帶 query string          | Cloudflare edge 回 `403`，不應到 R2                       |
| POST                     | Cloudflare edge 回 `403`                                  |
| Range                    | 不被 WAF 阻擋；依物件與 cache 狀態回 `206` 或正常可讀回應 |
| `download_only`          | 不應出現可重複使用的 public cache `HIT`                   |
| HTTP upload/CDN URL      | 轉址到相同 host 的 HTTPS URL                              |
| HTTPS upload/CDN URL     | HSTS 啟用後包含預期的 `Strict-Transport-Security` header  |

另外在 Dashboard 檢查 Security Events、Cache Analytics 與 R2 Class B 指標。設定後 24 小時及一週各檢查一次，
確認沒有合法流量誤判，也沒有大量 query 或 Range cache miss。

## 9. 誤判與緊急應變

### 合法流量被擋

1. 先停用 rate limiting rule，保留 method／query contract rule。
2. 從 Security Events 確認命中 path、IP 聚合與 Range 行為。
3. 提高 threshold 後重新啟用；Free plan 不能改用其他 counting characteristic。
4. 只有確認前端真的使用 query string 時，才修改 query contract。

R2 Class B、Workers、D1 或帳單異常上升時，依
[`cloudflare-cost-incident-response.md`](./cloudflare-cost-incident-response.md) 執行。該文件包含可直接複製的
CDN／Worker 緊急 WAF expressions、R2 Custom Domain 暫停步驟、`UPLOADS_ENABLED` 的能力邊界與恢復順序。
