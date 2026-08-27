# 邀請建立與管理

> 狀態：現行操作文件  
> 最後更新：2026-08-27  
> 用途：建立、複製、重新簽發與撤銷共享暫存區邀請

日常管理建議使用 `https://upload.jwander.net/admin`。CLI 適合管理員在受控終端快速建立「上傳與瀏覽」邀請；API 則提供自動化整合。

## 邀請權限

| 權限         | 能力                                            |
| ------------ | ----------------------------------------------- |
| 上傳與瀏覽   | 瀏覽、預覽、下載，並依檔案數與容量額度上傳      |
| 僅瀏覽與下載 | 瀏覽、預覽、下載；後端拒絕所有 `/api/uploads/*` |

一般邀請額度耗盡後只拒絕新的 upload reservation；只要邀請與 session 仍有效且未撤銷，既有檔案仍可瀏覽與下載。

## 管理頁

在 `/admin` 驗證管理 token 與 Turnstile 後，可以：

- 建立兩種權限的邀請。
- 設定 label、有效期限、檔案數與容量。
- 產生、複製或顯示 QR Code。
- 為同一邀請複製新的等效連結，不影響原連結與既有 session。
- 重新簽發或撤銷邀請。
- 檢視與刪除有效檔案。

QR Code 在瀏覽器內產生，不會將邀請 token 傳給第三方。永久 `ADMIN_TOKEN` 只用來交換短效 HttpOnly admin session，不應保存於 localStorage 或 sessionStorage。

## CLI 建立邀請

CLI 目前建立「上傳與瀏覽」邀請。先以程序環境變數提供 `ADMIN_TOKEN`：

```powershell
$env:ADMIN_TOKEN = "你的管理 Token"
```

建立邀請：

```powershell
pnpm invite:create
pnpm invite:create --label "upload" --days 7 --files 10 --mb 300
pnpm invite:create:year -- --label "long-term" --files 10 --mb 300
```

Windows CMD 也可使用：

```bat
invite-create.cmd
invite-create.cmd --label "upload" --days 7 --files 10 --mb 300
invite-create-year.cmd --label "long-term" --files 10 --mb 300
```

腳本依序讀取目前程序的 `ADMIN_TOKEN`、`.env.local`、`.env`、`.dev.vars`，不會輸出管理 token。這些檔案都不得提交。

成功後會顯示 invitation ID、到期時間與一次性的 `inviteUrl`，並在 Windows 嘗試複製到剪貼簿。

## 邀請 URL 與 session

邀請 URL 使用 `/invite#token=...`。Fragment 不會隨初始 HTTP request 傳到伺服器；前端將 token、Turnstile token 與選用的 access code 送至 `/api/invitations/exchange`，交換短效 HttpOnly invitation session，隨後從網址列移除 token。

系統只保存 invitation token 的 peppered hash，因此無法從 D1 還原先前顯示過的明文連結。管理頁的「複製邀請連結」會為同一邀請新增一條等效連結；新舊連結共用期限、權限與額度，原連結與既有 invitation session 都保持有效。

「重新簽發並複製」用於連結遺失或可能外洩的情況。它會替換所有既有邀請連結，並使相關 invitation session 一併失效；「撤銷邀請」則會停用整份邀請。

## Access code

`UPLOAD_ACCESS_CODE` 是選用的第二道共用驗證，不取代 invitation token。啟用後，持有邀請 URL 的人仍需在交換 session 時輸入 access code。

不同分享對象應使用不同邀請；不再需要時立即撤銷。NFC 或 QR Code 只保存 `inviteUrl`，不得保存 `ADMIN_TOKEN` 或 Cloudflare secret。

## API 自動化

API 路由、驗證方式與欄位範圍見 [`../reference/api.md`](../reference/api.md)。建立、複製或重新簽發邀請的 API 都只在該次回應傳回明文 token；呼叫端必須安全保存或立即交付 URL，不能期待之後從 D1 還原原始 token。
