# 共享檔案瀏覽與管理 UI 規格

- 狀態：已實作；保留作為產品意圖參考
- 讀取政策：冷封存；只在使用者明確要求時調閱
- 最後更新：2026-08-27
- 目標分支：`develop`
- 文件用途：交付其他開發者實作
- 影響範圍：Worker API、D1 查詢、Static Assets UI、自動化測試與本機測試文件
- 不包含：正式部署、Cloudflare 資源異動、個人私密檔案、使用者帳號系統

## 1. 背景與目前狀態

Jwander 暫存區的產品定位不是只有管理員自己使用的雲端硬碟，而是讓持有邀請的人上傳、瀏覽、
下載與交換暫存檔案的共享空間。

目前系統已有以下能力：

- 邀請連結經一次 Turnstile 交換後，建立短期 HttpOnly invitation session。
- 有效 invitation session 可以上傳檔案及讀取共享容量。
- 知道檔案 ID 或公開 URL 的任何人，都可以開啟仍有效的檔案資訊頁與下載連結。
- `inline` 媒體可由 `cdn.jwander.net/temp-storage/objects/*` 公開預覽。
- 管理 API 已提供檔案分頁查詢與刪除：`GET /api/admin/files`、
  `DELETE /api/admin/files/:fileId`。
- 現有 `/admin` UI 只管理邀請，尚未呈現檔案清單與刪除操作。

目前缺少「檔案目錄」。因此，受邀使用者上傳完成後只看得到自己這次瀏覽器佇列裡的結果；如果
沒有取得其他檔案的分享連結，就無法瀏覽暫存區現有內容。R2 Custom Domain 本身也不提供 bucket
根目錄 listing，不能把 `cdn.jwander.net` 當成檔案清單頁。

## 2. 產品決策

### 2.1 公開的定義

本階段採用「共享目錄、公開物件連結」模型：

- 只有持有有效 invitation session 的人可以取得暫存區檔案清單。
- 清單包含所有邀請所上傳、目前仍為 `active` 且尚未到期的檔案，不依 invitation 分區。
- 檔案資訊頁、下載 URL 與 `inline` CDN 預覽 URL 維持現行公開行為；取得 URL 後不需 invitation
  session。
- invitation 到期、撤銷或 session 登出後，使用者不能再取得清單，但先前已複製的公開檔案 URL
  仍可使用，直到檔案被刪除或到期。
- UI 必須明確提示「這是共享暫存區；上傳內容可能被其他受邀者看到，請勿上傳私密資料」。

「公開」不代表公開 bucket listing。瀏覽器不得直接列舉 R2，也不得取得 R2 binding、S3 憑證或
管理憑證；檔案目錄只能由 Worker 根據 D1 帳本產生。

### 2.2 權限矩陣

| 能力                                       | 匿名訪客                       | 有效 invitation session  | 有效 admin session            |
| ------------------------------------------ | ------------------------------ | ------------------------ | ----------------------------- |
| 兌換邀請                                   | 有有效 token 與 Turnstile 時可 | 可                       | 可另行登入 admin              |
| 瀏覽共享檔案清單                           | 不可                           | 可，唯讀                 | 可，含管理欄位                |
| 開啟已知檔案資訊頁                         | 可                             | 可                       | 可                            |
| 預覽／下載已知有效檔案                     | 可                             | 可                       | 可                            |
| 上傳檔案                                   | 不可                           | 可，受邀請與全站配額限制 | 不因 admin 身分自動取得上傳權 |
| 刪除任意檔案                               | 不可                           | 不可                     | 可                            |
| 以完成上傳時取得的 delete token 刪除該檔案 | 持有 token 時可                | 持有 token 時可          | 可直接使用 admin 刪除         |

## 3. 使用者體驗

### 3.1 共享檔案頁

新增路由：`GET /files`。

入口與導覽：

