# Security & Deployment Checklist

> **Last updated**: 2026-06-26
> **Project**: Micheal Church Backend
> **Target audience**: Administrators deploying to production

---

## 1. Secret History Verification

Run these **before every deployment** to verify no secrets have been accidentally committed.

### 1.1 Check for .env files in git history

```powershell
# PowerShell — from project root
cd D:\MyProjects\micheal-church

# Check if .env was ever committed
git log --all --full-history --diff-filter=A -- '*.env' '.env'

# Check if backend .env was ever committed (if the file exists)
git log --all --full-history -- 'backend/.env'

# Show any .env that exists in any commit
git log --all --oneline -- '**/.env'
```

### 1.2 Check for secure/ directory in git history

```powershell
# Check if secure/ was ever committed
git log --all --full-history -- 'backend/secure/*'

# List all files currently in secure/ (should be gitignored)
Get-ChildItem -Recurse backend/secure -ErrorAction SilentlyContinue
```

### 1.3 Check for backup archives

```powershell
# Check if backup archives were ever committed
git log --all --full-history -- '*.archive.gz' '*.gz'

# List any archive files on disk
Get-ChildItem -Recurse . -Filter '*.archive.gz' -ErrorAction SilentlyContinue
```

### 1.4 Check for spreadsheets and import reports

```powershell
# Check if xlsx files were committed
git log --all --full-history -- '*.xlsx'

# List xlsx files on disk
Get-ChildItem -Recurse . -Filter '*.xlsx' -ErrorAction SilentlyContinue
```

### 1.5 Check for service account files

```powershell
# Check for Google OAuth files
git log --all --full-history -- '*google-oauth*' '*service-account*' '*client_secret*'

# List any on disk (should be gitignored)
Get-ChildItem -Recurse . -Include '*google-oauth*','*service-account*','*client_secret*' -ErrorAction SilentlyContinue
```

### 1.6 Run the automated secret scan

```powershell
cd backend
node scripts/scan-secrets.js
```

**Exit code 0** = clean. **Exit code 1** = findings — review and address before deploying.

### 1.7 Check that .gitignore blocks all sensitive patterns

```powershell
# Verify these patterns exist in root .gitignore:
Select-String -Path .gitignore -Pattern '\.env$|secure/|tmp/|logs/|google-oauth|client_secret|service-account|\.xlsx$|\.archive\.gz'

# Verify backend .gitignore has the same patterns:
Select-String -Path backend/.gitignore -Pattern '\.env$|secure/|tmp/|logs/|\.xlsx$|\.archive\.gz'
```

### ⚠️ If any secrets were ever committed

1. **Rotate immediately** (see Section 2)
2. **Rewrite history** if the repo is private and small:
   ```powershell
   # DANGER: rewrites history. Only do this if you understand the consequences.
   git filter-branch --force --index-filter "git rm --cached --ignore-unmatch .env backend/.env backend/secure/*" --prune-empty --tag-name-filter cat -- --all
   ```
3. **Or accept the risk** and rotate — the old secrets are no longer valid
4. **Document the incident** in a private security log

---

## 2. Secret Rotation Checklist

If any secret was exposed or you're setting up production for the first time,
rotate every credential listed below.  **Never reuse development secrets in production.**

