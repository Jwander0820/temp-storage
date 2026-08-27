> 狀態：程式端已實作；Cloudflare Access 線上設定待管理員手動完成
> 讀取政策：冷封存；只在使用者明確要求時調閱
> 封存日期：2026-08-27
> 現行來源：程式、測試、`docs/architecture/`、`docs/development/` 與 `docs/reference/`

對，**Cloudflare Access 本身主要是在 Cloudflare Zero Trust 網頁端設定**。程式不需要自己實作 Access 登入頁，你的 Worker 只需要配合新的安全邊界即可。

Cloudflare 官方目前的設定入口是 **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private**，而且可以只保護特定 hostname/path。([Cloudflare Docs][1])

下面這份我整理成可以直接交給 Codex 的實作規格。

---

# Jwander Temp Storage

## Admin Security Hardening 規格書 v1.0

### 1. 目標

本次更新目標是在不影響一般受邀使用者操作便利性的前提下，加強管理員功能的安全性，為未來 GitHub repository 公開做準備。

新的管理員安全模型：

```text
Internet
   │
   ▼
Cloudflare Access
只保護 Admin Surface
   │
   ▼
Permanent ADMIN_TOKEN
僅允許交換 Admin Session
   │
   ├─ Turnstile
   └─ Admin Login Rate Limit
   │
   ▼
4h HttpOnly Admin Session
   │
   ▼
Admin APIs
```

一般使用者流程維持：

```text
Invitation URL
   ↓
Turnstile
   ↓
Invitation Session
   ↓
Upload / Browse / Preview / Download
```

**一般使用者不得被要求通過 Cloudflare Access。**

---

# 2. Cloudflare Access 保護範圍

Access 僅保護：

```text
https://upload.jwander.net/admin
https://upload.jwander.net/admin/*
https://upload.jwander.net/api/admin/*
```

不保護：

```text
/
 /invite
 /files
 /file/*
 /d/*
 /api/config
 /api/storage
 /api/files/*
 /api/uploads/*
 /api/invitations/*
 /api/session/capabilities
```

Cloudflare 支援 path-based Access application，所以不需要把整個 `upload.jwander.net` 變成私人網站。([Cloudflare Docs][2])

另外 Cloudflare 特別指出：

```text
example.com/alpha/*
```

**不包含**

```text
example.com/alpha
```

所以 `/admin` 與 `/admin/*` 應明確一起保護。([Cloudflare Docs][2])

---

# 3. Cloudflare Access 設定

這部分由你在 Cloudflare Dashboard 手動完成，不交給 Worker 程式控制。

建議建立：

```text
Application Name:
Jwander Temp Storage Admin
```

類型：

```text
Self-hosted application
```

Protected destinations：

```text
upload.jwander.net/admin
upload.jwander.net/admin/*
upload.jwander.net/api/admin/*
```

Access Policy：

```text
Action:
Allow

Include:
你的管理員 Email
```

例如只允許：

```text
your-admin-email@example.com
```

不要設定：

```text
Everyone
```

也不要把朋友的 Email 加進去。

---

# 4. Access Session

建議初期設定：

```text
Cloudflare Access Session
24 hours
```

Access 會替通過驗證的瀏覽器建立 `CF_Authorization` session。

Cloudflare 每次收到受保護 request 的確都會驗證它，但瀏覽器會自動帶 Access cookie，因此不需要每次重新登入。([Cloudflare Docs][3])

正常情況：

```text
16:00 /admin
      ↓
Access Login

16:01 /api/admin/session
      ↓
直接通過 Access

16:05 /api/admin/invitations
      ↓
直接通過 Access

18:20 /api/admin/files
      ↓
直接通過 Access
```

只要 Access session 還有效即可。

Cloudflare目前允許 application/policy session 最長設定至一個月。([Cloudflare Docs][4])

---

# 5. ADMIN_TOKEN 角色重新定義

這是本次最重要的程式改造。

目前：

```text
ADMIN_TOKEN
   │
   ├─ 可以建立 Admin Session
   │
   └─ 可以直接操作 Admin API
```

改成：

```text
ADMIN_TOKEN
   │
   └─ ONLY
      POST /api/admin/session
```

永久 `ADMIN_TOKEN` 改成：

> Admin bootstrap credential

而不是：

> Admin API master key

---

# 6. `/api/admin/session` 登入流程

目前路由存在：

```text
POST /api/admin/session
```

新的驗證順序應改成：

