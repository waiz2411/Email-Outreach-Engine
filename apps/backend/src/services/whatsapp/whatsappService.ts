import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  type AuthenticationState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  formatWhatsAppNotificationMessage,
  normalizeInternationalPhone,
} from '@outreach-engine/shared';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.js';
import { generateRandomToken } from '../../crypto/security.js';
import { logger } from '../../utils/logger.js';
import type { WhatsAppManagerPort, WhatsAppPublicState } from '../../routes/whatsappRoutes.js';
import { useEncryptedSqliteAuthState } from './encryptedAuthState.js';

export interface WhatsAppSocketLike {
  user?: { id?: string; name?: string };
  ev: {
    on(event: 'creds.update', listener: () => void): void;
    on(
      event: 'connection.update',
      listener: (update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string }) => void,
    ): void;
    on(
      event: 'messages.update',
      listener: (updates: Array<{ key?: { id?: string }; update?: { status?: number } }>) => void,
    ): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string } } | undefined>;
  logout?(): Promise<void>;
  end?(error?: Error): void;
}

export type WhatsAppSocketFactory = (params: {
  auth: AuthenticationState;
}) => Promise<WhatsAppSocketLike>;

const defaultSocketFactory: WhatsAppSocketFactory = async ({ auth }) => {
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1027934701] as [number, number, number],
  }));

  const sock = makeWASocket({
    version,
    auth,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Outreach Engine', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  return sock as unknown as WhatsAppSocketLike;
};

function phoneToWhatsAppJid(e164Phone: string): string {
  const digits = normalizeInternationalPhone(e164Phone).replace(/^\+/, '');
  return `${digits}@s.whatsapp.net`;
}

function jidToPhone(jid?: string | null): string | null {
  if (!jid) return null;
  const normalized = jidNormalizedUser(jid);
  const digits = normalized.split('@')[0]?.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

export class WhatsAppService implements WhatsAppManagerPort {
  private sock: WhatsAppSocketLike | null = null;
  private qrCodeDataUrl: string | null = null;
  private qrExpiresAt: Date | null = null;
  private qrExpired = false;
  private qrExpiryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private workerTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;
  private isConnecting = false;
  private isWorkerBusy = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly socketFactory: WhatsAppSocketFactory = defaultSocketFactory,
  ) {}

  async startBackgroundServices(): Promise<void> {
    if (!this.workerTimer) {
      this.workerTimer = setInterval(() => {
        void this.processPendingNotifications().catch((err) =>
          logger.error('WhatsApp worker loop error', { err }),
        );
      }, 10_000);
    }

    if (!this.config.whatsappAutoInit) return;

    // Auto-restore an existing encrypted WhatsApp session after restart/redeploy without requiring a new QR scan
    const credsCount = await this.prisma.whatsAppAuthEntry.count({ where: { key: 'creds' } });
    const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (credsCount > 0 && cfg?.connectionStatus !== 'DISCONNECTED' && cfg?.connectionStatus !== 'LOGGED_OUT') {
      await this.connect().catch((err) =>
        logger.warn('Failed to auto-restore WhatsApp session on startup', { err }),
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    this.clearTimers();
    if (this.sock) {
      this.manualDisconnect = true;
      try {
        this.sock.end?.(undefined);
      } catch {
        // Ignore close errors during shutdown
      }
      this.sock = null;
    }
  }

  private clearTimers(): void {
    if (this.qrExpiryTimer) {
      clearTimeout(this.qrExpiryTimer);
      this.qrExpiryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async getState(): Promise<WhatsAppPublicState> {
    const [cfg, credsCount] = await Promise.all([
      this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } }),
      this.prisma.whatsAppAuthEntry.count({ where: { key: 'creds' } }),
    ]);

    return {
      connectionStatus: cfg?.connectionStatus ?? 'DISCONNECTED',
      linkedPhoneNumber: cfg?.linkedPhoneNumber ?? null,
      recipientPhoneNumber: cfg?.recipientPhoneNumber ?? null,
      qrCodeDataUrl: this.qrCodeDataUrl,
      qrExpiresAt: this.qrExpiresAt?.toISOString() ?? null,
      qrExpired: this.qrExpired,
      hasStoredSession: credsCount > 0,
      lastConnectedAt: cfg?.lastConnectedAt ?? null,
      lastNotificationAt: cfg?.lastNotificationAt ?? null,
      lastError: cfg?.lastError ?? null,
      includeBodyPreview: cfg?.includeBodyPreview ?? false,
      notifyNewEmail: cfg?.notifyNewEmail ?? true,
      notifyReply: cfg?.notifyReply ?? true,
      notifyCampaignComplete: cfg?.notifyCampaignComplete ?? true,
      notifySendError: cfg?.notifySendError ?? true,
      notifyWhatsAppError: cfg?.notifyWhatsAppError ?? true,
    };
  }

  async connect(): Promise<WhatsAppPublicState> {
    if (this.isConnecting) {
      return this.getState();
    }
    this.isConnecting = true;
    this.manualDisconnect = false;
    this.qrExpired = false;
    this.clearTimers();

    try {
      if (this.sock) {
        try {
          this.sock.end?.(undefined);
        } catch {
          // Ignore old socket cleanup
        }
        this.sock = null;
      }

      await this.prisma.whatsAppConfig.upsert({
        where: { id: 'default' },
        create: { id: 'default', connectionStatus: 'INITIALIZING', lastError: null },
        update: { connectionStatus: 'INITIALIZING', lastError: null },
      });

      const authState = await useEncryptedSqliteAuthState(this.prisma, this.config.encryptionKey);
      const sock = await this.socketFactory({ auth: authState.state });
      this.sock = sock;

      sock.ev.on('creds.update', async () => {
        await authState.saveCreds().catch((err) =>
          logger.error('Failed saving encrypted WhatsApp credentials', { err }),
        );
      });

      sock.ev.on('connection.update', (update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string }) => {
        void this.handleConnectionUpdate(sock, update).catch((err) =>
          logger.error('Error handling WhatsApp connection update', { err }),
        );
      });

      sock.ev.on('messages.update', (updates: Array<{ key?: { id?: string }; update?: { status?: number } }>) => {
        void this.handleMessageReceipts(updates).catch((err) =>
          logger.warn('Failed updating WhatsApp delivery receipt', { err }),
        );
      });

      return this.getState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize WhatsApp connection';
      await this.prisma.whatsAppConfig.update({
        where: { id: 'default' },
        data: { connectionStatus: 'ERROR', lastError: msg },
      });
      return this.getState();
    } finally {
      this.isConnecting = false;
    }
  }

  private async handleConnectionUpdate(
    sock: WhatsAppSocketLike,
    update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string },
  ): Promise<void> {
    if (sock !== this.sock) return;

    if (update.qr) {
      this.qrCodeDataUrl = await QRCode.toDataURL(update.qr, {
        width: 300,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      this.qrExpiresAt = new Date(Date.now() + 55_000);
      this.qrExpired = false;

      if (this.qrExpiryTimer) clearTimeout(this.qrExpiryTimer);
      this.qrExpiryTimer = setTimeout(() => {
        void this.markQrExpired();
      }, 55_000);

      await this.prisma.whatsAppConfig.update({
        where: { id: 'default' },
        data: { connectionStatus: 'QR_READY', lastError: null },
      });
    }

    if (update.connection === 'open') {
      this.clearTimers();
      this.qrCodeDataUrl = null;
      this.qrExpiresAt = null;
      this.qrExpired = false;
      this.reconnectAttempts = 0;

      const linkedPhone = jidToPhone(sock.user?.id);
      await this.prisma.whatsAppConfig.update({
        where: { id: 'default' },
        data: {
          connectionStatus: 'CONNECTED',
          linkedPhoneNumber: linkedPhone,
          lastConnectedAt: new Date(),
          lastError: null,
        },
      });

      logger.info('WhatsApp Web session connected', { linkedPhone });
      // Drain queued notifications created while disconnected
      void this.processPendingNotifications();
    }

    if (update.connection === 'close') {
      this.clearTimers();
      this.qrCodeDataUrl = null;
      this.qrExpiresAt = null;

      if (this.manualDisconnect) {
        await this.prisma.whatsAppConfig.update({
          where: { id: 'default' },
          data: { connectionStatus: 'DISCONNECTED' },
        });
        return;
      }

      const boomErr = update.lastDisconnect?.error as Boom | undefined;
      const statusCode = boomErr?.output?.statusCode;
      const reasonMsg =
        boomErr?.message || (statusCode ? `WhatsApp disconnected (code ${statusCode})` : 'WhatsApp connection closed');

      if (statusCode === DisconnectReason.loggedOut) {
        await this.prisma.whatsAppAuthEntry.deleteMany({});
        await this.prisma.whatsAppConfig.update({
          where: { id: 'default' },
          data: {
            connectionStatus: 'LOGGED_OUT',
            linkedPhoneNumber: null,
            lastError: 'WhatsApp session was logged out from your phone. Scan a new QR code to reconnect.',
          },
        });
        this.sock = null;
        return;
      }

      this.reconnectAttempts++;
      if (this.reconnectAttempts <= 6) {
        const delayMs = Math.min(60_000, 3000 * Math.pow(2, this.reconnectAttempts - 1));
        await this.prisma.whatsAppConfig.update({
          where: { id: 'default' },
          data: {
            connectionStatus: 'RECONNECTING',
            lastError: `${reasonMsg}. Retrying in ${Math.round(delayMs / 1000)}s...`,
          },
        });
        this.reconnectTimer = setTimeout(() => {
          void this.connect();
        }, delayMs);
      } else {
        await this.prisma.whatsAppConfig.update({
          where: { id: 'default' },
          data: {
            connectionStatus: 'ERROR',
            lastError: `${reasonMsg}. Automatic reconnect paused; click Reconnect WhatsApp.`,
          },
        });
      }
    }
  }

  private async markQrExpired(): Promise<void> {
    const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (cfg?.connectionStatus === 'QR_READY') {
      this.qrCodeDataUrl = null;
      this.qrExpiresAt = null;
      this.qrExpired = true;
      await this.prisma.whatsAppConfig.update({
        where: { id: 'default' },
        data: {
          lastError: 'QR code expired before scanning. Click Refresh QR Code to generate a new one.',
        },
      });
    }
  }

  private async handleMessageReceipts(
    updates: Array<{ key?: { id?: string }; update?: { status?: number } }>,
  ): Promise<void> {
    for (const item of updates) {
      const msgId = item.key?.id;
      const status = item.update?.status;
      // Baileys WAMessageStatus: 3 = DELIVERY_ACK, 4 = READ
      if (msgId && typeof status === 'number' && status >= 3) {
        await this.prisma.whatsAppNotificationJob.updateMany({
          where: {
            providerMessageId: msgId,
            status: 'SENT',
          },
          data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
          },
        });
      }
    }
  }

  async refreshQr(): Promise<WhatsAppPublicState> {
    return this.connect();
  }

  async disconnect(): Promise<WhatsAppPublicState> {
    this.manualDisconnect = true;
    this.clearTimers();
    this.qrCodeDataUrl = null;
    this.qrExpiresAt = null;
    this.qrExpired = false;
    if (this.sock) {
      try {
        this.sock.end?.(undefined);
      } catch {
        // Ignore cleanup errors
      }
      this.sock = null;
    }
    await this.prisma.whatsAppConfig.update({
      where: { id: 'default' },
      data: { connectionStatus: 'DISCONNECTED', lastError: null },
    });
    return this.getState();
  }

  async deleteStoredSession(): Promise<WhatsAppPublicState> {
    this.manualDisconnect = true;
    this.clearTimers();
    this.qrCodeDataUrl = null;
    this.qrExpiresAt = null;
    this.qrExpired = false;

    if (this.sock) {
      try {
        await this.sock.logout?.();
      } catch {
        try {
          this.sock.end?.(undefined);
        } catch {
          // Ignore logout errors
        }
      }
      this.sock = null;
    }

    await this.prisma.$transaction([
      this.prisma.whatsAppAuthEntry.deleteMany({}),
      this.prisma.whatsAppConfig.update({
        where: { id: 'default' },
        data: {
          connectionStatus: 'DISCONNECTED',
          linkedPhoneNumber: null,
          lastError: null,
        },
      }),
    ]);

    return this.getState();
  }

  async sendTestNotification(): Promise<{ jobId: string; status: string; providerMessageId?: string | null }> {
    const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (!cfg || cfg.connectionStatus !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp is not connected. Connect and scan the QR code first.');
    }
    if (!cfg.recipientPhoneNumber) {
      throw new Error('Configure your main WhatsApp recipient number first.');
    }

    const messageText = formatWhatsAppNotificationMessage({
      eventType: 'TEST',
      receivedAt: new Date(),
    });

    const job = await this.prisma.whatsAppNotificationJob.create({
      data: {
        dedupeKey: `test:${Date.now()}:${generateRandomToken(6)}`,
        eventType: 'TEST',
        recipientPhone: cfg.recipientPhoneNumber,
        messageText,
        status: 'SENDING',
        attempts: 1,
      },
    });

    const dispatched = await this.dispatchNotificationJob(job.id, cfg.recipientPhoneNumber, messageText, true);
    if (!dispatched.ok) {
      throw new Error(dispatched.error || 'Failed to send test notification');
    }

    return {
      jobId: job.id,
      status: dispatched.status,
      providerMessageId: dispatched.providerMessageId,
    };
  }

  async retryNotification(jobId: string): Promise<{ ok: boolean; status: string }> {
    const job = await this.prisma.whatsAppNotificationJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new Error('Notification job not found');
    }
    const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (!cfg || cfg.connectionStatus !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp is not connected; reconnect before retrying notifications.');
    }

    // Never auto-resend if we already have a providerMessageId unless user explicitly requests manual retry
    await this.prisma.whatsAppNotificationJob.update({
      where: { id: job.id },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    const res = await this.dispatchNotificationJob(job.id, job.recipientPhone, job.messageText, true);
    return { ok: res.ok, status: res.status };
  }

  async processPendingNotifications(): Promise<number> {
    if (this.isWorkerBusy) return 0;
    this.isWorkerBusy = true;

    let sentCount = 0;
    try {
      const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
      if (!cfg || cfg.connectionStatus !== 'CONNECTED' || !this.sock || !cfg.recipientPhoneNumber) {
        return 0;
      }

      const now = new Date();
      const jobs = await this.prisma.whatsAppNotificationJob.findMany({
        where: {
          status: { in: ['PENDING', 'RETRYING'] },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });

      for (const job of jobs) {
        // Re-check connection state before every send
        const freshCfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
        if (!freshCfg || freshCfg.connectionStatus !== 'CONNECTED' || !this.sock) {
          break;
        }

        // Security guard: enforce notification only goes to configured administrator recipient
        const targetPhone = freshCfg.recipientPhoneNumber;
        if (!targetPhone) break;

        // Claim atomically
        const claimed = await this.prisma.whatsAppNotificationJob.updateMany({
          where: { id: job.id, status: { in: ['PENDING', 'RETRYING'] } },
          data: { status: 'SENDING', attempts: { increment: 1 } },
        });
        if (claimed.count === 0) continue;

        const result = await this.dispatchNotificationJob(job.id, targetPhone, job.messageText, false);
        if (result.ok) sentCount++;
      }

      return sentCount;
    } finally {
      this.isWorkerBusy = false;
    }
  }

  private async dispatchNotificationJob(
    jobId: string,
    recipientPhone: string,
    messageText: string,
    isExplicitImmediate: boolean,
  ): Promise<{ ok: boolean; status: string; providerMessageId?: string | null; error?: string }> {
    const cfg = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (!this.sock || cfg?.connectionStatus !== 'CONNECTED') {
      await this.prisma.whatsAppNotificationJob.update({
        where: { id: jobId },
        data: {
          status: isExplicitImmediate ? 'FAILED' : 'PENDING',
          lastError: 'WhatsApp disconnected; queued until reconnection.',
        },
      });
      return { ok: false, status: 'PENDING', error: 'WhatsApp disconnected' };
    }

    // Handle same-number recipient cleanly by using normalized own JID if linked number matches
    const normalizedTarget = normalizeInternationalPhone(recipientPhone);
    const jid =
      cfg.linkedPhoneNumber && normalizeInternationalPhone(cfg.linkedPhoneNumber) === normalizedTarget && this.sock.user?.id
        ? `${jidNormalizedUser(this.sock.user.id).split('@')[0]}@s.whatsapp.net`
        : phoneToWhatsAppJid(normalizedTarget);

    try {
      const response = await this.sock.sendMessage(jid, { text: messageText });
      const providerMessageId = response?.key?.id ?? null;
      const now = new Date();

      await this.prisma.$transaction([
        this.prisma.whatsAppNotificationJob.update({
          where: { id: jobId },
          data: {
            status: 'SENT',
            providerMessageId,
            sentAt: now,
            lastError: null,
            nextRetryAt: null,
          },
        }),
        this.prisma.whatsAppConfig.update({
          where: { id: 'default' },
          data: { lastNotificationAt: now },
        }),
      ]);

      return { ok: true, status: 'SENT', providerMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'WhatsApp send failed';
      const job = await this.prisma.whatsAppNotificationJob.findUnique({ where: { id: jobId } });
      const attempts = job?.attempts ?? 1;
      const maxAttempts = job?.maxAttempts ?? 5;

      // Do not blindly auto-retry ambiguous timeout errors to avoid duplicate alerts
      const isAmbiguous = /timeout|timed out|uncertain/i.test(message);

      if (!isExplicitImmediate && !isAmbiguous && attempts < maxAttempts) {
        const delayMs = Math.min(15 * 60_000, 15_000 * Math.pow(2, attempts - 1));
        await this.prisma.whatsAppNotificationJob.update({
          where: { id: jobId },
          data: {
            status: 'RETRYING',
            nextRetryAt: new Date(Date.now() + delayMs),
            lastError: message,
          },
        });
        return { ok: false, status: 'RETRYING', error: message };
      }

      await this.prisma.whatsAppNotificationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          lastError: message,
        },
      });
      return { ok: false, status: 'FAILED', error: message };
    }
  }
}
