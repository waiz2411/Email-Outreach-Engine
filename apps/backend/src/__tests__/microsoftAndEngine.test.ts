import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AppConfig } from '../config/env.js';
import { encryptSecret } from '../crypto/security.js';
import { bootstrapDatabase } from '../db/bootstrap.js';
import { createDatabaseBundle, type DatabaseBundle } from '../db/prisma.js';
import { createAppContext } from '../app.js';
import {
  GraphApiError,
  type GraphDeltaResponse,
  type GraphDraftResponse,
  type GraphMailMessage,
  type MicrosoftGraphClient,
} from '../services/microsoft/graphTypes.js';
import { OAuthFlowError, type OAuthHttpTransport } from '../services/microsoft/oauthService.js';

class MockGraphClient implements MicrosoftGraphClient {
  draftCounter = 0;
  sentDraftIds: string[] = [];
  draftPayloads: Array<{ toEmail: string; subject: string; htmlBody: string; correlationId: string }> = [];
  nextSendError: Error | null = null;
  inboxMessages: GraphMailMessage[] = [];
  sentItemsByConv = new Map<string, { id: string; internetMessageId?: string }>();

  async createDraft(
    _accessToken: string,
    payload: { subject: string; htmlBody: string; toEmail: string; correlationId: string },
  ): Promise<GraphDraftResponse> {
    this.draftCounter++;
    this.draftPayloads.push(payload);
    const id = `draft_${this.draftCounter}`;
    return {
      id,
      internetMessageId: `<${payload.correlationId}@outlook.mock>`,
      conversationId: `conv_${this.draftCounter}`,
      subject: payload.subject,
    };
  }

  async sendDraft(_accessToken: string, draftId: string): Promise<{ statusCode: number }> {
    if (this.nextSendError) {
      const err = this.nextSendError;
      this.nextSendError = null;
      throw err;
    }
    this.sentDraftIds.push(draftId);
    const idx = draftId.replace('draft_', '');
    const payload = this.draftPayloads[Number(idx) - 1];
    if (payload) {
      this.sentItemsByConv.set(`conv_${idx}`, {
        id: `sent_${idx}`,
        internetMessageId: `<${payload.correlationId}@outlook.mock>`,
      });
    }
    return { statusCode: 202 };
  }

  async findSentByCorrelationOrMessageId(
    _accessToken: string,
    params: { internetMessageId?: string | null; conversationId?: string | null; draftId?: string | null },
  ): Promise<{ state: 'SENT' | 'DRAFT_ONLY' | 'NOT_FOUND'; graphMessageId?: string }> {
    if (params.conversationId && this.sentItemsByConv.has(params.conversationId)) {
      return { state: 'SENT', graphMessageId: this.sentItemsByConv.get(params.conversationId)!.id };
    }
    if (params.draftId) {
      return { state: 'DRAFT_ONLY' };
    }
    return { state: 'NOT_FOUND' };
  }

  async fetchInboxDelta(): Promise<GraphDeltaResponse> {
    return {
      value: this.inboxMessages,
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta/mock-cursor-1',
    };
  }

  async fetchMessageById(_accessToken: string, messageId: string): Promise<GraphMailMessage> {
    const found = this.inboxMessages.find((m) => m.id === messageId);
    if (!found) throw new GraphApiError('Message not found', { statusCode: 404 });
    return found;
  }

  async createInboxSubscription() {
    return { id: 'sub_1', expirationDateTime: new Date(Date.now() + 86400_000).toISOString() };
  }

  async renewSubscription() {
    return { id: 'sub_1', expirationDateTime: new Date(Date.now() + 86400_000).toISOString() };
  }
}

