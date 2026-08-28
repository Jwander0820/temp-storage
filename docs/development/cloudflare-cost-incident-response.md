# Cloudflare 帳單與用量異常緊急應變

> 狀態：現行事件應變手冊
> 最後更新：2026-08-28
> 適用範圍：Workers、D1、R2、Cloudflare Cache 與 WAF
> 執行權限：只有 Cloudflare 帳號管理員可操作正式環境

這份 runbook 用於 Cloudflare 帳單、R2 operations、Workers requests 或 D1 rows 突然上升時，先用可逆
操作停止成本繼續擴大，再調查原因。免費額度與成本換算見
[`../reference/cloudflare-free-tier-and-cost.md`](../reference/cloudflare-free-tier-and-cost.md)，平時防護設定見
[`cloudflare-edge-protection.md`](./cloudflare-edge-protection.md)。

## 必先知道的界線

- Budget Alert 只寄信，不會暫停服務或限制費用，而且用量按日處理，可能隔天才通知。
- Workers Free 與 D1 Free 達到免費額度時主要是服務失敗；本專案最需要主動切斷的帳單風險是 R2
  pay-as-you-go operations 與超過免費量的儲存。
- WAF Custom Rule 的 Block 是終止動作；符合規則的要求不會繼續進入後續安全、cache 或 origin 階段。
- 停用 R2 Custom Domain 只關閉該 domain 的公開存取，不會刪除 bucket 或物件，也不會阻止 Worker
  透過 R2 binding 讀寫。
- `UPLOADS_ENABLED=false` 只拒絕新的 reservation；已建立的 reservation 在到期前仍可能完成 PUT，且
  已知 CDN URL 與 Worker `/d/:fileId` 仍可讀取。
- WAF 不影響 Worker scheduled trigger。每小時 cleanup 與每日 reconciliation 仍會執行。

官方依據：

