# Known Limitations & Troubleshooting

## 1. Microsoft Graph & Email Tracking Limitations
- **Delivery Confirmation:** Microsoft Graph's send endpoint returns `202 Accepted` once the message is queued by Exchange/Outlook. It does **not** guarantee inbox placement at the recipient's server. Emails remain `DELIVERY_UNKNOWN` unless an explicit RFC 3464 delivery receipt (`Action: delivered`) or a verified recipient reply arrives.
- **Open & Click Tracking Estimates:** Many corporate mail servers, Outlook privacy protections, and Apple Mail Privacy Protection block remote images (causing false negatives) or pre-fetch pixels and links via security scanners (causing false positives). Never treat open counts as definitive proof that a human read an email.
- **Bounce Detection:** Bounces are detected by syncing Non-Delivery Reports (NDRs) arriving in the sender's Inbox. If an external SMTP relay suppresses or strips standard RFC 3464 status codes (`5.x.x` / `4.x.x`), the bounce is recorded honestly as `UNKNOWN` bounce type.
- **Microsoft Sending Limits:** Always configure conservative daily limits (e.g., 20–100/day for personal/newer accounts) and delays. Personal `@outlook.com` accounts have stricter anti-spam throttling than paid Microsoft 365 mailboxes.

## 2. WhatsApp Web Integration Limitations
- **Unofficial Protocol:** `@whiskeysockets/baileys` implements the WhatsApp Web multi-device protocol via WebSocket. WhatsApp may periodically change protocol handshakes or drop connections (`515` restart required, or `401` logged out).
- **Account Risk:** Sending bulk or unsolicited WhatsApp messages violates WhatsApp Terms of Service and can result in account bans. Use this integration solely for personal incoming-email alerts to your single configured main number.
- **QR Expiration:** QR tokens expire after ~55 seconds. Click **Refresh QR Code** if not scanned in time.

## 3. SQLite & Render Single-Instance Constraints
- **Single Instance Only (`numInstances: 1`):** SQLite on a Render Persistent Disk supports one running container instance. Do not enable horizontal autoscaling.
- **Paid Plan Required for Persistence:** Render's Free tier destroys local filesystem changes on sleep/redeploy. You must select Render **Starter** (or higher) with a disk mounted at `/var/data`.
- **Brief Deploy Downtime:** Render performs stop-then-start deploys (not zero-downtime rolling overlap) when a persistent disk is attached so the disk volume mounts exclusively.

## 4. Troubleshooting Checklist
- **"Invalid or missing CSRF token" after redeploy:** Refresh the page or sign in again so the browser retrieves a fresh session CSRF token.
- **OAuth fails with `AADSTS65001` / admin consent required:** Your Microsoft 365 organization restricts user consent. Have your tenant admin approve the App Registration or connect a personal Outlook account.
- **Job stuck in `UNCERTAIN`:** Open **Email Activity** and click **Reconcile Safely** to check Outlook `SentItems` vs `Drafts` before retrying.
- **WhatsApp stuck in `RECONNECTING` or `LOGGED_OUT`:** Open **WhatsApp Notifications**, click **Delete Stored Session**, then **Connect WhatsApp** and scan a fresh QR code.
