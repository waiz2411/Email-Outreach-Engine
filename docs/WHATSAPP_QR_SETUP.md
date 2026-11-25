# WhatsApp Web QR Setup & Usage Guide

Outreach Engine uses `@whiskeysockets/baileys` (MIT license) to connect an existing WhatsApp or WhatsApp Business number via a WhatsApp Web-style QR code scan.

> **Important Risk & Policy Notice:**
> Unofficial WhatsApp Web protocol libraries are not endorsed by WhatsApp/Meta. Automated or high-volume messaging can trigger session disconnections or account restrictions/bans. Outreach Engine strictly restricts WhatsApp usage to **personal email/reply/error alerts sent only to your single configured main WhatsApp number**. Bulk WhatsApp messaging and arbitrary recipient messaging are intentionally prohibited.

## 1. Linking Your WhatsApp Account

1. Sign in to Outreach Engine and open **WhatsApp Notifications**.
2. On the **WhatsApp Connection** card, click **Connect WhatsApp**.
3. Wait a moment for the backend to generate a dynamic QR code image.
4. On your phone:
   - Open **WhatsApp** (or **WhatsApp Business**)
   - Go to **Settings -> Linked Devices** (or menu **Linked devices** on Android)
   - Tap **Link a Device**
   - Scan the QR code displayed on the screen.
5. Once authenticated, the status updates to **CONNECTED** and displays your linked phone number.

If a QR code expires (~55 seconds) before you scan it, click **Refresh QR Code** to generate a fresh token.

## 2. Configuring Your Main Recipient Number

1. Under **Notification Recipient & Alert Rules**, find **Send email alerts to this WhatsApp number**.
2. Enter your main WhatsApp number in strict international E.164 format (for example `+14155550199` or `+923001234567`) and click **Save**.
3. Click **Send Test Notification** to verify real message delivery from the linked number to your main number.
   - Note: If your linked device number and recipient number are the same number, Baileys sends the alert to your own WhatsApp "Message Yourself" JID.

## 3. Session Persistence Across Restarts

- Your WhatsApp credentials and Signal keys are **AES-256-GCM encrypted** and saved in SQLite (`WhatsAppAuthEntry`) on the Render persistent disk (`/var/data/outreach-engine.db`).
- Normal restarts and Render redeployments automatically restore the session without requiring a new QR scan, unless you manually log out from Linked Devices on your phone or click **Delete Stored Session**.
- If WhatsApp disconnects while incoming Outlook emails arrive, incoming email events are still saved in SQLite and their WhatsApp notification jobs stay queued in `PENDING`/`RETRYING` status until the session reconnects or you click **Retry**.