| # | Secret | How to rotate | Config key |
|---|--------|--------------|------------|
| 1 | JWT Access Secret | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` | `JWT_ACCESS_SECRET` |
| 2 | JWT Refresh Secret | Generate another value (different from access secret) | `JWT_REFRESH_SECRET` |
| 3 | MongoDB URI | Change password in MongoDB Atlas / self-hosted, update connection string | `MONGO_URI` |
| 4 | Redis Password | Change in Redis config, update env | `REDIS_PASSWORD` |
| 5 | R2 Access Key ID | Rotate in Cloudflare dashboard → R2 → Manage API tokens | `R2_ACCESS_KEY_ID` |
| 6 | R2 Secret Access Key | Rotate alongside key ID | `R2_SECRET_ACCESS_KEY` |
| 7 | R2 Bucket Name | Create a new bucket if old one was compromised | `R2_BUCKET_NAME` |
| 8 | SMTP Password | Rotate in email provider dashboard | `SMTP_PASS` |
| 9 | VAPID Private Key | Generate: `npx web-push generate-vapid-keys` | `VAPID_PRIVATE_KEY` |
| 10 | VAPID Public Key | Pair with new private key | `VAPID_PUBLIC_KEY` |
| 11 | Google OAuth Client | Delete old credentials in Google Cloud Console, create new ones | `GOOGLE_OAUTH_CLIENT_FILE` |
| 12 | Google OAuth Token | Re-run: `npm run google-drive:authorize` | `GOOGLE_OAUTH_TOKEN_FILE` |
| 13 | Service Account Key | Delete old key in Google Cloud Console, create new one | `*service-account*.json` |
| 14 | Google Drive Folder ID | Create new folder, update env | `GOOGLE_DRIVE_FOLDER_ID` |

**After rotation**: restart the server. Verify it starts without errors.
Check logs for any credential-related failures.

---

## 3. Pre-Deployment Checklist

Run these checks **before every production deployment**.

### 3.1 Backend tests

```powershell
cd backend
npx jest --no-coverage --verbose
```

**Gate**: All tests must pass. Current expected: 193 tests, 11 suites, 0 failures.

### 3.2 Secret scan

```powershell
cd backend
node scripts/scan-secrets.js
```

**Gate**: Exit code 0. No high-confidence findings.

### 3.3 Backend syntax checks

```powershell
cd backend
node -c src/server.js
node -c src/app.js
node -c src/config/env.js
# Add any other files you modified
```

### 3.4 Frontend build

```powershell
cd frontend
$env:CI = "false"
npx react-scripts build
```

**Gate**: Build completes without errors. Message: "The build folder is ready to be deployed."

### 3.5 Environment variables

Verify all required production variables are set in your deployment environment.
Copy `backend/.env.example` as a template and fill in every value marked with
`replace-with-` or left empty.

**Critical production settings**:

| Variable | Production value | Why |
|----------|-----------------|-----|
| `NODE_ENV` | `production` | Enables production security checks |
| `JWT_ACCESS_SECRET` | ≥ 32 chars, random | Auth security |
| `JWT_REFRESH_SECRET` | ≥ 32 chars, random | Auth security |
| `MONGO_URI` | Real cluster URI | Data persistence |
| `CORS_ORIGIN` | Your frontend domain | No wildcard with credentials |
| `ENABLE_API_DOCS` | `false` | Don't expose Swagger in production |
| `R2_REQUIRED` | `true` if uploads needed | Fail-fast on missing R2 config |
| `TRUST_PROXY` | `1` or `true` | Behind reverse proxy/load balancer |
| `RATE_LIMIT_MAX` | `600` or higher | Production traffic |
| `REDIS_REQUIRED` | `true` | Don't silently fall back to in-memory in production |
| `BACKUP_ENABLED` | `true` if backups wanted | Data safety |

### 3.6 Redis connectivity

Redis is used for session storage, rate limiting, and token blacklisting.
The server falls back to an **in-memory store** if Redis is unavailable AND
`REDIS_REQUIRED` is `false`.  In production, set `REDIS_REQUIRED=true` so the
server refuses to start without Redis.

```powershell
# Verify Redis connectivity (example using redis-cli)
redis-cli -h <redis-host> -p <redis-port> -a <password> PING
# Expected: PONG
```

### 3.7 MongoDB connectivity

```powershell
# Verify MongoDB connectivity (example using mongosh)
mongosh "<MONGO_URI>" --eval "db.runCommand({ping:1})"
# Expected: { ok: 1 }
```

### 3.8 API docs disabled in production

Ensure `ENABLE_API_DOCS=false` in production `.env`. The Swagger UI at
`/api/docs` must not be publicly accessible.

---

## 4. Post-Deployment Smoke Tests

Run these after deploying to verify the system is healthy.

### 4.1 Health endpoint

```powershell
$BASE = "https://your-domain.com"
Invoke-RestMethod -Uri "$BASE/api/health" | Select-Object success, message
```
**Expected**: `{ success: true, message: "Server is healthy" }`

### 4.2 Login

```powershell
$body = @{ identifier = "user-phone-or-email"; password = "user-password" } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "$BASE/api/auth/login" -Method Post -Body $body -ContentType "application/json"
# Verify: $response.data.accessToken is not null
# Verify: $response.data.effectivePermissions is an array
```

### 4.3 Refresh token

```powershell
$body = @{ refreshToken = $response.data.refreshToken } | ConvertTo-Json
$refresh = Invoke-RestMethod -Uri "$BASE/api/auth/refresh" -Method Post -Body $body -ContentType "application/json"
# Verify: $refresh.data.accessToken is a new token
```

### 4.4 Current user (permissions)

```powershell
$headers = @{ Authorization = "Bearer $($response.data.accessToken)" }
$me = Invoke-RestMethod -Uri "$BASE/api/auth/me" -Headers $headers
# Verify: $me.data.role is set
# Verify: $me.data.effectivePermissions is populated
```

### 4.5 Public booking (upload + create)

```powershell
# Step 1: Upload an image
$imageBytes = [System.IO.File]::ReadAllBytes("test-image.png")
$form = @{ bookingTypeId = "<valid-type-id>"; fieldKey = "photo" }
$uploadResult = Invoke-RestMethod -Uri "$BASE/api/bookings/public/upload-image" -Method Post -Form $form -InFile "test-image.png"
# Verify: $uploadResult.data.uploadToken is not null

