import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import type { AppConfig } from '../config/env.js';
import { bootstrapDatabase } from '../db/bootstrap.js';
import { createDatabaseBundle, type DatabaseBundle } from '../db/prisma.js';
import { createAppContext } from '../app.js';
import {
  WhatsAppService,
  type WhatsAppSocketFactory,
  type WhatsAppSocketLike,
} from '../services/whatsapp/whatsappService.js';

class MockBaileysSocket implements WhatsAppSocketLike {
  ev = new EventEmitter();
  user?: { id?: string; name?: string };
  sentMessages: Array<{ jid: string; text: string }> = [];
  shouldFailSend = false;
  loggedOut = false;

  async sendMessage(jid: string, content: { text: string }) {
    if (this.shouldFailSend) {
      throw new Error('Mock WhatsApp socket transmit failure');
    }
    this.sentMessages.push({ jid, text: content.text });
    return { key: { id: `wa_msg_${this.sentMessages.length}` } };
  }

  async logout() {
    this.loggedOut = true;
  }

  end() {
    // noop
  }
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (val: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastVal = await fn();
  while (!predicate(lastVal) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    lastVal = await fn();
  }
  return lastVal;
}

describe('WhatsApp Web QR integration, encrypted session persistence, and notification retries', () => {
  let templateDir: string;
  let templateDbPath: string;
  let tmpDir: string;
  let db: DatabaseBundle | undefined;
  let config: AppConfig;
  let latestSocket: MockBaileysSocket | null = null;

  beforeAll(() => {
    templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-wa-tpl-'));
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-wa-test-'));
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
      whatsappAutoInit: true,
    };

    db = await createDatabaseBundle(dbPath);
    await bootstrapDatabase(db.prisma, config);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = undefined;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockFactory: WhatsAppSocketFactory = async ({ auth }) => {
    latestSocket = new MockBaileysSocket();
    // Simulate Baileys emitting creds update when auth already registered or during scan
    if (auth.creds.me?.id) {
      latestSocket.user = { id: auth.creds.me.id };
    }
    return latestSocket;
  };

  it('generates dynamic QR, authenticates, persists encrypted creds across restart, handles same-number test & disconnect retries', async () => {
    const waService = new WhatsAppService(db!.prisma, config, mockFactory);
    const ctx = createAppContext(db!.prisma, db!.sqlite, config, {
      whatsappManagerOverride: waService,
    });

    const agent = request.agent(ctx.app);
    const loginRes = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'StrongPassword123!' });
    expect(loginRes.status).toBe(200);
    const csrf = loginRes.body.csrfToken as string;

    // 1. Initiate connection and receive dynamic QR code
    const connectRes = await agent.post('/api/whatsapp/connect').set('X-CSRF-Token', csrf);
    expect(connectRes.status).toBe(200);
    expect(latestSocket).not.toBeNull();

    latestSocket!.ev.emit('connection.update', { qr: '2@mock-qr-payload-token-12345' });
    const qrState = await waitFor(
      () => agent.get('/api/whatsapp/status'),
      (res) => res.body.connectionStatus === 'QR_READY',
    );
    expect(qrState.body.connectionStatus).toBe('QR_READY');
    expect(qrState.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    // 2. Authenticate session and save encrypted credentials in SQLite
    latestSocket!.user = { id: '923001234567:12@s.whatsapp.net', name: 'Test Phone' };
    latestSocket!.ev.emit('creds.update');
    latestSocket!.ev.emit('connection.update', { connection: 'open' });
    const connectedState = await waitFor(
      () => agent.get('/api/whatsapp/status'),
      (res) => res.body.connectionStatus === 'CONNECTED',
    );
    expect(connectedState.body.connectionStatus).toBe('CONNECTED');
    expect(connectedState.body.linkedPhoneNumber).toBe('+923001234567');

    // Verify encrypted creds stored in DB (not plaintext!)
    const authEntry = await waitFor(
      () => db!.prisma.whatsAppAuthEntry.findUnique({ where: { key: 'creds' } }),
      (row) => row !== null,
    );
    expect(authEntry).not.toBeNull();
    expect(authEntry!.encryptedValue).not.toContain('noiseKey');

    // 3. Validate invalid recipient rejected, valid same-number recipient saved & test notification sent
    const badPhoneRes = await agent
      .patch('/api/whatsapp/settings')
      .set('X-CSRF-Token', csrf)
      .send({ recipientPhoneNumber: '03001234567' });
    expect(badPhoneRes.status).toBe(400);

    const goodPhoneRes = await agent
      .patch('/api/whatsapp/settings')
      .set('X-CSRF-Token', csrf)
      .send({ recipientPhoneNumber: '+923001234567' });
    expect(goodPhoneRes.status).toBe(200);

    const testNotifyRes = await agent.post('/api/whatsapp/test').set('X-CSRF-Token', csrf);
    expect(testNotifyRes.status).toBe(200);
    expect(testNotifyRes.body.status).toBe('SENT');
    expect(latestSocket!.sentMessages).toHaveLength(1);
    expect(latestSocket!.sentMessages[0]?.jid).toBe('923001234567@s.whatsapp.net');

    // 4. Simulate delivery ack upgrading status to DELIVERED
    latestSocket!.ev.emit('messages.update', [
      { key: { id: testNotifyRes.body.providerMessageId }, update: { status: 3 } },
    ]);
    const notifRow = await waitFor(
      () => db!.prisma.whatsAppNotificationJob.findUnique({ where: { id: testNotifyRes.body.jobId } }),
      (row) => row?.status === 'DELIVERED',
    );
    expect(notifRow?.status).toBe('DELIVERED');

    // 5. Simulate disconnect & verify queued notifications stay in DB without being lost or sent prematurely
    await agent.post('/api/whatsapp/disconnect').set('X-CSRF-Token', csrf);
    await db!.prisma.whatsAppNotificationJob.create({
      data: {
        dedupeKey: 'queued_while_offline_1',
        eventType: 'OUTREACH_REPLY',
        recipientPhone: '+923001234567',
        messageText: 'New campaign reply received!',
        status: 'PENDING',
      },
    });
    const sentWhileOffline = await waService.processPendingNotifications();
    expect(sentWhileOffline).toBe(0);

    // 6. Simulate application restart: new WhatsAppService instance auto-restores encrypted session!
    await waService.shutdown();
    // Mark config as previously active to simulate unexpected Render restart (not manual disconnect)
    await db!.prisma.whatsAppConfig.update({
      where: { id: 'default' },
      data: { connectionStatus: 'CONNECTED' },
    });

    const restartedService = new WhatsAppService(db!.prisma, config, mockFactory);
    const restartedCtx = createAppContext(db!.prisma, db!.sqlite, config, {
      whatsappManagerOverride: restartedService,
    });
    const restartedAgent = request.agent(restartedCtx.app);
    const restartedLogin = await restartedAgent
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'StrongPassword123!' });
    const restartedCsrf = restartedLogin.body.csrfToken as string;

    await restartedService.startBackgroundServices();
    expect(latestSocket).not.toBeNull();
    latestSocket!.user = { id: '923001234567:12@s.whatsapp.net' };
    latestSocket!.ev.emit('connection.update', { connection: 'open' });

    // Queued notification should now have been dispatched on reconnect!
    const retriedRow = await waitFor(
      () => db!.prisma.whatsAppNotificationJob.findUnique({ where: { dedupeKey: 'queued_while_offline_1' } }),
      (row) => row?.status === 'SENT',
    );
    expect(retriedRow?.status).toBe('SENT');

    // 7. Test failure + manual retry via restarted HTTP API
    latestSocket!.shouldFailSend = true;
    const failedJob = await db!.prisma.whatsAppNotificationJob.create({
      data: {
        dedupeKey: 'manual_retry_job',
        eventType: 'NEW_EMAIL',
        recipientPhone: '+923001234567',
        messageText: 'New email received!',
        status: 'FAILED',
        attempts: 1,
      },
    });

    latestSocket!.shouldFailSend = false;
    const retryRes = await restartedAgent
      .post(`/api/whatsapp/notifications/${failedJob.id}/retry`)
      .set('X-CSRF-Token', restartedCsrf);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.status).toBe('SENT');

    // 8. Simulate loggedOut event clearing session, and deleteStoredSession
    latestSocket!.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('Logged out', { statusCode: DisconnectReason.loggedOut }) },
    });
    const afterLogout = await waitFor(
      () => restartedService.getState(),
      (st) => st.connectionStatus === 'LOGGED_OUT',
    );
    expect(afterLogout.connectionStatus).toBe('LOGGED_OUT');
    expect(afterLogout.hasStoredSession).toBe(false);

    // 9. Verify deleteStoredSession clears credentials cleanly
    await restartedService.connect();
    latestSocket!.ev.emit('creds.update');
    await waitFor(
      () => db!.prisma.whatsAppAuthEntry.findUnique({ where: { key: 'creds' } }),
      (row) => row !== null,
    );
    await restartedAgent.delete('/api/whatsapp/session').set('X-CSRF-Token', restartedCsrf);
    const afterDelete = await restartedService.getState();
    expect(afterDelete.hasStoredSession).toBe(false);

    await restartedService.shutdown();
  });
});
