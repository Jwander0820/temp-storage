# 本機測試流程

這份流程用來驗證管理頁、邀請、共享檔案瀏覽、上傳、預覽、下載、配額與撤銷行為。Wrangler 在本機以
workerd／Miniflare 執行 Worker，D1 與 R2 都使用 `.wrangler/` 內的本機狀態，不會修改正式
Cloudflare 資源。

## 前置設定

專案只使用 `.dev.vars` 保存本機設定，不使用 `.env`。至少確認以下項目存在：

- 本機 `ADMIN_TOKEN`、`DELETE_TOKEN_PEPPER`、`IP_HASH_PEPPER`
- Cloudflare 官方 always-pass Turnstile 測試 site key 與 secret
- `TURNSTILE_TEST_MODE=true`
- `UPLOAD_ORIGIN=http://localhost:8976`
- `CDN_ORIGIN=http://localhost:8976`

不要把 `.dev.vars` 加入 Git，也不要用範例檔直接覆寫既有 secrets。

## 啟動

首次啟動或 migrations 更新後執行：

```powershell
pnpm run db:migrate:local
```

啟動前端 watch 與本機 Worker：

```powershell
pnpm dev
```

終端顯示 `Ready on http://127.0.0.1:8976` 後，開啟
`http://localhost:8976/admin`。終端需保持執行。

## 手動驗證

1. 使用 `.dev.vars` 的本機 `ADMIN_TOKEN` 登入。
2. 建立測試邀請 A 與 B，確認兩者立即出現在「有效邀請」。
3. 在兩個不同瀏覽器 context 開啟 A、B 連結並完成測試版 Turnstile。
4. 使用 A 上傳一個不含私人資料的小圖片，使用 B 上傳文字或壓縮檔。
5. 在 A 與 B 開啟 `http://localhost:8976/files`，確認兩邊都能看到兩個檔案，且共享頁沒有刪除操作。
6. 確認圖片縮圖使用 lazy loading，影片與音訊不會在清單頁自動播放或載入完整內容。
7. 從共享頁複製單檔連結，在沒有 invitation session 的無痕視窗確認仍可開啟或下載。
8. 在另一個無 session 的無痕視窗直接開啟 `/files`，確認只顯示邀請提示而不顯示清單。
9. 回 `/admin` 的「檔案管理」，確認 active 檔案、容量、預覽與下載入口皆正確。
10. 刪除其中一個檔案，確認對話框包含檔名與快取提示；完成後檔案從共享頁消失，單檔資訊與
    下載 URL 回傳 404，容量同步更新。已載入或快取的公開預覽可能短暫保留。
11. 重新簽發邀請 A，確認新連結可用、舊連結與既有 A session 失效。
12. 撤銷邀請 B，確認它移到「歷史邀請」，且既有 B session 無法再讀取 `/files`。
13. 以 375px 手機 viewport 驗證單欄清單、載入更多、單檔頁與刪除確認都不會水平溢出。

## 本機資料位置

- D1 與 R2 狀態根目錄：`.wrangler/state/v3/`
- R2 bucket blobs：`.wrangler/state/v3/r2/cdn/blobs/`
- R2 metadata：`.wrangler/state/v3/r2/miniflare-R2BucketObject/metadata.sqlite`

blob 檔名是 Miniflare 的內部識別值，不是原始檔名。驗證內容時優先使用管理頁的預覽／下載，
或在執行 `pnpm dev` 的終端按 `e` 開啟 Local Explorer；不要直接修改 blobs 或 SQLite。

也可以用本機 D1 帳本核對原始檔名、R2 object key、大小、狀態與到期時間：

```powershell
pnpm exec wrangler d1 execute jwander-temp-storage-db --local --command "SELECT original_name, object_key, size_bytes, status, expires_at FROM files ORDER BY created_at DESC"
```

## 與正式環境的邊界

- `db:migrate:local` 明確使用 `--local`。
- `pnpm dev` 沒有 remote binding，D1、R2、Worker 與靜態資產均在本機。
- 不要在本機測試命令加上 `--remote`。
- 不要把測試網址改成 `upload.jwander.net` 或 `cdn.jwander.net`。
- 測試版 Turnstile 仍會載入 Cloudflare widget 並呼叫 Siteverify，但使用公開 dummy key，不會經過
  正式 Worker，也不會使用正式 Turnstile widget。

## 檔案與邀請撤銷

撤銷或重新簽發邀請只會讓邀請 token 與相關 session 失效，也會立即阻止該 session 繼續瀏覽
共享目錄，但不會刪除已上傳檔案。已知的公開單檔 URL 仍可使用到檔案到期或被管理員刪除；
到期檔案之後由 cleanup 或 R2 Lifecycle 處理。

本機沒有正式 R2 Lifecycle 執行器，`pnpm dev` 也不會等待 90 天自動清理。需要測試到期清理時，
先讓 `pnpm dev` 保持執行，再觸發 Wrangler 的 scheduled 測試 endpoint：

```powershell
Invoke-WebRequest http://localhost:8976/__scheduled
```

## 自動化檢查

```powershell
pnpm test
pnpm check
```

`pnpm test` 使用本機 D1 migrations、local R2 binding 與 mock Turnstile，不會接觸正式資源。
