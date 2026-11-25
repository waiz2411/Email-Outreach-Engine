# Render Deployment Guide

Outreach Engine is engineered to deploy as a **single Render Web Service** with an attached **Render Persistent Disk** (`/var/data`), requiring **no paid external database service**.

## 1. Blueprint Deployment (`render.yaml`)

The repository includes a ready-to-use `render.yaml` Blueprint:
- **Runtime:** `node` (Node.js >= 20)
- **Plan:** `starter` or higher (required by Render to attach a Persistent Disk; Render Free tier uses ephemeral disks)
- **Instances:** `numInstances: 1` (required for SQLite single-writer consistency)
- **Disk:** `mountPath: /var/data`, `sizeGB: 1` (or larger)
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm run start` (automatically applies `npx prisma migrate deploy` before launching `node dist/index.js`)
- **Health Check Path:** `/api/health`

## 2. Required Environment Variables

Configure these values in the Render Dashboard (**Environment** tab):

| Variable | Example / Notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `10000` (Render default) |
| `DATA_DIR` | `/var/data` |
| `DATABASE_PATH` | `/var/data/outreach-engine.db` |
| `DATABASE_URL` | `file:/var/data/outreach-engine.db` |
| `APP_BASE_URL` | `https://your-service.onrender.com` (or custom HTTPS domain) |
| `ADMIN_EMAIL` | Your administrator email address |
| `ADMIN_INITIAL_PASSWORD` | Strong 12+ character password with upper, lower, and number |
| `SESSION_SECRET` | Auto-generated 64-hex secret |
| `ENCRYPTION_KEY` | Auto-generated 64-hex secret (never rotate without re-authenticating tokens or re-encrypting!) |
| `TRACKING_SECRET` | Auto-generated 64-hex secret |
| `MICROSOFT_TENANT_ID` | `common` |
| `MICROSOFT_CLIENT_ID` | From Azure Entra App Registration |
| `MICROSOFT_CLIENT_SECRET` | From Azure Entra App Registration |
| `MICROSOFT_REDIRECT_URI` | `https://your-service.onrender.com/api/oauth/microsoft/callback` |

## 3. Domain & HTTPS

- Render provisions TLS/HTTPS automatically for `*.onrender.com` and custom domains.
- Once your final URL is known, verify **both** `APP_BASE_URL` and `MICROSOFT_REDIRECT_URI` match your exact `https://` origin, and ensure that exact callback URL is listed in your Azure App Registration.
- Note: Express configures `app.set('trust proxy', 1)` so `Secure` session cookies and rate-limiting client IPs work accurately behind Render's TLS reverse proxy.

## 4. Restart & Redeploy Recovery Behavior

- During Render deploys with a persistent disk, Render shuts down the old container cleanly (`SIGTERM`) before attaching `/var/data` to the new container.
- Outreach Engine handles `SIGTERM` by stopping new job claims, disconnecting the WhatsApp socket gracefully (keeping encrypted credentials in SQLite), and checkpointing the SQLite WAL.
- On boot, `SendingEngine.recoverInterruptedJobs()` moves any mid-flight `PROCESSING` jobs to `UNCERTAIN` so no duplicate emails are blindly sent, and `WhatsAppService` automatically restores your encrypted WhatsApp session and resumes queued notifications.