# Step 2: Create booking with the upload token
$bookingBody = @{
  bookingTypeId = "<valid-type-id>"
  requesterName = "Smoke Test"
  requesterPhone = "01000000000"
  scheduledDate = "2026-06-20"
  scheduledTime = "10:00"
  dynamicFields = @(@{ key = "photo"; value = @{ uploadToken = $uploadResult.data.uploadToken } })
} | ConvertTo-Json -Depth 5
$booking = Invoke-RestMethod -Uri "$BASE/api/bookings/public" -Method Post -Body $bookingBody -ContentType "application/json"
# Verify: 201 Created, booking ID returned
```

### 4.6 Booking confirmation (capacity)

```powershell
# Requires authenticated admin
$patchBody = @{ status = "confirmed" } | ConvertTo-Json
$confirmed = Invoke-RestMethod -Uri "$BASE/api/bookings/$bookingId" -Method Patch -Body $patchBody -ContentType "application/json" -Headers $adminHeaders
# Verify: status is "confirmed"
```

### 4.7 Notification link safety

```powershell
# Verify that notification links are restricted to relative paths
# (Manual check: create a notification and inspect the stored data)
```

### 4.8 Socket revocation

```powershell
# Manual check: lock a user account, verify their socket disconnects
# (Requires a WebSocket client connected as the target user)
```

### 4.9 Backup status (if enabled)

```powershell
# Check logs for backup activity
# Or check Google Drive for recent backup files
```

---

## 5. Rollback Checklist

If the deployment fails or introduces a critical issue.

### 5.1 Revert deployment

```powershell
# If using git tags for deployment:
git checkout <previous-stable-tag>