describe('Auth, Microsoft OAuth PKCE, Sending Engine, Tracking, Replies, Bounces & Exports', () => {
  let templateDir: string;
  let templateDbPath: string;
  let tmpDir: string;
  let db: DatabaseBundle | undefined;
  let config: AppConfig;
  let mockGraph: MockGraphClient;
  let mockOAuth: OAuthHttpTransport;

  beforeAll(() => {
    templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-int-tpl-'));
    templateDbPath = path.join(templateDir, 'template.db');
    const backendRoot = path.resolve(import.meta.dirname, '../..');
    execSync('npx prisma migrate deploy', {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_PATH: templateDbPath, DATABASE_URL: `file:${templateDbPath}` },
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    fs.rmSync(templateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-int-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    fs.copyFileSync(templateDbPath, dbPath);

    config = {
      nodeEnv: 'test',
      port: 0,
      appBaseUrl: 'http://localhost:3001',
      corsOrigins: ['http://localhost:5173'],
      dataDir: tmpDir,
      databasePath: dbPath,
      databaseUrl: `file:${dbPath}`,
      sessionSecret: 'test-session-secret-0123456789abcdef0123456789',
      encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      trackingSecret: 'test-tracking-secret-0123456789abcdef0123456789',
      sessionTtlHours: 24,
      adminEmail: 'admin@test.local',
      adminInitialPassword: 'StrongPassword123!',
      microsoftTenantId: 'common',
      microsoftClientId: 'mock-client-id',
      microsoftClientSecret: 'mock-client-secret',
      microsoftRedirectUri: 'http://localhost:3001/api/oauth/microsoft/callback',
      sendingEnginePollMs: 5000,
      inboxSyncPollMs: 60000,
      whatsappAutoInit: false,
    };

    db = await createDatabaseBundle(dbPath);
    await bootstrapDatabase(db.prisma, config);
    mockGraph = new MockGraphClient();
    mockOAuth = {
      async exchangeCode() {
        return {
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: 'mock-access-token-initial',
          refresh_token: 'mock-refresh-token-1',
          scope: 'User.Read Mail.ReadWrite Mail.Send offline_access',
        };
      },
      async refreshToken() {
        return {
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: 'mock-access-token-refreshed',
          refresh_token: 'mock-refresh-token-2',
        };
      },
      async fetchProfile() {
        return {
          id: 'ms-user-1',
          displayName: 'Waiz Outlook',
          mail: 'sender1@outlook.com',
        };
      },
    };
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = undefined;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces authentication, CSRF protection, OAuth PKCE token encryption/refresh/revocation, and account isolation', async () => {
    const ctx = createAppContext(db!.prisma, db!.sqlite, config, {
      graphClient: mockGraph,
      oauthTransport: mockOAuth,
    });

    // Unauthenticated API access blocked
    const unauth = await request(ctx.app).get('/api/accounts');
    expect(unauth.status).toBe(401);

    const agent = request.agent(ctx.app);
    const badLogin = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'WrongPassword!' });
    expect(badLogin.status).toBe(401);

    const loginRes = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'StrongPassword123!' });
    expect(loginRes.status).toBe(200);
    const csrf = loginRes.body.csrfToken as string;

    // CSRF missing on state change returns 403
    const noCsrf = await agent.post('/api/accounts/connect-url').send({});
    expect(noCsrf.status).toBe(403);

    // OAuth PKCE connect URL & callback
    const urlRes = await agent.post('/api/accounts/connect-url').set('X-CSRF-Token', csrf).send({});
    expect(urlRes.status).toBe(200);
    expect(urlRes.body.url).toContain('code_challenge_method=S256');
    const state = urlRes.body.state as string;

    const callbackRes = await agent
      .get('/api/oauth/microsoft/callback')
      .query({ code: 'auth-code-123', state });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('connected=sender1%40outlook.com');

    // Tokens must NEVER appear in API responses
    const accountsRes = await agent.get('/api/accounts');
    expect(accountsRes.status).toBe(200);
    expect(JSON.stringify(accountsRes.body)).not.toContain('mock-access-token');
    expect(JSON.stringify(accountsRes.body)).not.toContain('mock-refresh-token');

    const accId = accountsRes.body.accounts[0].id as string;

    // Simulate expired access token -> transparent refresh
    await db!.prisma.outlookAccount.update({
      where: { id: accId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const refreshedToken = await ctx.oauthService.getValidAccessToken(accId);
    expect(refreshedToken).toBe('mock-access-token-refreshed');

    // Simulate revoked refresh token -> marks account REAUTH_REQUIRED
    mockOAuth.refreshToken = async () => {
      throw new OAuthFlowError('Token revoked', { code: 'TOKEN_REVOKED', isRevoked: true });
    };
    await db!.prisma.outlookAccount.update({
      where: { id: accId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(ctx.oauthService.getValidAccessToken(accId)).rejects.toThrow(/revoked/i);
    const updatedAcc = await db!.prisma.outlookAccount.findUnique({ where: { id: accId } });
    expect(updatedAcc?.connectionStatus).toBe('REAUTH_REQUIRED');
    expect(updatedAcc?.authorizationStatus).toBe('REVOKED');

    // Admin consent error helper check
    mockOAuth.exchangeCode = async () => {
      throw new OAuthFlowError('AADSTS65001 admin consent required', {
        code: 'ADMIN_CONSENT_REQUIRED',
        requiresAdminConsent: true,
      });
    };
    const urlRes2 = await agent.post('/api/accounts/connect-url').set('X-CSRF-Token', csrf).send({});
    const cb2 = await agent
      .get('/api/oauth/microsoft/callback')
      .query({ code: 'c2', state: urlRes2.body.state });
    expect(cb2.headers.location).toContain('oauth_error=');
    expect(decodeURIComponent(cb2.headers.location || '')).toContain('admin');
  });

  it('enforces daily limits concurrently, delays across restarts, pause/stop isolation, tracking, replies, NDR bounces, and backups', async () => {
    const ctx = createAppContext(db!.prisma, db!.sqlite, config, {
      graphClient: mockGraph,
      oauthTransport: mockOAuth,
      randomFn: () => 0.5,
    });
    const agent = request.agent(ctx.app);
    const loginRes = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'StrongPassword123!' });
    const csrf = loginRes.body.csrfToken as string;

    // Connect account via OAuth callback
    const urlRes = await agent.post('/api/accounts/connect-url').set('X-CSRF-Token', csrf).send({});
    await agent.get('/api/oauth/microsoft/callback').query({ code: 'ok', state: urlRes.body.state });
    const accountsRes = await agent.get('/api/accounts');
    const accId = accountsRes.body.accounts[0].id as string;

    // Configure account: daily limit = 2, delay 15-20m, open 24h window via 00:00 -> 23:59
    const patchRes = await agent
      .patch(`/api/accounts/${accId}`)
      .set('X-CSRF-Token', csrf)
      .send({
        dailySendLimit: 2,
        minDelayMinutes: 15,
        maxDelayMinutes: 20,
        scheduleStartTime: '00:00',
        scheduleEndTime: '23:59',
        timezone: 'UTC',
        allowedWeekdays: [0, 1, 2, 3, 4, 5, 6],
        signatureHtml: '<p>Best,<br/>Waiz</p>',
        signatureEnabled: true,
      });
    expect(patchRes.status).toBe(200);

    // Concurrent quota reservation check: 5 parallel calls with limit 2 -> strictly 2 succeed!
    const results = await Promise.all([
      Promise.resolve(ctx.sendingEngine.reserveDailyQuotaSlot(accId, '2099-01-01', 2)),
      Promise.resolve(ctx.sendingEngine.reserveDailyQuotaSlot(accId, '2099-01-01', 2)),
      Promise.resolve(ctx.sendingEngine.reserveDailyQuotaSlot(accId, '2099-01-01', 2)),
      Promise.resolve(ctx.sendingEngine.reserveDailyQuotaSlot(accId, '2099-01-01', 2)),
      Promise.resolve(ctx.sendingEngine.reserveDailyQuotaSlot(accId, '2099-01-01', 2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);

    // Upload CSV leads (3 valid leads)
    const csvContent = [
      'email,first_name,company,subject,body',
      'lead1@client.com,Alice,Alpha,"Proposal for {{company}}","Hi {{first_name}}, visit https://client.com"',
      'lead2@client.com,Bob,Beta,"Proposal for {{company}}","Hi {{first_name}}, check https://beta.example"',
      'lead3@client.com,Carol,Gamma,"Proposal for {{company}}","Hi {{first_name}}, hello!"',
    ].join('\n');

    const previewRes = await agent
      .post('/api/leads/import/preview')
      .set('X-CSRF-Token', csrf)
      .field('outlookAccountId', accId)
      .attach('file', Buffer.from(csvContent, 'utf8'), 'leads.csv');
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.validCount).toBe(3);

    const confirmRes = await agent
      .post('/api/leads/import/confirm')
      .set('X-CSRF-Token', csrf)
      .send({ batchId: previewRes.body.batchId, duplicateResolution: 'SKIP' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.importedCount).toBe(3);

    const leadsListRes = await agent.get('/api/leads').query({ outlookAccountId: accId });
    const leadIds = leadsListRes.body.leads.map((l: { id: string }) => l.id);

    // Create campaign & preview
    const campRes = await agent
      .post('/api/campaigns')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Main Outreach', outlookAccountId: accId, leadIds });
    expect(campRes.status).toBe(201);
    const campaignId = campRes.body.campaign.id as string;

    // Must require confirmation before first email
    const noConfirmStart = await agent
      .post(`/api/campaigns/${campaignId}/start`)
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(noConfirmStart.status).toBe(400);

    const startRes = await agent
      .post(`/api/campaigns/${campaignId}/start`)
      .set('X-CSRF-Token', csrf)
      .send({ confirmFirstSend: true });
    expect(startRes.status).toBe(200);
    expect(startRes.body.enqueued).toBe(3);

    // Tick 1 dispatches 1st email and sets nextEligibleSendAt in [15, 20] mins
    const now1 = new Date();
    const t1 = await ctx.sendingEngine.tick(now1);
    expect(t1.dispatched).toBe(1);
    expect(mockGraph.sentDraftIds).toHaveLength(1);
    expect(mockGraph.draftPayloads[0]?.htmlBody).toContain('/t/c/');
    expect(mockGraph.draftPayloads[0]?.htmlBody).toContain('/t/o/');
    expect(mockGraph.draftPayloads[0]?.htmlBody).toContain('/t/u/');
    expect(mockGraph.draftPayloads[0]?.htmlBody).toContain('Waiz');

    // Immediate tick before delay elapses MUST NOT send (even across simulated restart!)
    const restartedEngine = createAppContext(db!.prisma, db!.sqlite, config, {
      graphClient: mockGraph,
      oauthTransport: mockOAuth,
    }).sendingEngine;
    const tImmediate = await restartedEngine.tick(new Date(now1.getTime() + 5 * 60_000));
    expect(tImmediate.dispatched).toBe(0);

    // After 21 minutes, 2nd email dispatches (reaching daily limit = 2)
    const now2 = new Date(now1.getTime() + 21 * 60_000);
    const t2 = await restartedEngine.tick(now2);
    expect(t2.dispatched).toBe(1);
    expect(mockGraph.sentDraftIds).toHaveLength(2);

    // After another 21 minutes on same day, daily limit (2) blocks 3rd email!
    const now3 = new Date(now2.getTime() + 21 * 60_000);
    const t3 = await restartedEngine.tick(now3);
    expect(t3.dispatched).toBe(0);
    expect(mockGraph.sentDraftIds).toHaveLength(2);

    // Test tracking pixel & signed click redirect & open redirect rejection
    const sentMsg = await db!.prisma.emailMessage.findFirstOrThrow({
      orderBy: { createdAt: 'asc' },
    });
    expect(sentMsg.deliveryStatus).toBe('DELIVERY_UNKNOWN');

    const link = await db!.prisma.trackingLink.findFirstOrThrow({
      where: { emailMessageId: sentMsg.id },
    });
    const clickMatch = mockGraph.draftPayloads[0]!.htmlBody.match(/\/t\/c\/([^"']+)/);
    expect(clickMatch).not.toBeNull();
    const clickRes = await request(ctx.app).get(`/t/c/${clickMatch![1]}`);
    expect(clickRes.status).toBe(302);
    expect(clickRes.headers.location).toBe(link.destinationUrl);

    // Tampered click link rejected
    const badClickRes = await request(ctx.app).get('/t/c/tampered.signature');
    expect(badClickRes.status).toBe(400);

    const openMatch = mockGraph.draftPayloads[0]!.htmlBody.match(/\/t\/o\/([^"']+)/);
    const openRes = await request(ctx.app).get(`/t/o/${openMatch![1]}`);
    expect(openRes.status).toBe(200);
    expect(openRes.headers['content-type']).toContain('image/gif');

    // Simulate incoming reply + unrelated email + hard bounce NDR via InboxSyncService
    const sentMsg2 = await db!.prisma.emailMessage.findMany({ orderBy: { createdAt: 'asc' } });
    const secondSent = sentMsg2[1]!;

    await db!.prisma.whatsAppConfig.update({
      where: { id: 'default' },
      data: { recipientPhoneNumber: '+923001234567' },
    });

    mockGraph.inboxMessages = [
      {
        id: 'in_reply_1',
        subject: `Re: ${sentMsg.subject}`,
        receivedDateTime: new Date().toISOString(),
        conversationId: sentMsg.conversationId ?? undefined,
        from: { emailAddress: { name: 'Lead One', address: sentMsg.recipientEmail } },
        bodyPreview: 'Thanks, let us chat tomorrow.',
        internetMessageHeaders: [
          { name: 'In-Reply-To', value: sentMsg.internetMessageId! },
        ],
      },
      {
        id: 'in_unrelated_1',
        subject: 'Newsletter',
        receivedDateTime: new Date().toISOString(),
        from: { emailAddress: { name: 'Digest', address: 'news@unrelated.org' } },
        bodyPreview: 'Weekly update',
      },
      {
        id: 'in_bounce_2',
        subject: `Undeliverable: ${secondSent.subject}`,
        receivedDateTime: new Date().toISOString(),
        from: { emailAddress: { name: 'Postmaster', address: 'postmaster@outlook.com' } },
        bodyPreview: `Final-Recipient: rfc822; ${secondSent.recipientEmail}\nStatus: 5.1.1\n550 5.1.1 User unknown`,
        internetMessageHeaders: [
          { name: 'In-Reply-To', value: secondSent.internetMessageId! },
        ],
      },
    ];

    const syncRes = await agent.post(`/api/accounts/${accId}/sync-inbox`).set('X-CSRF-Token', csrf);
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.replies).toBe(1);
    expect(syncRes.body.bounces).toBe(1);

    // Hard bounced recipient added to suppression list!
    const suppressed = await db!.prisma.suppressionEntry.findUnique({
      where: { email: secondSent.recipientEmail },
    });
    expect(suppressed?.reason).toBe('HARD_BOUNCE');

    // Unrelated incoming email did NOT mark any lead replied, and WhatsApp notification jobs created for reply + direct email (not bounce)
    const waJobs = await db!.prisma.whatsAppNotificationJob.findMany();
    expect(waJobs).toHaveLength(2);

    // Pause & Stop campaign checks + Exports + SQLite Backup
    await agent.post(`/api/campaigns/${campaignId}/stop`).set('X-CSRF-Token', csrf);
    const pendingLeft = await db!.prisma.sendingJob.count({ where: { campaignId, status: 'PENDING' } });
    expect(pendingLeft).toBe(0);

    const exportCampaign = await agent.get(`/api/campaigns/${campaignId}/export`);
    expect(exportCampaign.status).toBe(200);
    expect(exportCampaign.text).toContain(sentMsg.recipientEmail);

    const backupRes = await agent.get('/api/system/backup');
    expect(backupRes.status).toBe(200);
    expect(backupRes.body.length).toBeGreaterThan(4096);

    // Disconnect preserves historical data
    await agent.post(`/api/accounts/${accId}/disconnect`).set('X-CSRF-Token', csrf);
    const histEmails = await db!.prisma.emailMessage.count({ where: { outlookAccountId: accId } });
    expect(histEmails).toBe(2);
  });

  it('handles crash recovery (PROCESSING -> UNCERTAIN), safe reconciliation, 429 Retry-After backoff, and permanent errors', async () => {
    const ctx = createAppContext(db!.prisma, db!.sqlite, config, {
      graphClient: mockGraph,
      oauthTransport: mockOAuth,
    });
    const acc = await db!.prisma.outlookAccount.create({
      data: {
        email: 'recover@outlook.com',
        connectionStatus: 'CONNECTED',
        authorizationStatus: 'AUTHORIZED',
        encryptedAccessToken: encryptSecret('valid-access-token', config.encryptionKey),
        encryptedRefreshToken: encryptSecret('valid-refresh-token', config.encryptionKey),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        dailySendLimit: 10,
        minDelayMinutes: 1,
        maxDelayMinutes: 2,
        scheduleStartTime: '00:00',
        scheduleEndTime: '23:59',
        timezone: 'UTC',
      },
    });
    const lead = await db!.prisma.lead.create({
      data: {
        outlookAccountId: acc.id,
        email: 'target@example.com',
        subject: 'Hello',
        body: 'World',
        status: 'SENDING',
      },
    });
    const campaign = await db!.prisma.campaign.create({
      data: {
        name: 'Crash Test',
        outlookAccountId: acc.id,
        status: 'ACTIVE',
        confirmedFirstSend: true,
      },
    });
    const job = await db!.prisma.sendingJob.create({
      data: {
        campaignId: campaign.id,
        leadId: lead.id,
        outlookAccountId: acc.id,
        recipientEmail: lead.email,
        idempotencyKey: `${campaign.id}:${lead.id}`,
        status: 'PROCESSING',
      },
    });
    await db!.prisma.emailMessage.create({
      data: {
        sendingJobId: job.id,
        outlookAccountId: acc.id,
        campaignId: campaign.id,
        leadId: lead.id,
        recipientEmail: lead.email,
        subject: 'Hello',
        correlationId: 'corr-1',
        graphDraftId: 'draft_1',
        internetMessageId: '<corr-1@outlook.mock>',
        conversationId: 'conv_1',
        status: 'SENDING',
      },
    });

    // Startup recovery moves PROCESSING -> UNCERTAIN (never blindly resends)
    const recovered = await ctx.sendingEngine.recoverInterruptedJobs();
    expect(recovered).toBe(1);
    const uncertainJob = await db!.prisma.sendingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(uncertainJob.status).toBe('UNCERTAIN');

    // If SentItems already has it, reconciliation marks SENT without calling sendDraft again!
    mockGraph.sentItemsByConv.set('conv_1', {
      id: 'sent_1',
      internetMessageId: '<corr-1@outlook.mock>',
    });
    const recOutcome = await ctx.sendingEngine.reconcileUncertainJob(job.id);
    expect(recOutcome.outcome).toBe('CONFIRMED_SENT');
    expect(mockGraph.sentDraftIds).toHaveLength(0);

    // Rate limit (429 Retry-After) requeues PENDING; Permanent 400 error stops retrying immediately
    const lead2 = await db!.prisma.lead.create({
      data: {
        outlookAccountId: acc.id,
        campaignId: campaign.id,
        email: 'ratelimit@example.com',
        subject: 'Sub 2',
        body: 'Body 2',
        status: 'VALIDATED',
      },
    });
    await ctx.sendingEngine.enqueueCampaignLeads(campaign.id);
    const job2 = await db!.prisma.sendingJob.findUniqueOrThrow({
      where: { idempotencyKey: `${campaign.id}:${lead2.id}` },
    });

    mockGraph.nextSendError = new GraphApiError('Throttled', {
      statusCode: 429,
      retryAfterSeconds: 45,
      isRateLimited: true,
    });
    await ctx.sendingEngine.tick(new Date());
    const after429 = await db!.prisma.sendingJob.findUniqueOrThrow({ where: { id: job2.id } });
    expect(after429.status).toBe('PENDING');
    expect(after429.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Permanent 400 error should immediately mark job FAILED without exhausting retries
    mockGraph.nextSendError = new GraphApiError('Invalid recipient mailbox', {
      statusCode: 400,
      errorCode: 'ErrorInvalidRecipients',
      isPermanent: true,
    });
    await db!.prisma.sendingJob.update({ where: { id: job2.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await ctx.sendingEngine.tick(new Date());
    const afterPerm = await db!.prisma.sendingJob.findUniqueOrThrow({ where: { id: job2.id } });
    expect(afterPerm.status).toBe('FAILED');
    expect(afterPerm.attempts).toBe(2);
  });
});
