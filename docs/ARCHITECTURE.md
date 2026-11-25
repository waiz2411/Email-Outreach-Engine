# Outreach Engine — System Architecture

## 1. Architectural Summary & Render Deployment Model

**Outreach Engine** is designed as a **single-process modular monolith** running on a **single Render Web Service** backed by a persistent disk mounted at `/var/data` (configurable locally via `DATA_DIR`).

### Why a Single Web Service Process?
1. **SQLite Persistent Disk Constraint on Render:** Render persistent disks attach exclusively to a single service instance (`numInstances: 1`). Separate Render background workers cannot mount the same disk volume simultaneously. Running Express HTTP API, static SPA serving, background sending workers, Microsoft Graph inbox monitoring, and the WhatsApp Web socket inside one Node.js process guarantees exclusive local file access to `/var/data/outreach-engine.db` with zero distributed lock hazards.
2. **SQLite Concurrency Settings:**
   - `PRAGMA journal_mode = WAL;` (allows concurrent reads alongside serialized writes)
   - `PRAGMA synchronous = NORMAL;`
   - `PRAGMA busy_timeout = 5000;`
   - `PRAGMA foreign_keys = ON;`
   - Atomic quota and job claiming transactions prevent concurrent triggers from ever exceeding an account's daily send limit or dispatching duplicate emails.
3. **Graceful Shutdown & Restart Recovery:**
   - On startup: runs pending Prisma SQLite migrations (`prisma migrate deploy`), recovers any jobs stuck in `PROCESSING` (moving them safely to `UNCERTAIN` for reconciliation instead of blind retry), restores the WhatsApp session from encrypted SQLite storage, and starts the scheduler loops.
   - On `SIGTERM`/`SIGINT`: stops claiming new jobs, allows active in-flight DB commits to complete, closes the WhatsApp socket cleanly (preserving credentials), checkpoints the WAL (`PRAGMA wal_checkpoint(TRUNCATE)`), and closes the HTTP server.

---

## 2. Repository Structure

```text
outreach-engine/
├── package.json                  # Workspace orchestration, build, test, lint, typecheck
├── tsconfig.base.json            # Strict TypeScript compiler defaults
├── render.yaml                   # Render single-web-service + persistent disk blueprint
├── .env.example                  # Documented environment variable template
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md           # This document
│   ├── MICROSOFT_OAUTH_SETUP.md  # Azure Entra ID App Registration guide
│   ├── WHATSAPP_QR_SETUP.md      # WhatsApp Web QR pairing & risk notice
│   ├── BACKUP_AND_RESTORE.md     # SQLite WAL-safe backup & restore procedures
│   ├── RENDER_DEPLOYMENT.md      # Production deployment guide
│   └── KNOWN_LIMITATIONS.md      # Provider & platform limitations
├── packages/
│   └── shared/                   # Shared strict TS domain types, Zod schemas, personalization, schedule math
├── apps/
│   ├── backend/                  # Express API, Prisma 7 + better-sqlite3, Graph, Baileys, Scheduler, Tests
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── src/
│   │       ├── config/           # Env validation & paths
│   │       ├── db/               # Prisma + better-sqlite3 WAL setup
│   │       ├── crypto/           # AES-256-GCM encryption + scrypt password hashing + HMAC signing
│   │       ├── middleware/       # Auth, CSRF, rate limiting, error handler
│   │       ├── routes/           # Modular REST API routers
│   │       ├── services/
│   │       │   ├── microsoft/    # OAuth PKCE, token refresh, Graph mail send & delta/webhook sync
│   │       │   ├── whatsapp/     # Baileys QR manager, encrypted SQLite auth state, notification worker
│   │       │   ├── engine/       # Persistent sending engine, quota reservation, uncertainty reconciliation
│   │       │   ├── leads/        # CSV/XLSX parser, validator, duplicate detector, template & export generators
│   │       │   └── tracking/     # Open pixel, HMAC-signed click redirect validator, unsubscribe, NDR/reply matcher
│   │       └── utils/            # Logger (redacting sensitive fields), sanitizer, timezone helpers
│   └── frontend/                 # React 18 + Vite + TypeScript + Tailwind + shadcn-style UI + Recharts
└── e2e/                          # Playwright end-to-end test suite
```

---

## 3. Database Schema Overview (SQLite + Prisma 7)

All persistent state resides in `DATABASE_PATH` (production default: `/var/data/outreach-engine.db`):