```text
Cloudflare Access
       ↓
Admin Login Rate Limit
       ↓
Turnstile
       ↓
ADMIN_TOKEN timing-safe comparison
       ↓
建立 Admin Session
```

### 特別注意驗證順序

目前程式是先比較 `ADMIN_TOKEN`，再做 Turnstile。

應修改成：

```text
1. Rate Limit
2. Turnstile
3. ADMIN_TOKEN
```

讓攻擊者不能免費大量測試 ADMIN_TOKEN。

---

# 7. Admin Login Rate Limit

新增獨立 Worker Rate Limiting binding，例如：

```text
ADMIN_LOGIN_RATE_LIMITER
```

不要和目前：

```text
FILE_BROWSER_RATE_LIMITER
```

共用 namespace。

建議初始限制：

```text
POST /api/admin/session

5 requests / minute / IP
```

Key：

```text
CF-Connecting-IP
```

本機開發則使用固定 local development key。

超過限制：

```http
HTTP 429 Too Many Requests
```

回應不應透露：

```text
ADMIN_TOKEN 是否部分正確
Turnstile 是否正確
管理員帳號是否存在
```

統一使用中性訊息。

---

# 8. ADMIN_TOKEN 強度驗證

正式環境啟動時應驗證：

```text
ADMIN_TOKEN 必須存在
```

並至少要求：

```text
>= 32 bytes / 足夠長度的高熵 token
```

不接受容易猜測的 password 型值。

部署文件應明確建議：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

產生新的 token。

### 公開 repository 前

建議直接執行一次：

```text
ADMIN_TOKEN rotation
```

讓公開前後形成清楚的 credential boundary。

---

# 9. Admin API 不再接受 Bearer Token

修改：

```text
adminAuthMiddleware
```

目前邏輯是：

```text
Bearer ADMIN_TOKEN
OR
Admin Session
```

改為：

```text
Admin Session ONLY
```

以下所有 API：

```text
GET    /api/admin/status

GET    /api/admin/files
DELETE /api/admin/files/:fileId

GET    /api/admin/invitations
POST   /api/admin/invitations
POST   /api/admin/invitations/:id/copy
POST   /api/admin/invitations/:id/reissue
DELETE /api/admin/invitations/:id

POST   /api/admin/cleanup
POST   /api/admin/reconcile
```

全部不得再接受：

```http
Authorization: Bearer ADMIN_TOKEN
```

你目前的 Admin APIs 都集中在同一個 `adminRoutes`，所以這次改造邊界相當乾淨。

---

# 10. Admin Session

保留目前設計：

```text
random 256-bit session token
↓
D1 只保存 hash
↓
HttpOnly Cookie
↓
Secure
↓
SameSite=Strict
```

Session TTL：

```text
4 hours
```

維持不變。

因此 Access 與 App Session 是兩套獨立機制：

```text
Cloudflare Access Session
24h

+

Temp Storage Admin Session
4h
```

例如：

```text
10:00 Access 登入
10:00 ADMIN_TOKEN 登入

14:00 Admin Session 過期
      ↓
重新輸入 ADMIN_TOKEN

但 Access 還有效
      ↓
不用重新 Email / Google 驗證
```

---

# 11. 新增 Revoke All Admin Sessions

新增：

```http
POST /api/admin/sessions/revoke-all
```

需要：

```text
Cloudflare Access
+
有效 Admin Session
```

行為：

```sql
UPDATE admin_sessions
SET revoked_at = current_timestamp
WHERE revoked_at IS NULL;
```

完成後：

```text
所有 Admin Session 立即失效
包含目前這個 Session
```

並清除目前瀏覽器 Admin cookie。

回傳：

```http
204 No Content
```

---

# 12. 管理 UI 新增「登出所有裝置」

`/admin` 增加安全管理操作：

```text
登出所有管理裝置
```

按下後需要 confirmation，例如：

> 這會立即撤銷所有管理員登入狀態，包括目前裝置。確定要繼續嗎？

確認後呼叫：

```text
POST /api/admin/sessions/revoke-all
```

完成後：

```text
清除 Admin UI state
↓
回到 ADMIN_TOKEN 登入畫面
```

不用強制退出 Cloudflare Access。

因此：

```text
Access ✓
Admin Session ✗
```

使用者只需要重新輸入 ADMIN_TOKEN。

---

# 13. `/files` 與 `/file/:id` 的 Admin Capability 問題

這是本次一定要處理的相容性項目。

