import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import type { AppConfig } from '../apps/backend/src/config/env.js';
import { bootstrapDatabase } from '../apps/backend/src/db/bootstrap.js';
import { createDatabaseBundle } from '../apps/backend/src/db/prisma.js';
import { createAppContext } from '../apps/backend/src/app.js';
import type {
  GraphDeltaResponse,
  GraphDraftResponse,
  GraphMailMessage,
  MicrosoftGraphClient,
} from '../apps/backend/src/services/microsoft/graphTypes.js';
import type { OAuthHttpTransport } from '../apps/backend/src/services/microsoft/oauthService.js';
import type { WhatsAppSocketFactory, WhatsAppSocketLike } from '../apps/backend/src/services/whatsapp/whatsappService.js';

class E2EMockGraphClient implements MicrosoftGraphClient {
  draftCounter = 0;
  sentMessages: Array<{ toEmail: string; subject: string; internetMessageId: string; conversationId: string }> = [];
  inboxMessages: GraphMailMessage[] = [];

  async createDraft(
    _token: string,
    payload: { subject: string; htmlBody: string; toEmail: string; correlationId: string },
  ): Promise<GraphDraftResponse> {
    this.draftCounter++;
    const internetMessageId = `<${payload.correlationId}@e2e.outlook>`;
    const conversationId = `e2e_conv_${this.draftCounter}`;
    this.sentMessages.push({
      toEmail: payload.toEmail,
      subject: payload.subject,
      internetMessageId,
      conversationId,
    });
    return {
      id: `e2e_draft_${this.draftCounter}`,
      internetMessageId,
      conversationId,
      subject: payload.subject,
    };
  }

  async sendDraft(): Promise<{ statusCode: number }> {
    return { statusCode: 202 };
  }

  async findSentByCorrelationOrMessageId() {
    return { state: 'SENT' as const, graphMessageId: 'e2e_sent_1' };
  }

  async fetchInboxDelta(): Promise<GraphDeltaResponse> {
    return {
      value: this.inboxMessages,
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/e2e',
    };
  }

  async fetchMessageById(_token: string, messageId: string): Promise<GraphMailMessage> {
    return this.inboxMessages.find((m) => m.id === messageId) || { id: messageId };
  }

  async createInboxSubscription() {
    return { id: 'sub_e2e', expirationDateTime: new Date(Date.now() + 86400_000).toISOString() };
  }

  async renewSubscription() {
    return { id: 'sub_e2e', expirationDateTime: new Date(Date.now() + 86400_000).toISOString() };
  }
}

class E2EMockBaileysSocket implements WhatsAppSocketLike {
  ev = new EventEmitter();
  user?: { id?: string; name?: string };
  sentAlerts: Array<{ jid: string; text: string }> = [];
  failNextSend = false;

  async sendMessage(jid: string, content: { text: string }) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('E2E simulated WhatsApp send failure');
    }
    this.sentAlerts.push({ jid, text: content.text });
    return { key: { id: `e2e_wa_${this.sentAlerts.length}` } };
  }

  async logout() {}
  end() {}
}

