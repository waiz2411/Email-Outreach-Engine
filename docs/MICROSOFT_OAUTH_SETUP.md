# Microsoft OAuth 2.0 Setup Guide (Outlook & Microsoft 365)

Outreach Engine connects to your Outlook accounts using Microsoft OAuth 2.0 Authorization Code Flow with PKCE (`S256`) and delegated Microsoft Graph permissions. Your Outlook password is never requested or stored.

## 1. Create an Azure / Microsoft Entra App Registration

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com/) (or Azure Portal -> **App registrations**).
2. Click **New registration**.
3. Set **Name**: `Outreach Engine` (or your preferred name).
4. Set **Supported account types**:
   - Choose **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)** so both personal `@outlook.com`/`@hotmail.com` and Microsoft 365 accounts can sign in.
5. Set **Redirect URI**:
   - Platform: **Web**
   - Local development URI: `http://localhost:3001/api/oauth/microsoft/callback`
   - Production Render URI: `https://<your-app>.onrender.com/api/oauth/microsoft/callback`
   *(You can add both URIs under Authentication -> Web -> Redirect URIs.)*
6. Click **Register**.

## 2. Create a Client Secret

1. Open **Certificates & secrets** -> **Client secrets** -> **New client secret**.
2. Copy the **Value** immediately (it is hidden after leaving the page) and save it as `MICROSOFT_CLIENT_SECRET`.
3. Copy the **Application (client) ID** from the **Overview** page and save it as `MICROSOFT_CLIENT_ID`.

## 3. Configure Delegated API Permissions

1. Open **API permissions** -> **Add a permission** -> **Microsoft Graph** -> **Delegated permissions**.
2. Add only these minimum required delegated permissions:
   - `User.Read` (verify your connected mailbox email and profile)
   - `Mail.ReadWrite` (create drafts for correlation tracking and read incoming replies/NDRs)
   - `Mail.Send` (send messages from your authorized mailbox)
   - `offline_access` (issue refresh tokens so background sending works continuously)
   - `openid`, `profile`, `email`
3. Do **not** add organization-wide application permissions (`Mail.Read.All`, `Mail.Send.All`).

## 4. Environment Variables

```env
MICROSOFT_TENANT_ID=common
MICROSOFT_CLIENT_ID=<your-application-client-id>
MICROSOFT_CLIENT_SECRET=<your-client-secret>
MICROSOFT_REDIRECT_URI=https://your-app.onrender.com/api/oauth/microsoft/callback
```

## 5. Administrator Consent in Work/School Tenants

If you connect a Microsoft 365 Work or School account whose IT organization restricts user consent (`AADSTS65001` or `AADSTS90094`), Outreach Engine will display an explicit message explaining that tenant administrator approval is required. Either:
- Ask your Microsoft 365 tenant administrator to grant consent for your App Registration, **or**
- Connect a personal `@outlook.com` / `@hotmail.com` account (which allows self-consent).
