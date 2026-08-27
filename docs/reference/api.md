# API 參考

> 狀態：現行參考文件  
> 最後更新：2026-08-27  
> 用途：快速查詢路由分區、驗證能力與主要查詢參數

正式入口為 `https://upload.jwander.net`。本文件提供路由導覽；request schema、錯誤碼與安全行為以 route、domain error 與測試為準。

## 公開與 URL capability

```text
GET    /api/health
GET    /api/config
POST   /api/invitations/exchange
GET    /api/files/:fileId
DELETE /api/files/:fileId
GET    /p/:fileId
HEAD   /p/:fileId
GET    /d/:fileId
HEAD   /d/:fileId
```

- `POST /api/invitations/exchange` 以 invitation token、Turnstile token 與選用 access code 交換 HttpOnly invitation session。
- `DELETE /api/files/:fileId` 使用一次性 `DeleteToken` capability。
- `/p/:fileId` 是 Worker 預覽 fallback。
- `/d/:fileId` 先查詢 D1 狀態，再從 R2 串流附件下載並支援 HEAD/Range。

## Invitation session

```text
GET    /api/storage
GET    /api/files
GET    /api/invitations/session
DELETE /api/invitations/session
POST   /api/uploads/reserve
PUT    /api/uploads/:uploadId
```

`GET /api/files` 支援：

- `cursor`
- `limit`：預設 24，最大 60
- `type`：`all`, `image`, `video`, `audio`, `other`

清單只回傳 `active` 且未到期的安全公開欄位，使用 `created_at DESC, id DESC` keyset 分頁，固定 `private, no-store`。回應不得包含 R2 object key、invitation ID、上傳者 hash 或刪除憑證。

Browse-only invitation session 可以使用檔案與容量查詢，但所有 `/api/uploads/*` 都必須由後端回覆 403。

## Admin session 或 Bearer token

```text
POST   /api/admin/session
GET    /api/admin/session
DELETE /api/admin/session
GET    /api/admin/status
GET    /api/admin/files
POST   /api/admin/invitations
GET    /api/admin/invitations
POST   /api/admin/invitations/:invitationId/reissue
DELETE /api/admin/invitations/:invitationId
POST   /api/admin/cleanup
POST   /api/admin/reconcile
DELETE /api/admin/files/:fileId
```

管理頁使用短效 HttpOnly admin session；CLI 或受控自動化可以使用 `Authorization: Bearer {ADMIN_TOKEN}`。

`GET /api/admin/files` 支援：

- `status`
- `mime`
- `createdBefore`, `createdAfter`
- `expiresBefore`
- `cursor`
- `limit`：最大 100

建立邀請時可設定 label、期限、`canUpload`、檔案數與容量。明文 invitation token 只在建立或重新簽發時回傳一次；D1 只保存 hash。

## 回應與安全原則

- Session、檔案資訊、容量與管理回應使用 private/no-store 語意。
- 所有錯誤包含 `requestId`，但不得暴露 secret、原始 token、Authorization、IP 或 object key。
- 檔案 ID、invitation session、admin session 與 delete token 是不同能力，不得互相推導。
- Collection route 不提供 R2 bucket listing；公開單檔 URL 也不能取得其他檔案。

更完整的信任模型與生命週期見 [`../architecture/system-overview.md`](../architecture/system-overview.md)。