目前 `/files` 會透過 Admin session endpoint 判斷：

```text
我是不是 Admin？
```

然後決定是否顯示：

```text
刪除
```

但是未來：

```text
/api/admin/*
```

整段會被 Cloudflare Access 保護。

因此普通朋友不能再透過：

```text
GET /api/admin/session
```

做 Admin capability detection。

---

# 14. 新增 Public Capability Endpoint

新增：

```http
GET /api/session/capabilities
```

此路徑：

```text
不受 Cloudflare Access 保護
```

回應：

普通使用者：

```json
{
  "admin": false
}
```

具有有效 Admin Session：

```json
{
  "admin": true
}
```

只能回：

```text
admin true / false
```

不得回傳：

```text
Admin session ID
Admin token
Access identity
Email
Token hash
Session hash
Expiration details
```

Response：

```http
Cache-Control: private, no-store
```

---

# 15. `/files` / `/file` UI 行為

普通朋友：

```text
GET /api/session/capabilities

{
  "admin": false
}
```

UI：

```text
預覽
下載
複製連結
```

不顯示：

```text
刪除
管理操作
```

---

管理員：

```text
Access 已登入
+
Admin Session 有效
```

取得：

```json
{
  "admin": true
}
```

UI：

```text
預覽
下載
複製連結
刪除
```

---

# 16. 刪除操作仍必須 Server-side 驗證

非常重要：

```text
admin:true
```

只是一個 UI capability。

它**絕對不能被當成授權依據**。

真正刪除：

```http
DELETE /api/admin/files/:fileId
```

仍需要：

```text
Cloudflare Access
+
Admin Session
```

所以即使有人自己在 DevTools 把：

```text
admin=false
```

改成：

```text
admin=true
```

最多只是看到一個不能用的按鈕。

真正 API 還是會拒絕。

---

# 17. Access Session 過期處理

例如管理員正在：

```text
/files
```

Access session 剛好過期。

按：

```text
刪除
```

request：

```text
DELETE /api/admin/files/ABC
```

可能在 Worker 前就被 Access 攔截。

前端應將此情況視為：

```text
Admin authentication unavailable
```

顯示：

> 管理員驗證已失效，請重新進入管理頁完成驗證。

不要顯示：

```text
刪除失敗：Unknown error
```

---

# 18. `/api/admin/session` 仍保留

保留：

```text
POST   /api/admin/session
GET    /api/admin/session
DELETE /api/admin/session
```

用途分別為：

| API    | 用途                          |
| ------ | --------------------------- |
| POST   | ADMIN_TOKEN → Admin Session |
| GET    | Admin 頁確認目前 session         |
| DELETE | 登出目前裝置                      |

但 `/files` 不再使用：

```text
GET /api/admin/session
```

而改用：

```text
GET /api/session/capabilities
```

---

# 19. Incident Response

正式文件新增：

## ADMIN_TOKEN 疑似外洩

處理順序：

```text
1. Cloudflare Worker Secret rotate ADMIN_TOKEN
2. 登入 Cloudflare Access
3. 以新 ADMIN_TOKEN 建立 Admin Session
4. Revoke All Admin Sessions
5. 檢查 Invitation 狀態
6. 檢查檔案刪除與管理操作
7. 檢查 Cloudflare / Worker logs
```

因為 Access 還在最外層：

```text
舊 ADMIN_TOKEN
+
沒有 Access identity
```

仍然無法建立 Admin Session。

---

# 20. Security Logging

Admin login 可以記錄：

```text
timestamp
requestId
success / failure
rate limited
```

但禁止記錄：

```text
ADMIN_TOKEN
Authorization header
Admin Session Token
CF_Authorization
Turnstile token
Cookie
```

IP 若需要記錄，沿用目前的 peppered / privacy-preserving 策略即可。

---

# 21. 自動化測試

至少新增以下 tests。

### Auth

```text
POST /api/admin/session
正確 Turnstile + 正確 ADMIN_TOKEN
→ 200
```

```text
錯誤 ADMIN_TOKEN
→ 401
```

```text
錯誤 Turnstile
→ 拒絕
```

```text
Rate Limit exceeded
→ 429
```

---

### Bearer Token regression

這是非常重要的一條。

```http
GET /api/admin/status
Authorization: Bearer <valid ADMIN_TOKEN>
```

必須：

```text
401
```

也就是確認：

> 正確的永久 ADMIN_TOKEN 已經不能直接操作 Admin API。