export async function startE2EServer(port = 4199) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-'));
  const dbPath = path.join(tmpDir, 'e2e.db');
  const backendRoot = path.resolve(process.cwd(), 'apps/backend');

  execSync('npx prisma migrate deploy', {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  });

  const config: AppConfig = {
    nodeEnv: 'production',
    port,
    appBaseUrl: `http://127.0.0.1:${port}`,
    corsOrigins: [`http://127.0.0.1:${port}`],
    dataDir: tmpDir,
    databasePath: dbPath,
    databaseUrl: `file:${dbPath}`,
    sessionSecret: 'e2e-session-secret-0123456789abcdef0123456789abcdef',
    encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trackingSecret: 'e2e-tracking-secret-0123456789abcdef0123456789abcdef',
    sessionTtlHours: 24,
    adminEmail: 'admin@outreach.local',
    adminInitialPassword: 'E2eStrongPassword123!',
    microsoftTenantId: 'common',
    microsoftClientId: 'e2e-ms-client',
    microsoftClientSecret: 'e2e-ms-secret',
    microsoftRedirectUri: `http://127.0.0.1:${port}/api/oauth/microsoft/callback`,
    sendingEnginePollMs: 60_000,
    inboxSyncPollMs: 60_000,
    whatsappAutoInit: false,
  };

  const db = await createDatabaseBundle(dbPath);
  await bootstrapDatabase(db.prisma, config);

  const mockGraph = new E2EMockGraphClient();
  let mockSocket: E2EMockBaileysSocket | null = null;
  const mockOAuth: OAuthHttpTransport = {
    async exchangeCode() {
      return {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
      };
    },
    async refreshToken() {
      return {
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: 'e2e-access-token-2',
        refresh_token: 'e2e-refresh-token-2',
      };
    },
    async fetchProfile() {
      return { id: 'e2e-user-1', displayName: 'E2E Sender', mail: 'waiz@outlook.com' };
    },
  };

  const socketFactory: WhatsAppSocketFactory = async () => {
    mockSocket = new E2EMockBaileysSocket();
    setTimeout(() => {
      mockSocket?.ev.emit('connection.update', { qr: '2@e2e-dynamic-qr-code-token' });
    }, 50);
    return mockSocket;
  };

  const ctx = createAppContext(db.prisma, db.sqlite, config, {
    graphClient: mockGraph,
    oauthTransport: mockOAuth,
    whatsappSocketFactory: socketFactory,
  });

  // E2E harness helper hooks (only mounted in this Playwright runner, never in production src)
  ctx.app.post('/__e2e/connect-mock-outlook', async (_req, res) => {
    const { state } = await ctx.oauthService.createAuthorizationUrl();
    await ctx.oauthService.handleCallback({ code: 'e2e-code', state });
    res.json({ ok: true });
  });

  ctx.app.post('/__e2e/tick-engine', async (req, res) => {
    const offsetMinutes = Number(req.body?.offsetMinutes || 0);
    const result = await ctx.sendingEngine.tick(new Date(Date.now() + offsetMinutes * 60_000));
    res.json(result);
  });

  ctx.app.post('/__e2e/wa-scan-qr', async (_req, res) => {
    if (!mockSocket) {
      res.status(400).json({ error: 'No active WA socket' });
      return;
    }
    mockSocket.user = { id: '923001112233:1@s.whatsapp.net', name: 'Linked Phone' };
    mockSocket.ev.emit('creds.update');
    mockSocket.ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 80));
    res.json({ ok: true });
  });

  ctx.app.post('/__e2e/simulate-incoming-reply', async (_req, res) => {
    const lastSent = mockGraph.sentMessages[mockGraph.sentMessages.length - 1];
    const acc = await db.prisma.outlookAccount.findFirstOrThrow();
    mockGraph.inboxMessages = [
      {
        id: `e2e_in_${Date.now()}`,
        subject: `Re: ${lastSent?.subject || 'Outreach'}`,
        receivedDateTime: new Date().toISOString(),
        conversationId: lastSent?.conversationId,
        from: { emailAddress: { name: 'John Smith', address: lastSent?.toEmail || 'john@example.com' } },
        bodyPreview: 'Interested! Let us schedule a call.',
        internetMessageHeaders: lastSent
          ? [{ name: 'In-Reply-To', value: lastSent.internetMessageId }]
          : [],
      },
    ];
    const syncRes = await ctx.inboxSyncService.syncAccountInbox(acc.id);
    await new Promise((r) => setTimeout(r, 120));
    res.json({ syncRes, sentAlerts: mockSocket?.sentAlerts ?? [] });
  });

  ctx.app.post('/__e2e/fail-next-wa-send', (_req, res) => {
    if (mockSocket) mockSocket.failNextSend = true;
    res.json({ ok: true });
  });

  if (ctx.whatsappLifecycle) {
    await ctx.whatsappLifecycle.startBackgroundServices();
  }

  const server = ctx.app.listen(port);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    mockGraph,
    getSocket: () => mockSocket,
    async close() {
      if (ctx.whatsappLifecycle) await ctx.whatsappLifecycle.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1]?.endsWith('e2eServer.mts')) {
  startE2EServer(4199)
    .then((handle) => {
      console.log(`E2E server listening at ${handle.baseUrl}`);
      const shutdown = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error('Failed starting E2E server:', err);
      process.exit(1);
    });
}