# If using a deployment script, re-run with the previous version
```

### 5.2 Restore environment

```powershell
# If .env was changed:
# Restore from backup:
copy .env.backup .env
# Or revert to known-good settings
```

### 5.3 Verify database integrity

```powershell
# Check that no migration ran that would require rollback
# If DB changes occurred, restore from the most recent backup
# (See backup section in README.md)
```

### 5.4 Disable scheduled jobs temporarily

If scheduled jobs are causing issues, stop them by setting these env vars
and restarting:

```env
BACKUP_ENABLED=false
# The booking cleanup and reconciliation jobs also stop
# when the server is not running.
```

### 5.5 Restart with previous version

```powershell
cd backend
npm start
# Monitor logs for errors
```

---

## 6. Manual Data Safety Notes

### Local files that must NEVER be committed

| File/Folder | Reason | Gitignored? |
|-------------|--------|-------------|
| `backend/.env` | All secrets | ✅ `.gitignore` |
| `frontend/.env` | Frontend config | ✅ `.gitignore` |
| `backend/secure/` | OAuth tokens, service accounts | ✅ `.gitignore` |
| `backend/tmp/` | Temporary backups | ✅ `.gitignore` |
| `backend/logs/` | Server logs | ✅ `.gitignore` |
| `*.xlsx` | Church database spreadsheets | ✅ `.gitignore` |
| `*.archive.gz` | Backup archives | ✅ `.gitignore` |
| `google-oauth-token.json` | OAuth token | ✅ `.gitignore` |
| `client_secret*.json` | OAuth client secrets | ✅ `.gitignore` |
| `*service-account*.json` | Service account keys | ✅ `.gitignore` |

### Spreadsheet files on disk

```
Church.DB.xlsx     — 586 KB (in project root, gitignored)
finalchdb.xlsx     — 605 KB (in project root, gitignored)
```

These are gitignored by `*.xlsx` pattern. **Do not delete** — they are
user data imported from Excel. If they contain sensitive member information,
store them outside the project directory or encrypt them.

### Backup archives

No `.archive.gz` files found on disk. If created by the backup system,
they will be stored in `backend/tmp/backups/` (gitignored).

### Google OAuth files

Expected locations (gitignored):
- `backend/secure/google-oauth-client.json`
- `backend/secure/google-oauth-token.json`

If these files exist, run `node scripts/scan-secrets.js` to confirm they
are not tracked by git.

---

## 7. AI Feature Controls

AI is **disabled by default** (`AI_ENABLED=false`). Work through this section
only when deliberately enabling it.

### Before enabling

- [ ] Confirm the central audit module is deployed and `auditLog` is receiving
      `auth.login` and `permission.denied` events. AI events have nowhere to go
      without it, and an unauditable AI feature must not be turned on.
- [ ] Set `ANTHROPIC_API_KEY` (primary) and `OPENAI_API_KEY` (fallback) as
      platform secrets. Never commit them; `scripts/scan-secrets.js` detects
      `sk-ant-`, `sk-proj-`, `AIza`, and related patterns.
- [ ] Leave `AI_PROVIDER_GEMINI_ENABLED=false`. Google's unpaid tier permits
      training on prompts and human review, and the automatic paid-terms
      carve-out does not cover this deployment's region. Enabling it also
      requires `AI_GEMINI_BILLING_VERIFIED=true`, and the server refuses to boot
      otherwise.
- [ ] Confirm `DEEPSEEK_API_KEY` is **not** set. DeepSeek is a rejected provider
      and production refuses to boot when a credential for it is present.
- [ ] Review `AI_DAILY_SPEND_USD` and `AI_MONTHLY_SPEND_USD`. Reaching the
      monthly ceiling stops all AI usage until the next month.

### Rollout order

1. `AI_ENABLED=true` with no user holding an AI permission — nothing changes for
   anyone, but the wiring is live and observable.
2. Grant `AI_DRAFT_CONTENT` to one SUPER_ADMIN via `extraPermissions`.
3. Extend to three admins. Watch draft acceptance and the `aiUsage` collection.
4. Extend further only if the stop conditions below stay clear.

AI permissions are additive and belong to **no** role by default: each endpoint
requires the AI permission *and* the matching domain permission, so AI can never
grant access a user did not already have.

### Stop conditions — any one halts the rollout immediately

- [ ] Any single `ai.redaction_blocked` event in production. Treat it as a
      security incident, not a metric: it means a caller assembled a payload the
      design forbids.
- [ ] Draft acceptance below 30% after two weeks.
- [ ] Spend exceeding three times the budget.
- [ ] Any incorrect number reaching a user through the analytics narrative.

### Turning it off

`AI_ENABLED=false` plus a restart disables every AI path immediately. Flags are
read per request rather than cached at boot, so no deploy is required. The
features are read-only and write nothing, so disabling has **zero data impact** —
the notification form and the analytics page simply revert to their previous
behaviour.

---

## 8. Quick-Reference Commands

```powershell
# Run all backend tests
cd backend && npx jest --no-coverage --verbose

# Run secret scan
cd backend && node scripts/scan-secrets.js

# Build frontend
cd frontend && $env:CI="false"; npx react-scripts build

# Check git for uncommitted changes
git status --short

# Check git for sensitive files in history
git log --all --oneline -- '**/.env' '**/secure/*' '*.xlsx' '*.archive.gz'

# Health check
Invoke-RestMethod http://localhost:5000/api/health

# Generate a secure random secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