---

### Session

```text
Admin Session
→ Admin API 200
```

```text
Expired session
→ 401
```

```text
Revoked session
→ 401
```

---

### Revoke all

建立：

```text
Session A
Session B
Session C
```

呼叫：

```text
POST /api/admin/sessions/revoke-all
```

之後：

```text
A → 401
B → 401
C → 401
```

---

### Capabilities

Anonymous：

```json
{"admin": false}
```

Invitation user：

```json
{"admin": false}
```

Admin Session：

```json
{"admin": true}
```

Expired Admin Session：

```json
{"admin": false}
```

---

# 22. Cloudflare Access 無法由本機測試完全模擬

本機：

```text
pnpm dev
localhost:8976
```

不需要 Cloudflare Access。

因此本機測試架構：

```text
localhost
↓
ADMIN_TOKEN
↓
Turnstile Test Mode
↓
Admin Session
```

Production：

```text
Cloudflare Access
↓
ADMIN_TOKEN
↓
Turnstile
↓
Admin Session
```

不要為了模擬 Access 而在 Worker 裡做：

```text
if production then fake Access check
```

Access 是 infrastructure boundary，不要再造一套。

---

# 23. Production 驗收

部署後至少手動確認：

### 一般使用者

無痕視窗：

```text
/
/invite
/files
/file/:id
```

不得出現任何 Cloudflare Access login。

---

### Admin

無痕視窗：

```text
/admin
```

應先出現：

```text
Cloudflare Access
```

通過後：

```text
Temp Storage Admin Token
```

再建立：

```text
4h Admin Session
```

---

### Admin API

沒有 Access：

```text
/api/admin/status
```

應在 Worker 前就被 Cloudflare Access 阻擋。

---

### 普通使用者

```text
GET /api/session/capabilities
```

仍正常回：

```json
{"admin": false}
```

不得被 Access 阻擋。

---

# 24. Cloudflare Dashboard 待你手動完成的項目

所以回答你最後那個問題：

**對，這部分主要是你去 Cloudflare 網頁設定。**

建議流程：

```text
Cloudflare Dashboard
↓
Zero Trust
↓
Access controls
↓
Applications
↓
Create new application
↓
Self-hosted and private
↓
Add public hostname
```

這是 Cloudflare 目前官方流程。([Cloudflare Docs][5])

然後建立：

```text
Jwander Temp Storage Admin
```

加入：

```text
upload.jwander.net/admin
upload.jwander.net/admin/*
upload.jwander.net/api/admin/*
```

Allow policy：

```text
Email = 你的管理 Email
```

Session：

```text
24 hours
```

Access Free plan 目前是 **$0，50 users 以內**，所以以你目前只有管理員使用 Access 的情境，免費方案完全足夠。([Cloudflare][6])

---

# 25. 建議實作順序

我會讓 Codex按照這個順序做：

1. 新增 `ADMIN_LOGIN_RATE_LIMITER`
2. 調整 `/api/admin/session` 驗證順序
3. 移除 Admin API 的 `Bearer ADMIN_TOKEN` fallback
4. 保留 4h HttpOnly Admin Session
5. 新增 `/api/session/capabilities`
6. `/files`、`/file` 改用 capabilities 判斷 Admin UI
7. 新增 `revoke-all admin sessions`
8. 新增「登出所有管理裝置」UI
9. 補完整 tests
10. 更新 security / deployment 文件
11. 本機完整驗收
12. 部署新版 Worker
13. **你在 Cloudflare Dashboard 建立 Access**
14. Production 驗收
15. Rotate 正式 `ADMIN_TOKEN`
16. 最後再進行 Git history secret scan
17. 確認無誤後才將 repository Public

其中我特別建議 **Access 不要先開再改程式**，因為目前 `/files` 還會碰 `/api/admin/session`。先把程式改成新的 capability model，再打開 Access，切換會比較平滑。

這份規格可以直接交給 Codex 執行，核心原則就是：**朋友的路徑維持零額外摩擦，只有具破壞性與管理權限的 Admin Surface 疊上 Access + Token + Session 三層防護。**

[1]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ "https://developers.cloudflare.com/workers/configuration/cloudflare-access/"
[2]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ "https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/"
[3]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/"
[4]: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ "https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/"
[5]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/"
[6]: https://www.cloudflare.com/plans/zero-trust-services/ "https://www.cloudflare.com/plans/zero-trust-services/"
