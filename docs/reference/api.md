# API 參考

> 狀態：現行參考文件  
> 最後更新：2026-09-05
> 用途：快速查詢路由分區、驗證能力與主要查詢參數

正式入口為 `https://upload.jwander.net`。本文件提供路由導覽；request schema、錯誤碼與安全行為以 route、domain error 與測試為準。

## 公開與 URL capability

```text
GET    /api/health
GET    /api/config
GET    /api/session/capabilities
POST   /api/invitations/exchange
GET    /api/files/:fileId
DELETE /api/delete/:fileId
DELETE /api/files/:fileId     # 舊 capability 相容路由
GET    /p/:fileId
HEAD   /p/:fileId
GET    /d/:fileId
HEAD   /d/:fileId
```

- `POST /api/invitations/exchange` 以 invitation token、Turnstile token 與選用 access code 交換 HttpOnly invitation session；在 JSON parsing 與 Turnstile 前先套用每 IP 每分鐘 20 次限流。
- `GET /api/config` 回傳前端需要的非秘密限制、Turnstile site key、`uploadOrigin` 與 `cdnOrigin`；前端以 `uploadOrigin` 驗證 download URL 與刪除連結，並以 `cdnOrigin` 驗證 preview URL。驗證使用伺服器設定，避免本機以 `127.0.0.1` 開頁、設定為 `localhost` 時誤拒絕有效連結。
- `GET /api/session/capabilities` 只回傳 `{ "admin": boolean }`，供公開頁面決定是否顯示管理操作；它不受 Cloudflare Access 保護，也不是授權依據。
- 上傳完成回應會額外且僅一次回傳 `deleteToken` 與 `/delete/:fileId#token=...` 形式的 `deleteUrl`。明文 token 不寫入 D1，也沒有查詢或補發 API。
- `/delete/:fileId` 是不需登入的確認頁；fragment 不會隨初始 GET 送到伺服器。頁面先載入公開設定與檔案資訊，使用者確認後才以 `Authorization: DeleteToken ...` 呼叫 `DELETE /api/delete/:fileId`。
- 刪除成功回覆 204；metadata 尚保留時，正確 token 的重複刪除同樣回覆 204。metadata 不存在回覆 404，錯誤 token 回覆 403，限流回覆 429。頁面查詢發現檔案已刪除或到期時顯示「檔案已不存在」。
- `DELETE /api/files/:fileId` 只保留給既有 DeleteToken capability 相容使用。
- `/p/:fileId` 是 Worker 預覽 fallback。
- `/d/:fileId` 先查詢 D1 狀態，再從 R2 串流附件下載並支援 HEAD/Range。
- 公開單檔 metadata、Worker 預覽與下載共用每 IP 每分鐘 300 次限流；DeleteToken mutation 使用獨立的每 IP 每分鐘 20 次限流。CDN Custom Domain 不經這些 bindings。

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

## Admin bootstrap

```text
POST   /api/admin/session
```

此端點依序套用每 IP 每分鐘 5 次的獨立限流、Turnstile 與 timing-safe `ADMIN_TOKEN` 比對，成功後建立 4 小時 HttpOnly admin session。永久 `ADMIN_TOKEN` 只允許用於這個交換動作，不能直接呼叫其他管理 API。

## Admin session

```text
GET    /api/admin/session
DELETE /api/admin/session
POST   /api/admin/sessions/revoke-all
GET    /api/admin/status
GET    /api/admin/files
POST   /api/admin/invitations
GET    /api/admin/invitations
POST   /api/admin/invitations/:invitationId/copy
POST   /api/admin/invitations/:invitationId/reissue
DELETE /api/admin/invitations/:invitationId
POST   /api/admin/cleanup
POST   /api/admin/reconcile
DELETE /api/admin/files/:fileId
```

上述端點只接受有效的 HttpOnly admin session。即使 `Authorization: Bearer {ADMIN_TOKEN}` 完全正確，也必須回覆 401。`POST /api/admin/sessions/revoke-all` 會撤銷所有管理 session、清除目前 Cookie，並回覆 204。

正式環境預期由 Cloudflare Access 額外保護 `/admin`、`/admin/*` 與 `/api/admin/*`；Access 是 Worker 外層的 infrastructure boundary，本機不模擬這一層。

`GET /api/admin/files` 支援：

- `status`
- `mime`
- `createdBefore`, `createdAfter`
- `expiresBefore`
- `cursor`
- `limit`：最大 100

建立邀請時可設定 label、期限、`canUpload`、檔案數與容量。`copy` 會為同一邀請新增等效連結，不撤銷舊連結或 session；`reissue` 則會使全部舊連結與相關 session 失效。明文 invitation token 只在建立、複製或重新簽發時回傳一次；D1 只保存 hash。

`POST /api/admin/reconcile` 每次只處理 `RECONCILE_PAGE_BUDGET` 頁。回應的 `complete` 表示本輪是否完成；未完成時 `continuation` 只供管理者觀察，真正的 phase／cursor 已保存在 D1，下一次呼叫會自動接續。

## 回應與安全原則

- 會解析 JSON 的 mutation route 上限為 16 KiB；超限回覆 413，格式錯誤回覆 400。
- 帶有 admin／invitation session Cookie 的 mutation 必須使用完全符合 `UPLOAD_ORIGIN` 的 `Origin`；缺少、`null` 或 sibling-origin 會回覆 403。
- Session、檔案資訊、容量與管理回應使用 private/no-store 語意。
- `/api/session/capabilities` 的結果僅用於 UI；管理動作由 `/api/admin/*` 重新驗證 admin session。上傳者刪除則由 DeleteToken route 獨立驗證單檔憑證，不要求 invitation 或 admin session。
- 所有錯誤包含 `requestId`，但不得暴露 secret、原始 token、Authorization、IP 或 object key。
- 檔案 ID、invitation session、admin session 與 delete token 是不同能力，不得互相推導。
- Collection route 不提供 R2 bucket listing；公開單檔 URL 也不能取得其他檔案。

更完整的信任模型與生命週期見 [`../architecture/system-overview.md`](../architecture/system-overview.md)。