- **Auth & Settings:** `AdminUser`, `Session`, `SystemSettings`, `AuditLog`
- **Outlook Accounts:** `OutlookAccount` (encrypted OAuth tokens, independent daily limit, min/max delay minutes, start/end HH:mm, IANA timezone, allowed weekdays, signature HTML/toggle, WhatsApp alert opt-in, Graph subscription & delta link, `nextEligibleSendAt`), `OAuthState`, `AccountDailyCounter` (`unique(outlookAccountId, dateKey)`)
- **Leads & Suppression:** `LeadImportBatch`, `Lead`, `SuppressionEntry`
- **Campaigns & Sending Queue:** `Campaign`, `SendingJob` (`idempotencyKey` unique, `PENDING | PROCESSING | COMPLETED | FAILED | CANCELLED | UNCERTAIN`)
- **Tracking & Inbound:** `EmailMessage` (`correlationId` unique, `graphDraftId`, `graphMessageId`, `internetMessageId`, `conversationId`), `TrackingLink`, `EmailEvent`, `IncomingEmail`
- **WhatsApp:** `WhatsAppConfig`, `WhatsAppAuthEntry` (AES-256-GCM encrypted Baileys credentials & Signal keys), `WhatsAppNotificationJob` (`dedupeKey` unique, retry policy)

---

## 4. API Surface

All `/api/*` endpoints (except `/api/health`, `/api/auth/login`, `/api/auth/status`, `/api/oauth/microsoft/callback`, and `/api/webhooks/microsoft-graph`) require an authenticated admin `HttpOnly` session cookie. State-changing authenticated routes (`POST`, `PUT`, `PATCH`, `DELETE`) additionally enforce `X-CSRF-Token` validation.

- **Public / Infrastructure:**
  - `GET /api/health` — DB connectivity, schema readiness, scheduler & WhatsApp health summary (no secrets)
  - `GET /t/o/:token.gif` — Optional open tracking pixel
  - `GET /t/c/:token` — HMAC-verified click tracking redirect (`http:` / `https:` validated)
  - `GET /t/u/:token` & `POST /t/u/:token` — One-click & confirmation unsubscribe handler (adds to `SuppressionEntry`)
  - `POST /api/webhooks/microsoft-graph` — Graph change notification webhook & `validationToken` handshake
- **Authentication:** `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`
- **Dashboard & Settings:** `GET /api/dashboard`, `GET /api/settings`, `PATCH /api/settings`, `POST /api/settings/global-pause`, `GET /api/audit-logs`, `GET /api/system/backup`
- **Outlook Accounts:** `GET /api/accounts`, `POST /api/accounts/connect-url`, `GET /api/oauth/microsoft/callback`, `GET /api/accounts/:id`, `PATCH /api/accounts/:id`, `POST /api/accounts/:id/pause`, `POST /api/accounts/:id/resume`, `POST /api/accounts/:id/disconnect`, `POST /api/accounts/:id/sync-inbox`, `POST /api/accounts/:id/test-email`
- **Leads & Import/Export:** `GET /api/leads/template`, `POST /api/leads/import/preview`, `POST /api/leads/import/confirm`, `GET /api/leads/import/:batchId/invalid-report`, `GET /api/leads`, `PATCH /api/leads/:id`, `POST /api/leads/bulk`, `GET /api/leads/export`
- **Campaigns:** `GET /api/campaigns`, `POST /api/campaigns`, `GET /api/campaigns/:id`, `PATCH /api/campaigns/:id`, `GET /api/campaigns/:id/preview`, `POST /api/campaigns/:id/start`, `POST /api/campaigns/:id/pause`, `POST /api/campaigns/:id/resume`, `POST /api/campaigns/:id/stop`, `POST /api/campaigns/:id/duplicate`, `GET /api/campaigns/:id/export`
- **Activity, Analytics & Suppression:** `GET /api/emails`, `GET /api/emails/export`, `POST /api/jobs/:id/reconcile`, `GET /api/analytics`, `GET /api/suppression`, `POST /api/suppression`, `DELETE /api/suppression/:id`
- **WhatsApp Notifications:** `GET /api/whatsapp/status`, `POST /api/whatsapp/connect`, `POST /api/whatsapp/refresh-qr`, `POST /api/whatsapp/disconnect`, `DELETE /api/whatsapp/session`, `PATCH /api/whatsapp/settings`, `POST /api/whatsapp/test`, `GET /api/whatsapp/notifications`, `POST /api/whatsapp/notifications/:id/retry`

---

## 5. Background Jobs & Safety Guarantees

