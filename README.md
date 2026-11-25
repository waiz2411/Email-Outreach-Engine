# Outreach Engine

A self-hosted personal multi-account Outlook email outreach engine with persistent SQLite background scheduling, email tracking/analytics, and WhatsApp Web QR notifications — ready for single-service deployment on Render with a persistent disk.

## Key Capabilities

- **Administrator-Only Security:** `scrypt` password hashing, `HttpOnly` session cookies, `X-CSRF-Token` validation, auth rate limiting, AES-256-GCM encryption at rest for OAuth tokens and WhatsApp session credentials, and zero tokens stored in frontend `localStorage`/`sessionStorage`.
- **Multi-Account Outlook Management:** Connect multiple personal Outlook (`@outlook.com`, `@hotmail.com`) and Microsoft 365 accounts via Microsoft OAuth 2.0 Authorization Code + PKCE (`User.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`). Each account keeps independent daily send limits, randomized delay ranges, timezone/DST-aware schedules, signatures, lead lists, campaigns, and analytics.
- **Lead Management & Personalization:** Downloadable CSV/XLSX templates, row-level validation, duplicate detection & resolution, invalid row CSV reports, `{{variable}}` personalization, HTML sanitization, and bulk actions.
- **Persistent Sending Engine:** Survives browser closure and server restarts via SQLite WAL + atomic `BEGIN IMMEDIATE` quota reservation, draft-then-send correlation IDs, `UNCERTAIN` crash recovery & reconciliation, HTTP `429` `Retry-After` backoff, Test Mode, Global/Account/Campaign pause, and suppression enforcement.
- **Honest Email Tracking & Inbox Monitoring:** Distinguishes `Sent / Delivery Unknown` from provider-confirmed deliveries (DSN receipts or replies), optional open pixel & HMAC-signed click tracking (no open redirects), hard/soft/unknown NDR bounce classification, and reply threading (`In-Reply-To` / `References` / `conversationId`).
- **WhatsApp Web QR Notifications:** Connects an existing WhatsApp device via dynamic QR code (`@whiskeysockets/baileys`), stores encrypted credentials in SQLite on the persistent disk, and sends incoming email/reply/error alerts strictly to your configured main international WhatsApp number with queued retries on disconnection.

## Repository Structure

```text
outreach-engine/
├── package.json              # npm workspaces root scripts
├── tsconfig.base.json        # Strict TypeScript defaults
├── render.yaml               # Render single web service + persistent disk blueprint
├── .env.example              # Environment template
├── docs/                     # Architecture, OAuth, WhatsApp, Backup, Render & Limitations guides
├── packages/shared/          # Shared Zod schemas, personalization, schedule math, bounce parser
├── apps/backend/             # Express API, Prisma 7 + better-sqlite3, Graph, Baileys, SendingEngine
├── apps/frontend/            # React + TypeScript + Vite + Tailwind + Recharts SaaS UI
└── e2e/                      # Playwright end-to-end suite
```

## Local Development Quickstart

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Create `.env` from template:**
   ```bash
   cp .env.example .env
   ```
   Generate strong secrets for `SESSION_SECRET`, `ENCRYPTION_KEY`, and `TRACKING_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. **Run database migrations:**
   ```bash
   npm run db:migrate
   ```
4. **Start dev servers (shared watcher + backend API + Vite frontend):**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173`.

## Testing & Verification Commands

- **Build all workspaces:** `npm run build`
- **Strict TypeScript typecheck:** `npm run typecheck`
- **ESLint:** `npm run lint`
- **Unit & Integration tests (Vitest):** `npm run test`
- **End-to-End tests (Playwright):** `npm run test:e2e`

## Documentation

- [System Architecture](docs/ARCHITECTURE.md)
- [Microsoft OAuth Setup Guide](docs/MICROSOFT_OAUTH_SETUP.md)
- [WhatsApp QR Setup & Risk Notice](docs/WHATSAPP_QR_SETUP.md)
- [Render Deployment Guide](docs/RENDER_DEPLOYMENT.md)
- [Database Backup & Restore](docs/BACKUP_AND_RESTORE.md)
- [Known Limitations & Troubleshooting](docs/KNOWN_LIMITATIONS.md)