- [R2 disable domain access](https://developers.cloudflare.com/r2/buckets/public-buckets/#disable-domain-access)
- [WAF security feature execution](https://developers.cloudflare.com/waf/feature-interoperability/)
- [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [Billing alert processing delay](https://developers.cloudflare.com/changelog/product/billing/)

## 事前準備

事故發生前完成，才能在數分鐘內止血：

1. 建立 US$1 與 US$5 Budget Alerts；Pay-as-you-go 帳號若已有預設 US$10 alert，仍增加較低門檻。
2. 確認 `r2.dev` 為 Disabled，避免停用 Custom Domain 後仍能從另一公開入口讀取。
3. 確認至少保留兩個 WAF Custom Rule slots，供 CDN 與 Worker 緊急規則使用。Free plan 共有五條。
4. 把本頁加入瀏覽器書籤，並確認管理員能登入 Cloudflare Dashboard 與 billing email。
5. 每月記錄正常 Workers、D1、R2 Class A／B 與 cache hit ratio，事故時才有比較基準。
6. 不在 runbook、ticket、聊天或 screenshot 中貼出 token、Cookie、invitation URL 或 object key。

可以預先建立下列規則並保持 Disabled；Disabled rule 仍可能占用方案規則數，需納入五條上限。

## 五分鐘止血流程

| 優先 | 動作                                        | 影響                                            |
| ---- | ------------------------------------------- | ----------------------------------------------- |
| 1    | 記錄告警時間、金額與當下各產品用量          | 不改變服務                                      |
| 2    | 啟用對應的 WAF 緊急 Block                   | 立即阻斷指定入口，使用者會看到 Cloudflare block |
| 3    | 若為 R2 直接流量，Disable `cdn.jwander.net` | 所有 CDN preview 中止；bucket 與物件保留        |
| 4    | 若為寫入攻擊，設定 `UPLOADS_ENABLED=false`  | 停止新 reservation；既有 reservation 仍需 WAF   |
| 5    | 觀察最新 metrics，確認曲線停止上升          | Dashboard 指標可能有延遲                        |

不要先花時間追查單一 IP。先切斷正在產生成本的產品入口，再保存證據與分析來源。

## 1. 判斷是哪個產品上升

前往 **Manage Account → Billing → Billable Usage**，記錄本期累積費用與產品，再交叉檢查：

| 異常指標                   | 可能來源                                       | 第一個動作                    |
| -------------------------- | ---------------------------------------------- | ----------------------------- |
| R2 Class B／GET／HEAD 上升 | CDN cache miss、query busting、Worker download | 啟用 CDN 或 media-read Block  |
| R2 Class A／PUT 上升       | 上傳濫用、異常 reconciliation                  | 停新上傳並封鎖 upload PUT     |
| Workers requests 上升      | API、靜態頁、`/d/` 或掃描                      | 啟用 route-specific WAF Block |
| D1 rows read 上升          | invitation session、檔案清單、公開 metadata    | 封鎖對應 Worker path          |
| D1 rows written 上升       | reservation、session、cleanup                  | 停新上傳／邀請交換            |
| R2 storage 上升            | 大量成功上傳或同帳號其他 bucket                | 停新上傳，確認 bucket 分布    |

查看位置：**Security → Events／Analytics**、Worker Metrics、D1 Metrics、R2 Metrics、Cache Analytics。
不要只看 HTTP request 數；大量 cache hit 不一定增加 R2 Class B，而 `/d/` 的每次成功讀取會經 Worker 查 D1
並存取 R2。

## 2. R2 直接 CDN 讀取止血

在 zone 的 **Security rules → Custom rules** 啟用或建立：

- Rule name：`EMERGENCY - block temp storage CDN`
- Expression：

```text
(http.host eq "cdn.jwander.net"
 and starts_with(http.request.uri.path, "/temp-storage/objects/"))
```

- Action：`Block`

這會讓本專案所有 inline preview 立即不可用，但不影響 `cdn` bucket 的其他 prefix。若啟用後 R2 Class B
仍持續上升，可能是 Worker `/d/`、另一個 domain、`r2.dev` 或同帳號其他服務，不要直接假設規則失效。

### 停用 R2 Custom Domain

若直接 CDN 流量仍無法控制：

1. 前往 **R2 Object Storage → `cdn` bucket → Settings → Custom Domains**。
2. 在 `cdn.jwander.net` 右側選擇 **… → Disable domain**。
3. 確認 Access to Bucket 顯示 `Not allowed`。
4. 再確認 Public Development URL `r2.dev` 仍為 Disabled。

優先使用 **Disable domain**，不要選 **Remove domain**。Disable 保留連接設定，事件後可直接恢復；Remove
會移除 custom-domain configuration 與對應 DNS。兩者都不會阻止 Worker 的 R2 binding。

## 3. Worker 經 R2 讀寫止血

### 只封鎖 R2 讀取與 PUT

希望保留首頁、管理頁、health 與檔案清單時，建立：

- Rule name：`EMERGENCY - block Worker R2 operations`
- Expression：

```text
(http.host eq "upload.jwander.net"
 and (
   starts_with(http.request.uri.path, "/d/")
   or starts_with(http.request.uri.path, "/p/")
   or (
     http.request.method eq "PUT"
     and starts_with(http.request.uri.path, "/api/uploads/")
   )
 ))
```

- Action：`Block`

影響是所有 Worker download、fallback preview 與已取得 reservation 的檔案 PUT 暫停。檔案列表與管理頁
仍可開啟，方便確認狀態。

### 暫停新上傳

將 Worker variable `UPLOADS_ENABLED` 改為 `false` 並部署後，新 reservation 會被拒絕。這不是立即 R2
kill switch；若需立刻阻止既有 reservation 上傳，必須同時啟用上一條 PUT Block。事故後把設定改回
`true` 時也需要重新部署。

### 暫停所有 Worker 對外流量

若 Workers requests 或 D1 rows 持續暴增，建立最後手段：

- Rule name：`EMERGENCY - block upload Worker`
- Expression：

```text
http.host eq "upload.jwander.net"
```

- Action：`Block`

這是可逆的「對外暫停」：首頁、邀請、下載、API、管理頁與 health 全部被擋，但不用刪 Worker 或資料。
WAF Block 在 Worker／origin 前終止請求，因此比刪除 Worker Custom Domain 更快恢復。規則啟用後無法透過
網站管理頁操作，只能從 Cloudflare Dashboard 復原。

只有 WAF 無法控制時，才考慮在 **Workers & Pages → `jwander-temp-storage` → Settings → Domains & Routes**
移除 `upload.jwander.net` Custom Domain。`wrangler.jsonc` 仍宣告此 domain，下一次部署可能重新建立；因此
這不是首選，也不要刪除 Worker。

## 4. 邀請或單一路徑濫用

若來源集中在單一 invitation：

1. 從管理頁撤銷 invitation，讓 invitation sessions 失效。
2. 必要時為正常使用者重新簽發不同 invitation。
3. 若管理頁已被全站 WAF 擋住，先在 Dashboard 將全站規則縮小到攻擊 path，再撤銷 invitation。

撤銷 invitation 無法撤回已知的直接 CDN URL；直接 R2 流量仍需 CDN WAF 或 Disable domain。

## 5. 確認已止血

完成阻擋後記錄：

- 緊急規則名稱、啟用時間、操作者與 expression。
- `cdn.jwander.net` 測試 URL 是否回 Cloudflare block／無法存取。
- `upload.jwander.net/api/health` 是否依預期保留或被全站阻擋。
- Workers requests、D1 rows、R2 Class A／B 是否在 Dashboard 可見的最新時間點停止異常成長。
- 是否仍存在 `r2.dev`、其他 R2 Custom Domain、Workers routes 或同帳號其他 bucket 流量。

Cloudflare metrics 與 billing 資料可能延遲。不要因短時間仍看到累積數字就反覆刪除或重建資源；比較新的
時間區間與斜率，並確認 Security Events 的 Block 命中。

## 6. 恢復順序

根因確認並補上永久防護後，一次只恢復一層：

1. 保留 query／method contract WAF，先停用臨時的全站 Worker Block。
2. 若曾 Disable `cdn.jwander.net`，重新 Enable domain，等待狀態 Active。
3. 保持 uploads disabled，先驗證首頁、邀請交換、檔案清單、單一 preview 與單一 download。
4. 停用 `EMERGENCY - block Worker R2 operations`，以受控測試檔驗證 GET／HEAD／Range。
5. 將 `UPLOADS_ENABLED=true` 並部署，再進行一筆小檔案上傳。
6. 保留緊急規則為 Disabled，觀察至少 24 小時後才結案。
7. 記錄實際費用、來源、時間線、誤判與永久修正；必要時調整本 runbook。

若曾刪除而非停用 Custom Domain，需重新連接 domain、確認 DNS 與 TLS Active，不能只關閉 WAF 規則。

## 禁止事項

- 不要刪除 R2 bucket、D1 database、Worker 或正式資料來止血。
- 不要直接從 R2 Dashboard 刪除 `temp-storage/objects/`；這會讓 D1 metadata 失去一致性。
- 不要關閉 Cloudflare proxy 或使用 Pause Cloudflare；這可能繞過 WAF／cache，且 Worker/R2 origin 架構未必能正常服務。
- 不要把 Budget Alert 當 hard cap，也不要等待下一封通知才採取行動。
- 不要在事故中臨時升級 Paid plan，除非已理解新的 overage 與月費責任。
- 不要封鎖整個 `cdn` bucket 的其他 prefix，除非已確認它們也在事件範圍內。

## 事件紀錄模板

```text
開始時間（Asia/Taipei）：
告警來源與金額：
異常產品／指標：
初始速率與正常基準：
啟用的 WAF 規則：
是否停用 R2 Custom Domain：
是否設定 UPLOADS_ENABLED=false：
止血確認時間：
影響功能：
根因：
恢復時間與順序：
最終費用：
永久修正：
```