1. **Sending Engine Loop (tick every 5s):**
   - Skips if `SystemSettings.globalPaused` is true.
   - Evaluates active campaigns (`Campaign.status === 'ACTIVE'`) whose `OutlookAccount` is `CONNECTED` and not paused.
   - Checks account schedule window (current time in `account.timezone` with full DST awareness via `Intl.DateTimeFormat`, allowed weekdays, campaign `startDate`/`endDate`).
   - Checks `account.nextEligibleSendAt <= now` (persisted on DB so restarts preserve exact pacing).
   - Enforces daily limit atomically inside a `BEGIN IMMEDIATE` transaction on `AccountDailyCounter` (`sentCount < dailyLimit`).
   - **Idempotent Draft-then-Send Protocol:**
     1. Creates a draft via `POST /me/messages` storing `correlationId` (`X-Outreach-Correlation-Id`), returning `graphDraftId`, `internetMessageId`, `conversationId`.
     2. Persists those identifiers to SQLite BEFORE calling `POST /me/messages/{draftId}/send`.
     3. Calls `POST /me/messages/{draftId}/send`.
     4. If a crash or ambiguous timeout occurs during step 3, the job enters `UNCERTAIN` and reconciliation queries `SentItems` vs `Drafts` by `internetMessageId`/`conversationId` before ever allowing another attempt.
   - On `429 Too Many Requests` or `5xx`, respects `Retry-After` header or exponential backoff with jitter; permanent `4xx` mailbox errors (`ErrorInvalidRecipients`, etc.) stop retrying and mark the lead failed.
   - Computes randomized delay `[minDelayMinutes, maxDelayMinutes]` and persists `nextEligibleSendAt` on `OutlookAccount`.
2. **Inbox Monitor & Webhook Renewal Loop:**
   - Creates/renews Graph subscriptions when `PUBLIC_WEBHOOK_BASE_URL` / `APP_BASE_URL` is HTTPS.
   - Periodically reconciles incoming messages via Graph delta queries (`GET /me/mailFolders('Inbox')/messages/delta`) every 60 seconds as fallback so incoming replies and NDR bounces are captured reliably even without public webhooks (e.g., local dev).
   - Matches incoming messages to campaigns via `conversationId` and RFC headers (`In-Reply-To` / `References` matching stored `internetMessageId`).
   - Parses NDR / bounce notifications (`postmaster` / `Mailer-Daemon` / `multipart/report` / SMTP status codes `5.x.x` vs `4.x.x`), classifies `HARD` vs `SOFT` vs `UNKNOWN`, and suppresses permanently bounced addresses.
   - Creates deduplicated `WhatsAppNotificationJob` entries for matching events.
3. **WhatsApp Notification Worker Loop:**
   - Processes `PENDING` / `RETRYING` jobs only when `WhatsAppConfig.connectionStatus === 'CONNECTED'`.
   - Retains jobs indefinitely in SQLite while WhatsApp is disconnected; retries automatically on reconnect or manual retry.
   - Strictly restricts destination to the single configured `recipientPhoneNumber`.

---

## 6. Microsoft Graph & WhatsApp Web Evaluation

### Microsoft Graph Requirements
- **Delegated Permissions (Minimum Scope):** `openid profile email offline_access User.Read Mail.ReadWrite Mail.Send`.
- **Supported Accounts:** Both personal Microsoft accounts (`@outlook.com`, `@hotmail.com`) and Microsoft 365 Work/School tenants via `https://login.microsoftonline.com/common/oauth2/v2.0` with Authorization Code + PKCE (`S256`).
- **Delivery Confirmation Limitation:** Microsoft Graph delegated endpoints do not provide universal external SMTP delivery receipts. Sending returns `202 Accepted` (queued). The UI explicitly distinguishes **Sent / Delivery Unknown** from **Confirmed Delivery** (which is only recorded when an RFC 3464 DSN `delivered` report or recipient reply proves delivery).

### WhatsApp Web Library Selection (`@whiskeysockets/baileys`)
- **Evaluated Options:**
  - `@whiskeysockets/baileys` (`7.0.0-rc14`, MIT license): Pure Node.js WebSocket implementation of WhatsApp Web Noise/Protobuf multi-device protocol; zero headless browser; ~150–200 MB RAM; works natively in Render Node.js runtime without Docker/Chromium.
  - `whatsapp-web.js` (Apache-2.0): Drives Puppeteer/Chromium (~450–650 MB RAM + Linux system dependencies requiring Docker); prone to OOM on Render Starter (512 MB RAM).
- **Decision:** Use `@whiskeysockets/baileys` with a custom AES-256-GCM encrypted SQLite `AuthenticationState` adapter so credentials survive Render redeploys without storing plaintext keys.
- **Risks & Limitations:** Unofficial WhatsApp Web protocol automation is unsupported by Meta/WhatsApp. Sessions can disconnect unexpectedly on protocol changes or WhatsApp security checks, and excessive/unsolicited messaging can lead to account warnings or bans. This engine explicitly prohibits bulk WhatsApp messaging and restricts outbound alerts strictly to the administrator's single configured recipient number.