- invitation session 驗證成功後，在上傳工作區提供「上傳檔案」與「瀏覽檔案」兩個清楚入口。
- 使用者可直接開啟 `/files`。若已有有效 session，直接顯示清單。
- 若沒有有效 session，沿用現有邀請提示，不建立第二套登入流程；提示使用完整邀請連結進入。
- 單一檔案仍使用現有 `/file/:fileId` 頁面。

頁面內容：

- 頁首：標題「共享檔案」、共享區公開性警語、返回上傳頁連結。
- 清單預設依 `created_at DESC, id DESC` 排序，最新上傳在前。
- 每筆至少顯示原始檔名、檔案大小、偵測類型、上傳時間、到期時間與剩餘時間。
- 圖片類 `inline` 檔案可以顯示懶載入縮圖；不得預載完整影片或音訊。
- 非圖片、`download_only` 或無法顯示縮圖的檔案使用檔案類型圖示或文字 fallback。
- 點擊項目開啟 `/file/:fileId`；另提供「下載」與「複製連結」。
- 空狀態顯示「暫存區目前沒有可瀏覽的檔案」，並提供前往上傳的操作。
- 載入錯誤須保留重試按鈕；session 失效時回到邀請提示，不顯示空清單造成誤解。
- 使用「載入更多」進行 keyset pagination；P0 不做無限捲動。

P0 不需要搜尋、標籤、資料夾、排序切換或依上傳者篩選。若實作者一併加入類型篩選，僅允許
`all`、`image`、`video`、`audio`、`other`，且必須由後端套用白名單，不能接受任意 SQL/MIME
片段。

### 3.2 Admin 檔案管理

`/admin` 在既有驗證與邀請管理之外，新增「檔案管理」區段或頁籤：

- 登入後同時可進入「邀請管理」與「檔案管理」。不新增另一組 admin token 或 session。
- 預設只列出 `active` 檔案，支援載入更多。
- 每筆顯示：檔名、大小、偵測 MIME、狀態、建立時間、到期時間、預覽／下載入口。
- 每筆提供「刪除檔案」。按下後必須顯示確認對話框，至少包含檔名，並說明會立即停止公開存取。
- 確認後呼叫既有 `DELETE /api/admin/files/:fileId`。成功時從 active 清單移除並更新容量狀態；
  失敗時保留項目並顯示可重試錯誤。
- 送出刪除後到回應前停用該項目的刪除按鈕，防止重複操作。
- 不在 DOM、URL、localStorage 或 sessionStorage 暴露 `ADMIN_TOKEN`、delete token、pepper、
  `object_key` 或 invitation token。

P0 不包含批次刪除。狀態／MIME／日期篩選可沿用既有 API，但不是共享頁上線的阻擋條件。

## 4. Worker 與資料模組

### 4.1 可瀏覽檔案目錄模組

建立一個集中處理共享目錄規則的模組，其外部 interface 應接近：

```ts
interface BrowseFilesInput {
  readonly now: number;
  readonly cursor: string | null;
  readonly limit: number;
  readonly type: "all" | "image" | "video" | "audio" | "other";
}

interface BrowseFilesResult {
  readonly files: PublicFile[];
  readonly nextCursor: string | null;
}

function browseActiveFiles(
  database: D1Database,
  input: BrowseFilesInput,
): Promise<BrowseFilesResult>;
```

名稱可以依現有 repository/service 慣例調整，但以下規則必須集中在此模組，不可由前端自行拼湊：

- 僅查詢 `status = 'active' AND expires_at > now`。
- 排序固定為 `created_at DESC, id DESC`。
- cursor 同時包含 `created_at` 與 `id`，避免同秒上傳造成重複或遺漏。
- cursor 必須完整驗證；無效 cursor 回傳 `400 INVALID_REQUEST`。
- 預設 `limit=24`，最大 `60`；查詢 `limit + 1` 筆判斷 `nextCursor`。
- 對外資料經既有 `toPublicFile()` 序列化，禁止回傳 `object_key`、`delete_token_hash`、
  `uploader_hash`、`sha256`、`invitation_id` 或 reservation 資料。

