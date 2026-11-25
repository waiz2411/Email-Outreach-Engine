import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  corsOrigins: string[];
  dataDir: string;
  databasePath: string;
  databaseUrl: string;
  sessionSecret: string;
  encryptionKey: string;
  trackingSecret: string;
  sessionTtlHours: number;
  adminEmail: string;
  adminInitialPassword?: string;
  adminPasswordHash?: string;
  microsoftTenantId: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftRedirectUri: string;
  sendingEnginePollMs: number;
  inboxSyncPollMs: number;
  whatsappAutoInit: boolean;
}

function isPlaceholderSecret(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return (
    trimmed.length < 32 ||
    trimmed.startsWith('replace-with') ||
    trimmed.includes('do-not-use-in-prod')
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === 'production'
      ? 'production'
      : env.NODE_ENV === 'test'
        ? 'test'
        : 'development';

  const port = Number(env.PORT || 3001);
  const appBaseUrl = (env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const corsOrigins = (env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const dataDir = path.resolve(process.cwd(), env.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });

  const databasePath = path.resolve(
    process.cwd(),
    env.DATABASE_PATH || path.join(dataDir, 'outreach-engine.db'),
  );
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const databaseUrl = env.DATABASE_URL || `file:${databasePath}`;

  if (nodeEnv === 'production') {
    if (isPlaceholderSecret(env.SESSION_SECRET)) {
      throw new Error('FATAL: SESSION_SECRET must be a strong 32+ character secret in production.');
    }
    if (isPlaceholderSecret(env.ENCRYPTION_KEY)) {
      throw new Error('FATAL: ENCRYPTION_KEY must be a strong 32+ character secret in production.');
    }
    if (isPlaceholderSecret(env.TRACKING_SECRET)) {
      throw new Error('FATAL: TRACKING_SECRET must be a strong 32+ character secret in production.');
    }
  }

  const sessionSecret = env.SESSION_SECRET || '';
  const encryptionKey = env.ENCRYPTION_KEY || '';
  const trackingSecret = env.TRACKING_SECRET || '';

  if (!sessionSecret || !encryptionKey || !trackingSecret) {
    throw new Error(
      'Missing required cryptographic secrets (SESSION_SECRET, ENCRYPTION_KEY, TRACKING_SECRET). Configure .env from .env.example.',
    );
  }

  const adminEmail = (env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) {
    throw new Error('ADMIN_EMAIL environment variable is required.');
  }

  return {
    nodeEnv,
    port,
    appBaseUrl,
    corsOrigins,
    dataDir,
    databasePath,
    databaseUrl,
    sessionSecret,
    encryptionKey,
    trackingSecret,
    sessionTtlHours: Math.max(1, Number(env.SESSION_TTL_HOURS || 168)),
    adminEmail,
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    microsoftTenantId: (env.MICROSOFT_TENANT_ID || 'common').trim(),
    microsoftClientId: (env.MICROSOFT_CLIENT_ID || '').trim(),
    microsoftClientSecret: (env.MICROSOFT_CLIENT_SECRET || '').trim(),
    microsoftRedirectUri: (
      env.MICROSOFT_REDIRECT_URI || `${appBaseUrl}/api/oauth/microsoft/callback`
    ).trim(),
    sendingEnginePollMs: Math.max(1000, Number(env.SENDING_ENGINE_POLL_MS || 5000)),
    inboxSyncPollMs: Math.max(5000, Number(env.INBOX_SYNC_POLL_MS || 60000)),
    whatsappAutoInit: env.WHATSAPP_AUTO_INIT !== 'false',
  };
}
