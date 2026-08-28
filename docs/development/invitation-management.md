# 邀請建立與管理

> 狀態：現行操作文件  
> 最後更新：2026-08-27  
> 用途：建立、複製、重新簽發與撤銷共享暫存區邀請

所有日常邀請管理都使用 `https://upload.jwander.net/admin`。永久 `ADMIN_TOKEN` 只負責交換短效 admin session，不提供 CLI 或 Bearer API 旁路。

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
- 登出所有管理裝置並立即撤銷全部 admin session。

QR Code 在瀏覽器內產生，不會將邀請 token 傳給第三方。管理 token 不應保存於 localStorage、sessionStorage、命令列參數或自動化腳本。舊的 `invite:create` CLI 已移除，避免繞過 Cloudflare Access 與 HttpOnly admin session 邊界。

## 邀請 URL 與 session

邀請 URL 使用 `/invite#token=...`。Fragment 不會隨初始 HTTP request 傳到伺服器；前端將 token、Turnstile token 與選用的 access code 送至 `/api/invitations/exchange`，交換短效 HttpOnly invitation session，隨後從網址列移除 token。

系統只保存 invitation token 的 peppered hash，因此無法從 D1 還原先前顯示過的明文連結。管理頁的「複製邀請連結」會為同一邀請新增一條等效連結；新舊連結共用期限、權限與額度，原連結與既有 invitation session 都保持有效。

「重新簽發並複製」用於連結遺失或可能外洩的情況。它會替換所有既有邀請連結，並使相關 invitation session 一併失效；「撤銷邀請」則會停用整份邀請。

## Access code

`UPLOAD_ACCESS_CODE` 是選用的第二道共用驗證，不取代 invitation token。啟用後，持有邀請 URL 的人仍需在交換 session 時輸入 access code。

交換流程依序完成 Turnstile、驗證 invitation token，再以 timing-safe comparison 驗證 access code，最後才建立 session。錯誤的 access code 與無效 invitation 使用完全相同的 403 回應；沒有有效 invitation 的請求不會進入 access code 驗證。

不同分享對象應使用不同邀請；不再需要時立即撤銷。NFC 或 QR Code 只保存 `inviteUrl`，不得保存 `ADMIN_TOKEN` 或 Cloudflare secret。

## Admin API

API 路由、驗證方式與欄位範圍見 [`../reference/api.md`](../reference/api.md)。建立、複製或重新簽發邀請的 API 都需要有效 HttpOnly admin session，並只在該次回應傳回明文 token；呼叫端必須立即交付 URL，不能期待之後從 D1 還原原始 token。