若 `EXPLAIN QUERY PLAN` 顯示現有 index 無法有效支援查詢，再新增 migration：

```sql
CREATE INDEX idx_files_browse_active
ON files(status, created_at DESC, id DESC);
```

實作者須先量測查詢計畫，不因規格範例無條件新增 index。`expires_at > now` 仍是必要過濾條件。

### 4.2 Invitation session API

新增：

```http
GET /api/files?cursor=<opaque>&limit=24&type=all
Cookie: jwander_upload_session=<HttpOnly token>
```

注意：此 collection route 與既有公開 item route `GET /api/files/:fileId` 權限不同。

成功回應：

```json
{
  "files": [
    {
      "id": "file-id",
      "filename": "example.jpg",
      "sizeBytes": 123456,
      "detectedMime": "image/jpeg",
      "previewPolicy": "inline",
      "previewUrl": "https://cdn.jwander.net/temp-storage/objects/...",
      "downloadUrl": "https://upload.jwander.net/d/file-id",
      "createdAt": "2026-08-26T01:00:00.000Z",
      "expiresAt": "2026-11-24T01:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

要求：

- 使用既有 `uploadSessionMiddleware`，每次請求都重新驗證 session 與 invitation 是否仍有效。
- 回應固定 `Cache-Control: private, no-store`。
- 無 session、session 到期或 invitation 撤銷時回傳 `401 INVITATION_REQUIRED`。
- 不接受 invitation ID，因 P0 是所有受邀者共用同一個目錄。
- 不直接呼叫 `R2Bucket.list()` 建立頁面清單；D1 是檔案可見性、狀態與到期時間的權威帳本。
- collection 查詢不得改變 invitation 配額或寫入 rate-limit event。

### 4.3 Admin API

保留並重用目前的：

```http
GET /api/admin/files?status=active&cursor=<opaque>&limit=50
DELETE /api/admin/files/:fileId
```

實作者只需在發現 UI 所需欄位確實缺失時擴充回應。若要加入 `previewUrl`、`downloadUrl`，應由
Worker 使用 `toPublicFile()` 或等價的集中序列化產生，不得讓前端從 `object_key` 自行組 CDN URL。

刪除流程必須繼續使用 `deleteFileAsAdmin()`，確保 R2 object、D1 狀態與 `storage_usage.used_bytes`
一致更新。前端不得直接刪除 R2 object。

## 5. 快取、成本與安全要求

- 檔案清單與管理回應為 session 衍生資料，全部使用 `private, no-store`。
- 僅既有允許公開預覽的完整、非 Range `inline` 物件可以使用公開快取策略。
- 圖片縮圖使用 `loading="lazy"`、`decoding="async"`；首屏以外不得提前要求 CDN 內容。
- 影片與音訊在清單頁不自動播放、不 preload 完整內容。實際媒體放在單檔頁由使用者主動開啟。
- 原始檔名一律以 `textContent` 呈現；不得用 `innerHTML` 插入使用者資料。
- 下載與 Content-Disposition 繼續使用現有檔名清理工具，不在此功能另做一套。
- 不在共享清單顯示 invitation label 或可推回上傳者身分的資料。
- API 錯誤不得包含 SQL、R2 key、token hash 或內部 stack trace。
- 新 collection route 應納入 `upload.jwander.net/api/files` 的觀測與適度 rate limiting，但不應
  讓正常翻頁與圖片懶載入互相干擾。
- 本功能不變更 `cdn.jwander.net` 綁定、不啟用 `r2.dev`、不引入 Cloudflare Access。

Cloudflare 官方文件確認 R2 Custom Domain 可公開提供物件並利用 Cloudflare Cache，但 public
bucket 根目錄目前不提供物件 listing；因此本規格刻意以 Worker + D1 提供受邀清單，而非嘗試
開放 CDN 目錄：<https://developers.cloudflare.com/r2/buckets/public-buckets/>。

## 6. 無障礙與響應式要求

- 手機寬度下清單改為單欄，操作按鈕不可水平溢出。
- 「載入中」、「刪除中」、「成功」、「錯誤」透過既有 `aria-live` toast 或頁面狀態呈現。
- 可互動檔案項目使用連結或按鈕，不以只有 click handler 的 `div` 取代語意元素。
- 縮圖有以原始檔名產生的 `alt`；裝飾性類型圖示使用 `aria-hidden="true"`。
- 刪除確認對話框應可用鍵盤操作，焦點進入後可取消，完成後回到合理位置。
- 保留 `prefers-reduced-motion` 與現有 focus 樣式行為。

## 7. 驗收條件

### 7.1 自動化測試

至少新增以下測試：

1. 匿名請求 `GET /api/files` 回傳 401，且不回傳檔案資料。
2. 有效 invitation session 可看見由不同 invitation 上傳的所有 active、未到期檔案。
3. reserved、uploading、deleted、rejected、failed 及已到期檔案不出現在共享清單。
4. 回應不包含 `object_key`、token hash、uploader hash、invitation ID 等內部欄位。
5. 兩筆相同 `created_at` 的檔案跨頁不重複、不遺漏。
6. 無效 cursor、非法 limit 與非法 type 回傳 400。
7. invitation 撤銷或 session 到期後，下一次清單請求回傳 401。
8. admin session 可列出檔案並刪除 active 檔案；刪除後 public item/download 回傳 404，容量只扣一次。
9. 既有 delete-token 刪除、public file page、Range、CDN hostname 與 upload quota 測試仍通過。

### 7.2 手動驗收

1. Admin 建立邀請 A 與邀請 B。
2. 使用 A 上傳圖片，使用 B 上傳文字或壓縮檔。
3. A 與 B 的 `/files` 都看得到兩個檔案，且不可在 UI 刪除。
4. 無 invitation session 的無痕視窗開啟 `/files` 時看不到清單。
5. 從共享頁複製公開連結，在無痕視窗可開啟或下載該檔案。
6. Admin 的檔案管理刪除其中一個檔案後，A、B 重新整理時都不再看到它，原公開 URL 回傳 404。
7. 圖片清單使用懶載入，影片與音訊不會在清單頁自動下載完整內容。
8. 在手機尺寸完成瀏覽、載入更多、開啟單檔頁與 admin 刪除確認。

完成後執行：

```powershell
pnpm test
pnpm check
git diff --check
```

不得以有失敗項目的測試或 build 當作通過。

## 8. 建議實作順序

1. 新增共享目錄 repository/service 查詢與 cursor 驗證測試。
2. 新增受 invitation session 保護的 `GET /api/files` collection route。
3. 新增 `/files` UI、導覽、狀態處理與響應式樣式。
4. 將現有 admin files API 接到 `/admin` 檔案管理 UI，完成單檔確認刪除。
5. 補齊跨 invitation、權限、分頁、刪除一致性與 regression tests。
6. 更新 `README.md` API／產品說明與 `docs/development/local-testing.md` 手動驗收流程。

## 9. 非目標與後續候選

本次不得順手加入：

- 個人帳號、OAuth、Cloudflare Access 或每人私密資料夾。
- invitation 彼此隔離的檔案空間。
- 公開匿名檔案索引、搜尋引擎 sitemap 或 RSS。
- 批次刪除、搬移、重新命名、永久保存或版本歷史。
- 由前端直接操作 R2/S3。

未來若要支援私人上傳，必須另寫權限與資料 migration 規格；不能只在前端隱藏檔案。建議屆時
為檔案加入明確 visibility（例如 `shared`／`private`）與 owner principal，並讓每一條 metadata、
preview、download、list 與 delete 路徑在 Worker 端統一授權。
