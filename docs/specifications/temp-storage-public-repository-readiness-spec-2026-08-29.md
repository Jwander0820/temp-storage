# temp-storage 公開儲存庫準備與安全強化規格計畫書

> 文件版本：1.2
> 審查日期：2026-08-29
> 實作進度更新：2026-08-30
> 審查對象：[Jwander0820/temp-storage](https://github.com/Jwander0820/temp-storage)
> 基準分支：main
> 基準 commit：[6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d](https://github.com/Jwander0820/temp-storage/commit/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d)
> 文件性質：公開準備規格、執行紀錄與後續監測清單

## 0. 實作進度（2026-08-30）

本節覆蓋下方 2026-08-29 唯讀盤點中的舊狀態；原始發現保留作為決策與驗收依據。

| 項目                             | 目前狀態 | 證據／待辦                                                                                                         |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| F-01 上傳提交狀態機              | 已修正   | commit 前後失敗與 blocked type 回歸測試通過                                                                        |
| F-02 cleanup fatal path          | 已修正   | fatal run 終結、finalization 失敗保留根因測試通過                                                                  |
| F-03 Turnstile local-only        | 已修正   | 非 local origin 與錯誤 secret 均在 Siteverify 前 fail closed                                                       |
| F-04 CSP                         | 部分完成 | public URL origin/path allowlist 已完成；enforced header 仍等待 production 觀察或 owner 限期風險接受               |
| F-05 bindings／required secrets  | 已修正   | `secrets.required`、generated Env、optional supplement 與 `workers_dev: false` 已同步                              |
| F-06 CI／branch protection       | 已完成   | PR #1 與 merge commit 的 GitHub Actions 全綠；`main` 已要求 PR、`check` 與 conversation resolution                 |
| F-07 Cloudflare production state | 已驗證   | 正式 deployment、D1 migration、Access 與 edge baseline 已核對；規則門檻與告警細節只記錄於私人 Operations 筆記      |
| F-08 前端 URL                    | 已修正   | download 與 preview scheme/origin/path/query 回歸測試通過                                                          |
| F-09 reconciliation budget       | 已修正   | migration `0011` 保存 phase/cursor，超過單次頁數預算可跨 invocation 續跑                                           |
| F-10 公開治理                    | 已完成   | CI、SECURITY、CONTRIBUTING 與 README self-host／產品限制已新增，並已透過 `develop` 的 PR #1 驗證                   |
| 公開候選驗證                     | 已通過   | 本機與 GitHub Actions 的 `pnpm check` 全綠；production audit、CodeQL、Secret Scanning 與 Dependabot 無 open alerts |

使用者已明確決定保留既有 Git history，並已授權及完成 PR #1 合併、Cloudflare 自動 migration／deployment 與 repository 公開。未執行 history rewrite、手動重複 deployment 或例行 pepper 輪替。

## 1. 決策摘要

### 1.1 建議結論

**已依「修正後公開」方案完成 repository 公開。**

本專案的架構、安全邊界、測試密度、文件完整度與 MIT 授權，已具備公開專案的良好基礎。重新檢視目前 main 與完整 Git 歷史後，沒有發現真實憑證、私鑰、個資或必須清洗歷史的內容。Cloudflare D1 UUID、R2 bucket 名稱、Worker 名稱、正式網域與 Turnstile site key 都屬識別資訊，不是可直接取得帳號權限的秘密。

P0 資料一致性、部署與治理缺口已修正，候選 commit、merge commit、Cloudflare deployment 與公開後安全掃描均有全綠證據。後續工作改為 CSP 觀察與 T+24h／T+7 日監測，不再視為阻擋 repository 公開的前置缺口。

### 1.2 建議時程

| 階段                     |    實作工時估計 | 必要觀察時間 | 公開狀態     |
| ------------------------ | --------------: | -----------: | ------------ |
| P0 正確性與設定閘門      |    1–2 個開發日 |           無 | 維持 Private |
| P1 CI、治理與文件        |  0.5–1 個開發日 |           無 | 維持 Private |
| P2 Cloudflare 驗證與 CSP | 約 0.5 個開發日 |    建議 7 日 | 維持 Private |
| P3 公開與上線後驗證      | 約 0.5 個開發日 |  公開後 7 日 | 切換 Public  |

總工作量約 2–4 個開發日；若依既有部署文件先觀察 CSP，再改為強制政策，建議保留 7 日曆日的觀察窗。

### 1.3 公開前不可妥協條件

1. 修正上傳完成後的 R2／D1 回滾狀態錯置。
2. 候選 commit 的 pnpm check 在 GitHub Actions 全綠。
3. Turnstile 測試模式在非本機 origin 必須 fail closed。
4. Cloudflare Access、CDN WAF／Cache／Rate Limit、r2.dev、HTTPS、Cron 與 D1 migration 狀態均有實際驗證紀錄。
5. 建立 SECURITY.md，並在公開後立即啟用 branch protection、secret scanning、push protection 與 Dependabot。
6. 公開動作由使用者明確確認後人工執行；Codex 不得自行切換 visibility、部署、套用正式 migration 或輪替秘密。

## 2. 審查範圍與限制

### 2.1 已完成的審查

- 重新確認 main 最新 commit 與上次審查相同，沒有新增未審查內容。
- 檢視完整 recursive tree：126 個 blob，其中 113 個可讀文字檔。
- 檢視 48 個 TypeScript 原始碼檔、14 個測試檔、10 個 D1 migration、20 個 Markdown 文件，以及 Wrangler、Vite、Vitest、ESLint、pnpm 設定。
- 重新比對 23 個 commit、344 個歷史文字 blob 的秘密與個資掃描結果；因 HEAD 與 tree SHA 未變，歷史結果仍是位元組相同。
- 審查 Worker request lifecycle、邀請與管理員權限、session、quota、D1／R2 一致性、清理排程、前端 DOM sink、Cloudflare routing 與邊緣防護文件。
- 檢查 GitHub branches、Actions、commit status、PR、issue、release、ruleset 與 branch protection 狀態。
- 依 Cloudflare Workers 官方最佳實務重新檢查 compatibility date、binding 型別、secret 管理、串流、非同步工作、全域狀態與 workers.dev 邊界。

### 2.2 無法由本次唯讀審查直接驗證

- 無法登入 Cloudflare Dashboard 核對使用者表示已完成的部分防護，因此本文件不把現有文件中的未勾選項目視為「確定未設定」，而是視為「尚未留下可驗證紀錄」。
- GitHub connector 無法讀取此 private repository 的 Dependabot 與 secret-scanning alerts；需在 GitHub UI 或公開後的 Security 頁籤確認。
- 原始碼是透過 GitHub connector 唯讀取得，未在本機 checkout 執行 pnpm install、pnpm check 或瀏覽器端 E2E；目前只能確認測試與檢查腳本存在，不能把它們宣稱為本次獨立執行通過。
- 未做第三方滲透測試、惡意檔案沙箱掃描或 Cloudflare 帳單壓力測試。

## 3. 現況盤點

| 面向            | 現況                                                          | 判定                  |
| --------------- | ------------------------------------------------------------- | --------------------- |
| Repository      | Private；default branch 為 main                               | 待完成公開閘門        |
| Branch          | main、develop 指向同一 commit；兩者皆未受保護                 | 公開後需治理          |
| CI              | 無 .github/workflows；HEAD 無 status check                    | P0／P1 缺口           |
| Release         | 無 GitHub Release                                             | 可於公開時建立 v0.1.0 |
| 授權            | MIT LICENSE 已存在                                            | 可公開                |
| Runtime         | Cloudflare Workers + Hono + Static Assets                     | 架構合適              |
| Storage         | D1 metadata／quota；R2 object                                 | 邊界清楚              |
| 測試            | 14 個測試檔；pnpm check 串接 types、lint、test、dry-run build | 良好但缺 CI 證據      |
| Secrets         | runtime secrets 未進版控；範例值為 placeholder／官方測試值    | 未見洩漏              |
| CSP             | 僅 Content-Security-Policy-Report-Only                        | 需完成觀察與強制化    |
| Cloudflare 防護 | 文件完整，但 production state 記錄仍顯示待驗證                | 需和 Dashboard 同步   |
| 文件            | README、架構、API、部署、成本與事件應變文件齊全               | 公開基礎良好          |

## 4. 已確認的安全優點

以下項目不需因 repository 公開而重做：

- 邀請 token 使用 URL fragment，交換後立即從網址移除，改用 HttpOnly session。
- Admin 採 Cloudflare Access、Turnstile、獨立高熵 ADMIN_TOKEN 與短期 admin session 的分層邊界。
- invitation token、delete token 與 file ID 皆使用密碼學安全亂數；敏感比對使用 timing-safe 流程。
- mutation 具 same-origin 防護，沒有 wildcard CORS。
- 上傳請求具有 body size、檔案大小、配額、頻率與 session 權限限制。
- 檔案類型同時檢查副檔名、宣告 MIME 與內容 signature，主動內容類型採 fail closed。
- R2 object 僅在 temp-storage/objects/ prefix 下操作。
- R2 put 與下載路徑採串流處理，未發現把大型 request body 整體載入記憶體的反模式。
- Worker 模組未發現跨 request 的可變全域狀態、Math.random、passThroughOnException 或未處理的 fetch promise。
- SQL 動態片段來自受控常數或已驗證數值，未發現可由輸入形成的 SQL injection。
- 前端使用者資料主要透過 textContent 輸出；兩處 innerHTML 僅寫入固定載入提示。
- Admin token 未寫入 localStorage；localStorage 只保存主題偏好。
- 公開 URL 是高熵 capability URL，屬產品設計，不是意外的授權繞過。

## 5. 秘密與公開資訊判定

### 5.1 掃描結論

目前分支與 Git 歷史未發現：

- 私鑰或憑證內容。
- GitHub、AWS、Slack、Cloudflare 等可用 access token。
- 可用 JWT、Bearer token、管理員 token、pepper 或 Turnstile secret。
- 個人 email、帳單資料、IP 名單或 Cloudflare account ID。
- 被提交的 .dev.vars 或 .env。

掃描命中的 Turnstile 官方測試值與測試程式中的無效字串不是 production secret。

### 5.2 可保留在公開 repository 的識別資訊

| 資訊                                | 是否秘密               | 建議                                 |
| ----------------------------------- | ---------------------- | ------------------------------------ |
| upload.jwander.net、cdn.jwander.net | 否                     | 可保留                               |
| Worker 名稱 jwander-temp-storage    | 否                     | 可保留                               |
| R2 bucket 名稱 cdn                  | 否                     | 可保留，但文件應提醒 fork 必須替換   |
| D1 database UUID                    | 否，不提供資料庫存取權 | 可保留；公開部署指南需標示為作者環境 |
| Turnstile site key                  | 否，設計上會送到瀏覽器 | 可保留                               |
| Rate-limit namespace IDs            | 否                     | 可保留；fork 必須重建                |
| WAF rule 名稱與基準門檻             | 否                     | 可保留；不要依賴規則隱藏作為安全措施 |

### 5.3 不需要做的事

- 不需要改寫 Git 歷史。
- 不需要只因 repository 公開就重建 D1 或 R2。
- 不需要例行輪替 DELETE_TOKEN_PEPPER 或 IP_HASH_PEPPER；未發現它們外洩，盲目輪替會破壞既有 token／hash 的連續性。
- 不需要把 production domain 或 D1 UUID 誤當成 secret。

### 5.4 建議的憑證邊界動作

- 公開前可預防性輪替 ADMIN_TOKEN，並明確接受既有 admin session 失效。
- 若 Cloudflare Workers Builds API token 曾被貼入非秘密變數、文件、issue 或聊天，才需要輪替；本次 repository 掃描沒有發現它。
- TURNSTILE_SECRET_KEY 沒有外洩證據，輪替屬選用。
- 任何 pepper 輪替都必須另立 migration／強制失效計畫，不納入本次公開前例行工作。

## 6. 發現與優先級

| ID   | 嚴重度 | 發現                                                                                  | 影響                                                  | 公開前處理     |
| ---- | ------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| F-01 | 高     | D1 已完成上傳提交後，後續錯誤仍可能刪除 R2 object                                     | 形成 active metadata 指向不存在物件，配額仍占用       | 必須           |
| F-02 | 中     | cleanup 在頂層失敗時可能讓 cleanup_runs 永久停在 running                              | 清理可觀測性失真，歷史紀錄無法依規則清除              | 建議同批完成   |
| F-03 | 中     | 官方 Turnstile 測試 secret 未限制為本機 origin                                        | 正式環境誤設時會略過 hostname／action 驗證            | 必須           |
| F-04 | 中     | CSP 仍為 Report-Only                                                                  | 若未來出現前端注入，瀏覽器不會強制攔截                | 完成觀察後強制 |
| F-05 | 中     | secret binding 型別同時由生成 Env 與手寫介面維護，且 wrangler 未宣告 required secrets | CI／本機型別可能因 .dev.vars 狀態漂移                 | 必須           |
| F-06 | 中     | 無 GitHub Actions，main／develop 都未保護                                             | 無法證明公開候選 commit 通過檢查，也容易直接推壞 main | 必須           |
| F-07 | 中     | Cloudflare production state 文件落後於實際 Dashboard                                  | 不能證明 Access、CDN 與成本防護真的生效               | 必須人工核對   |
| F-08 | 低     | 前端只驗證 previewUrl／downloadUrl 是字串，未驗證 origin／path                        | API 或供應鏈被攻陷時增加任意導向與載入面              | 公開後第一批   |
| F-09 | 低     | reconciliation 會在單次 scheduled invocation 跑完所有分頁                             | 資料量成長或 fork 到大型 bucket 時可能超出執行預算    | P2             |
| F-10 | 低     | 公開專案治理文件不足，production config 可攜性說明不足                                | 外部回報、貢獻與 fork 容易誤用作者資源名稱            | P1             |

## 7. 詳細規格

### PR-01：修正上傳提交後的狀態機

**對應發現：F-01**
**目標檔案：** [src/routes/uploads.ts L189–269](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/routes/uploads.ts#L189-L269)、upload repository 與相關測試。

#### 現況

objectStored 在 R2 put 成功後變成 true。completeUpload 完成 D1 提交後，程式仍會再讀取 active record 與組裝回應。這些後提交步驟任一失敗時，catch 仍因 objectStored 為 true 而刪除 R2 object；releaseReservation 對已 consumed 的 reservation 又不會反向修正 active metadata 與 used bytes。

#### 必要行為

1. 明確區分至少三個階段：reservation claimed、object stored、ledger committed。
2. completeUpload 成功後立即標記 ledgerCommitted，不得讓一般 rollback 路徑再刪除該 object。
3. 最佳方案是讓 completeUpload 回傳完成後的 active record，移除提交後的額外 getUploadRecord。
4. 若提交後仍發生無法避免的錯誤：
   - 不刪除 R2 object。
   - 不把已 consumed reservation 改回 cancelled。
   - 記錄 upload.post_commit_failed 類型的結構化事件。
   - 讓 reconciliation 可以安全收斂真正的孤兒或缺件狀態。
5. 被檔案政策阻擋的預期 DomainError 不應被重複 release，也不應記成泛化的 upload.failed error。
6. 不變更對外 API schema，除非另開版本化規格。

#### 驗收測試

- R2 put 失敗：reservation 釋放，D1 不成為 active。
- size mismatch：R2 object 刪除，reservation 釋放。
- completeUpload 失敗：R2 object 刪除，reservation 釋放。
- completeUpload 已成功、後續讀取或序列化失敗：R2 object 不刪除、D1 維持 active、配額一致。
- blocked type：只執行一次取消，log 等級與事件名稱符合預期。
- 正常上傳：公開 metadata、delete token、preview policy 與現有行為不變。
- 完整 pnpm check 通過。

### PR-02：讓 cleanup run 必定終結

**對應發現：F-02、F-09**
**目標檔案：** [src/services/cleanup-service.ts L64–184](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/services/cleanup-service.ts#L64-L184) 與 [L193–260](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/services/cleanup-service.ts#L193-L260)。

#### 必要行為

1. cleanup_runs 建立後，整個執行流程使用頂層 try／catch／finally 或等價狀態機。
2. 非單檔級的 fatal error 發生時，以最佳努力將該 run 更新為 failed，寫入實際 finished_at。
3. 更新 failed 狀態失敗時，保留原始例外，不以記錄失敗覆蓋根因；另送出結構化 log。
4. completed／partial／failed 的定義寫入測試與文件。
5. finished_at 使用流程真正結束時間，不沿用 started_at。
6. reconciliation 加入單次 invocation 的頁數或時間預算；到達預算時輸出 cursor／continuation 狀態，不能沉默截斷。
7. 不得放寬 temp-storage/objects/ prefix 邊界。

#### 驗收測試

- reservation 清理、單檔刪除與 metadata purge 的局部失敗能形成 partial／failed。
- purge 查詢或 D1 頂層錯誤後，cleanup_runs 不停在 running。
- failure-finalization 再失敗時仍拋出原始錯誤並留下可搜尋 log。
- reconciliation 游標不前進時維持 fail closed。
- 大於單次 budget 的資料會留下可安全續跑狀態，不漏刪也不跨 prefix。

### PR-03：固定 Cloudflare secret 與本機測試邊界

**對應發現：F-03、F-05**
**目標檔案：** [wrangler.jsonc](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/wrangler.jsonc)、[src/bindings.ts](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/bindings.ts)、[src/services/turnstile-service.ts](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/services/turnstile-service.ts)、src/env.ts 與測試。

#### 必要行為

1. 在 Wrangler 設定加入 secrets.required，至少包含：
   - TURNSTILE_SECRET_KEY
   - DELETE_TOKEN_PEPPER
   - IP_HASH_PEPPER
   - ADMIN_TOKEN
2. UPLOAD_ACCESS_CODE 保持選用，不得因 required 宣告而強迫所有部署啟用第二道密碼。
3. 官方 Turnstile 測試 secret 只允許 local development；UPLOAD_ORIGIN 為正式或任意非 localhost／127.0.0.1／::1 origin 時必須 fail closed。
4. 生成的 Env 是 Cloudflare binding 型別的唯一主要來源；移除 SecretBindings 對相同 required key 的重複宣告。
5. 若 Wrangler 對選用 binding 無法產生精確 optional type，只建立最小範圍的型別補充，不能再把所有 secret 手寫一次。
6. 明確加入 workers_dev: false。若目前 Wrangler schema 支援並符合部署策略，再顯式停用 preview URLs。
7. 重新執行 pnpm types，提交 src/worker-configuration.d.ts 的預期變更，再以 pnpm types:check 驗證無漂移。
8. 不得把任何 production secret 值加入 wrangler.jsonc、GitHub Actions、文件或 log。

#### 驗收測試

- official always-pass test secret + test mode + localhost：允許測試流程。
- official test secret + test mode + production origin：回 INTERNAL_ERROR 或等價 fail-closed 結果。
- production secret + 正確 hostname／action：通過。
- hostname 或 action 不符：拒絕。
- 缺少任一 required secret 時，local dev／deploy 在明確階段失敗。
- CI 不需要 production secret；只使用明示的無效測試值。

### PR-04：完成 CSP 強制化與前端 URL 邊界

**對應發現：F-04、F-08**
**目標檔案：** [src/middleware/security-headers.ts L5–33](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/src/middleware/security-headers.ts#L5-L33)、[public/app.ts L403–423](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/public/app.ts#L403-L423) 與相關文件。

#### 必要行為

1. 先維持現行 Report-Only 候選政策，完成首頁、邀請、檔案清單、上傳、圖片／影音預覽、Turnstile 與 admin 頁面的 production 驗證。
2. 至少觀察 7 日；每一項 violation 必須分類為必要來源、程式缺陷或瀏覽器 extension 噪音。
3. 無未解決的應用程式 violation 後，把 header 改為 Content-Security-Policy。
4. 不得為了消除 violation 加入 unsafe-inline、unsafe-eval、任意 https: 或 wildcard source。
5. parsePublicFile 應驗證：
   - downloadUrl 必須是預期 upload origin 與既定下載 path。
   - previewUrl 若非 null，必須是預期 CDN origin、HTTPS 與 temp-storage/objects/ prefix。
   - 違規 URL 使整筆 API payload fail closed，不直接綁到 src 或 href。
6. 持續以 textContent 輸出 filename、label 與 server error。

#### 驗收測試

- 所有正式操作路徑在 enforced CSP 下正常。
- Turnstile script、frame 與 verify 流程正常。
- 任意外部 previewUrl、javascript: URL、錯誤 path 與錯誤 origin 都被拒絕。
- CDN 圖片、影片、音訊與 Range request 正常。
- response 只有一個生效的 CSP，不同層級不互相覆蓋。

### PR-05：建立 CI 與公開專案治理

**對應發現：F-06、F-10**

#### GitHub Actions 規格

新增 .github/workflows/ci.yml：

- 觸發：pull_request 與 push 到 main。
- 使用 repository packageManager 指定的 pnpm 11.9.0。
- 啟用 dependency cache。
- 執行 pnpm install --frozen-lockfile。
- 執行 pnpm check。
- workflow permissions 僅 contents: read。
- 同一 branch 新 run 取消舊 run。
- 不載入 production secret，不部署，不套 remote migration。
- 若 build dry-run 需要 binding placeholder，只使用明確不可用於 production 的 CI 測試值。

#### Repository 檔案

1. SECURITY.md
   - 支援版本。
   - 使用 GitHub Private Vulnerability Reporting／Security Advisory 回報。
   - 請勿以公開 issue 張貼 token、可用檔案 URL 或漏洞細節。
   - 回應與修補時程使用合理目標，不做無法承諾的 SLA。
2. CONTRIBUTING.md
   - pnpm 版本、本機設定、pnpm check、commit convention、禁止提交 secret。
   - 不接受直接觸碰作者 production D1／R2／Cloudflare 帳號的 PR。
3. README.md
   - 清楚標示這是自架 temporary storage，不是 E2EE、永久備份、惡意程式掃描或合規儲存服務。
   - 說明 capability URL 知道連結即可讀取的設計。
   - 提供 author deployment 與 fork／self-host 的設定分界。
   - 提醒替換 D1 UUID、bucket、domain、Turnstile site key、rate-limit namespace。
4. 可選：CODEOWNERS、issue templates、pull request template。

#### 公開後 GitHub 設定

- main 禁止 force push 與 deletion。
- main 必須通過 CI status check。
- solo repository 不強制 1 人 approval；有外部 collaborator 後再要求 review。
- 啟用 secret scanning、push protection、Dependabot alerts 與 Dependabot security updates。
- 啟用 CodeQL default setup，或以 GitHub 建議的 TypeScript／JavaScript設定為準。
- 啟用 Private Vulnerability Reporting。
- develop 目前與 main 同 SHA；建議採 trunk-based main。若要刪除 develop，須先由使用者明確確認，不能由本規格自動執行。

### PR-06：同步 Cloudflare production state 與公開部署指南

**對應發現：F-07、F-10**
**目標檔案：** [docs/development/deployment.md](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/docs/development/deployment.md)、[docs/development/cloudflare-edge-protection.md](https://github.com/Jwander0820/temp-storage/blob/6fb2ebd86e9ecf20b4f9d398cc4fa0b88962be5d/docs/development/cloudflare-edge-protection.md)、README 與 docs index。

#### 原則

使用者已說明部分 Cloudflare 防護完成，因此實作者不得依現有未勾選 checklist 直接重建規則。先讀取 Dashboard 現況，將每項分類為：

- 已驗證：附最後驗證日期與實際結果。
- 已設定待驗證：規則存在，但尚未做 curl／瀏覽器／事件驗證。
- 未設定：列出實作步驟。
- 不適用：記錄理由。

公開文件可以保留規則名稱與安全設計，但不要放 Cloudflare account ID、API token、帳單信箱、真實使用者 email、內部截圖 URL 或可用 capability URL。

#### 必核對矩陣

| 控制               | Dashboard／runtime 驗證                                          | 驗收證據                      |
| ------------------ | ---------------------------------------------------------------- | ----------------------------- |
| Cloudflare Access  | 只保護 /admin、/admin/_、/api/admin/_                            | 無痕視窗與 API 回應           |
| 公開使用者路徑     | /、/invite、/files、/file/* 不被 Access 誤擋                     | 瀏覽器 smoke test             |
| Admin bootstrap    | Access 後仍需 Turnstile + ADMIN_TOKEN；Bearer 不直接授權其他 API | 正反向 API 測試               |
| R2 development URL | r2.dev 關閉                                                      | Dashboard 狀態                |
| CDN WAF contract   | 只允許目標 host／prefix 的 GET、HEAD，拒絕 query 與其他 method   | curl 回應與 Security Events   |
| Cache Rule         | inline 可快取；download_only 不形成可重用 HIT                    | 連續 HEAD／GET                |
| Range              | 不被 WAF／rate limit 誤傷                                        | 206 或預期完整回應            |
| Rate Limit         | 基準值經正常流量校正                                             | Security Events、24h／7d 觀察 |
| Managed WAF／DDoS  | 未被 bypass                                                      | Dashboard 狀態                |
| HTTPS／HSTS        | upload 與 CDN HTTP 轉 HTTPS；HSTS scope 不誤傷其他子網域         | response headers              |
| nosniff            | upload Worker 與直接 R2 Custom Domain 回應皆具正確 header        | curl -I                       |
| Budget Alerts      | 依 owner 私人 Operations 門檻建立，或記錄方案不支援              | Billing 設定狀態              |
| workers.dev        | 明確停用                                                         | Wrangler 與 Dashboard         |
| Scheduled trigger  | 0 * * * * 正常執行                                               | 最近成功 invocation           |
| D1 migrations      | 0001–0011 與 production 實況一致                                 | migration list                |
| Lifecycle rule     | 僅 temp-storage/objects/，90 日                                  | R2 lifecycle list             |
| CSP                | 7 日無未解決 violation，最後切 enforced                          | headers 與 smoke test         |

#### 文件修正

- deployment.md 不再寫「規則尚待設定」這類可能過期的單一敘述，改用有日期的狀態表。
- cloudflare-edge-protection.md 的 checklist 依 Dashboard 實況更新。
- 每次手動變更記錄「最後驗證日期」，不記錄執行者個資。
- 區分作者 production 設定與一般 self-host 指南。
- 說明 R2 刪除後 edge cache 最長可留到 TTL 到期；需要立即失效時依 runbook purge 完整 URL。
- 明確說明公開 repository 不代表公開寫入：上傳仍必須經 invitation session 與 quota。

## 8. 非阻擋項目與已接受風險

以下不應被誤列為公開前漏洞：

- D1 UUID、site key、domain 與 bucket 名稱公開。
- public file URL 被知道後可讀取；這是 capability-link 模型。
- CDN inline preview 最長約一小時 cache，刪除後可能等 TTL 到期；文件需說明，緊急時 purge。
- Browser 端的模組級 UI state；Cloudflare 的「不可使用全域可變狀態」規則適用於 Worker request state，不適用於單一瀏覽器頁面。
- 測試檔中的官方 Turnstile 測試 secret。
- package.json 的 private: true；它只防止誤發 npm package，不妨礙 GitHub repository 公開。
- docs/archive 中的歷史規格未含秘密；是否保留是作品集整潔度選擇，不需要為此改寫歷史。

## 9. 測試與驗收計畫

### 9.1 自動化檢查

每個 PR 最少執行：

1. pnpm types:check
2. pnpm lint
3. pnpm test
4. pnpm build
5. git diff --check

public candidate commit 必須由 GitHub Actions 執行完整 pnpm check，不能只引用本機結果或 commit message。

### 9.2 必加回歸測試

- 上傳在 D1 commit 前後各失敗一次的 R2／D1／quota 狀態。
- blocked type 不重複 release。
- cleanup fatal error 會終結 cleanup_runs。
- Turnstile test mode production-origin fail closed。
- previewUrl／downloadUrl origin 與 scheme allowlist。
- enforced CSP 所需的 response header 測試。

### 9.3 手動 production smoke test

1. 匿名使用者無法建立 invitation、上傳或呼叫 Admin API。
2. invitation fragment 交換後立即從網址移除。
3. 僅瀏覽 invitation 的所有 upload route 都由後端拒絕。
4. 一般 invitation 可 reserve、上傳、瀏覽、預覽、下載與刪除自己的檔案。
5. 配額用完後禁止新 reservation，但仍可瀏覽既有檔案。
6. Admin route 依序經 Access、Turnstile、token 與 session。
7. public file 的 inline、download_only、Range、過期與刪除行為符合文件。
8. Cron 執行後 cleanup_runs、D1 metadata、R2 object 與配額一致。
9. CDN WAF、cache、rate limit 與 nosniff 行為符合第 7 節矩陣。
10. CSP enforced 後首頁、邀請、預覽、上傳與 Admin 無 console policy error。

### 9.4 依賴與供應鏈

- 在公開候選 commit 執行 pnpm audit，至少不得有未接受的 production high／critical。
- 公開後查看 Dependabot alerts；每個 high／critical 必須修正或以 issue 記錄影響分析與暫緩理由。
- pnpm-lock.yaml 必須和 package.json 一致。
- GitHub Actions 中第三方 action 使用官方來源；高風險環境建議 pin 到完整 commit SHA。

## 10. 公開切換 Runbook

### T-24 小時

- 凍結非必要功能變更。
- 合併 PR-01 至 PR-06，或記錄明確核准的例外。
- 在 main 候選 SHA 執行 GitHub Actions pnpm check。
- 確認完整歷史秘密掃描無真實命中。
- 完成 Cloudflare 驗證矩陣。
- 確認 SECURITY.md、LICENSE、README 與自架指南可見。
- 視需要輪替 ADMIN_TOKEN；不要例行輪替 peppers。

### T-0

1. 由 repository owner 將 visibility 切為 Public。
2. 立即套用 main branch protection。
3. 啟用 secret scanning、push protection、Dependabot、CodeQL 與 Private Vulnerability Reporting。
4. 建立 v0.1.0 release，release notes 說明 self-host 性質與已知限制。
5. 重新執行 live smoke test；公開本身不應觸發 production deploy。

### T+24 小時與 T+7 日

- 檢查 GitHub Security alerts、Actions、公開 issue 與錯誤回報。
- 檢查 Cloudflare Security Events、Workers errors、D1、R2 Class A／B、cache hit ratio 與 budget alert。
- 檢查是否有人提交真實 capability URL 或 secret；若有，先移除內容並執行相應撤銷／輪替。
- 檢查 rate limit 是否誤傷 Range、共享 NAT 或多檔上傳。
- 將結果更新到有日期的 production state 文件。

## 11. 回復計畫

Repository visibility 切回 Private 不能撤回已被 clone 的原始碼，因此公開前必須完成秘密與授權檢查；不能把「之後再轉回 Private」當作秘密洩漏的 rollback。

若公開後發現問題：

| 事件                     | 立即處置                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| 真實 secret 出現在歷史   | 撤銷／輪替該 secret，移除公開內容；必要時才做 history rewrite                     |
| 活躍攻擊或成本異常       | 依 Cloudflare cost incident runbook 限制入口；必要時停用 uploads                  |
| 新發現高風險漏洞         | 建立 private security advisory、暫停 release／部署；必要時將 repo 暫時 Private    |
| CI／文件錯誤但無安全風險 | 修正 PR，不必切回 Private                                                         |
| CSP 誤擋                 | 先修正最小 source policy；若服務中斷，可短暫退回最後已驗證 Report-Only 並記錄時限 |
| Rate limit 誤傷          | 先停用或提高 CDN rate rule，保留 method／query WAF contract                       |

## 12. 建議 PR 與 Commit 順序

| 順序 | PR 主題                            | 建議 commit                                    |
| ---: | ---------------------------------- | ---------------------------------------------- |
|    1 | 上傳狀態機與回歸測試               | fix(upload): 避免提交完成後誤刪 R2 物件        |
|    2 | Cleanup 終結與 reconciliation 預算 | fix(cleanup): 保證清理紀錄可終結並限制單次掃描 |
|    3 | Secret 型別與測試模式邊界          | chore(config): 固定必要秘密與正式環境驗證      |
|    4 | CSP 與前端 URL allowlist           | security: 強制內容安全政策與媒體來源邊界       |
|    5 | CI 與公開治理文件                  | ci: 建立公開候選版本驗證流程                   |
|    6 | Cloudflare 狀態與 self-host 文件   | docs: 同步正式防護狀態與公開部署指引           |

功能程式、CI／治理與純文件盡量分開 PR。每個 PR 都應附風險、測試結果、是否涉及 Cloudflare Dashboard／D1 migration／deployment，以及回復方式。

## 13. Codex 執行約束

將本規格交給 Codex 實作時，必須遵守：

1. 先讀 repository 根目錄 AGENTS.md 與任務直接相關的現行文件。
2. 使用 feature branch 與 PR；未經明確授權不得直接推 main。
3. 不得讀取、輸出、建立或覆寫 .dev.vars、.env 或任何 production secret。
4. 不得自行變更 GitHub visibility、刪除 develop、變更 branch protection 或啟用／停用 GitHub security feature；可準備逐項操作清單。
5. 不得自行執行 wrangler deploy、remote migration、R2 remote 操作或 Cloudflare Dashboard 變更。
6. 任何 D1 schema 變更只能新增 migration，不改寫已存在的 0001–0010。
7. 不得例行輪替 DELETE_TOKEN_PEPPER 或 IP_HASH_PEPPER。
8. 保留 temp-storage/objects/ prefix 與 capability URL 安全模型。
9. 先修 F-01，再做治理與公開動作；高優先問題未完成時不得宣告 public-ready。
10. 每一批變更都執行最小充分測試；public candidate 必須完整執行 pnpm check。
11. 若 Cloudflare Dashboard 與文件不一致，以實際設定為待核對事實，不可靜默覆蓋任何一方。
12. 交付時列出已完成項目、未完成的人工步驟、測試證據、候選 SHA 與已知風險。

## 14. Definition of Done

只有下列項目全部完成或取得明確風險接受，才標記為 Public Ready：

- [x] F-01 已修正且有 commit 前／後失敗回歸測試。
- [x] Cleanup fatal path 不再留下永久 running 紀錄。
- [x] 官方 Turnstile 測試 secret 非本機 fail closed。
- [x] Wrangler required secrets 與生成 Env 型別無漂移。
- [x] workers.dev 明確停用。
- [x] GitHub Actions 在 PR #1 候選 SHA 完整 pnpm check 全綠。
- [x] production dependency 無未接受 high／critical。
- [x] SECURITY.md、CONTRIBUTING.md、README 公開邊界說明完成。
- [x] Cloudflare Access 路徑經正反向驗證。
- [x] CDN WAF、Cache、Rate Limit、r2.dev、HTTPS／HSTS、nosniff 與 budget 狀態經驗證。
- [x] D1 0001–0011、Cron 與 R2 lifecycle 正式狀態已核對。
- [x] Owner 接受公開時限期內維持 CSP Report-Only，持續進行 production 觀察。
- [x] current tree 與 full history 秘密掃描無真實命中。
- [x] Repository 已公開，`main` protection、Secret Scanning、Push Protection、Dependabot、CodeQL 與 Private Vulnerability Reporting 已啟用。
- [ ] 公開後 T+24h／T+7d 監測責任與檢查項目已排定。

## 15. 最終建議

此專案不是因為「私有才安全」；現有的 invitation、session、quota、R2 prefix、Admin 多層驗證與 Cloudflare edge 設計，大致符合可公開原始碼的安全模型。公開的主要風險不在程式被看見，而在 production 設定漂移、沒有 CI 證據，以及上傳失敗路徑中的資料一致性缺陷。

因此建議採以下決策：

> **F-01、F-03、F-05、F-06 與 Cloudflare production-state 驗證已完成，repository 已依核准流程公開。**
> 不需改寫 Git 歷史；不需把非秘密識別資訊移除；後續依 T+24h／T+7 日清單監測 GitHub 與 Cloudflare。

## 16. 參考資料

- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [workers.dev Routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Cloudflare Turnstile Get Started](https://developers.cloudflare.com/turnstile/get-started/)
- [Cloudflare R2 Public Buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning)
- [GitHub Repository Security Quickstart](https://docs.github.com/en/code-security/getting-started/securing-your-repository)
- [GitHub Security Policy](https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository)
