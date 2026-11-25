import { Router } from 'express';
import { z } from 'zod';
import {
  accountConfigSchema,
  emailSchema,
  getLocalTimeParts,
} from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from '../config/env.js';
import { generateRandomToken } from '../crypto/security.js';
import { sanitizeEmailHtml } from '../utils/sanitizer.js';
import type { MicrosoftGraphClient } from '../services/microsoft/graphTypes.js';
import { MicrosoftOAuthService } from '../services/microsoft/oauthService.js';
import type { InboxSyncService } from '../services/microsoft/inboxSyncService.js';

function serializeAccountPublic(
  account: {
    id: string;
    email: string;
    displayName: string | null;
    accountType: string;
    connectionStatus: string;
    authorizationStatus: string;
    scopes: string | null;
    lastError: string | null;
    isPaused: boolean;
    dailySendLimit: number;
    minDelayMinutes: number;
    maxDelayMinutes: number;
    scheduleStartTime: string;
    scheduleEndTime: string;
    timezone: string;
    allowedWeekdays: string;
    signatureHtml: string | null;
    signatureEnabled: boolean;
    whatsappNotificationsEnabled: boolean;
    nextEligibleSendAt: Date | null;
    lastActivityAt: Date | null;
    lastInboxSyncAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  stats: {
    sentToday: number;
    leadsAssigned: number;
    activeCampaigns: number;
    emailsSent: number;
    confirmedDeliveries: number;
    bounces: number;
    opens: number;
    clicks: number;
    replies: number;
  },
) {
  let allowedWeekdays: number[] = [1, 2, 3, 4, 5];
  try {
    allowedWeekdays = JSON.parse(account.allowedWeekdays) as number[];
  } catch {
    allowedWeekdays = [1, 2, 3, 4, 5];
  }

  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    accountType: account.accountType,
    connectionStatus: account.connectionStatus,
    authorizationStatus: account.authorizationStatus,
    scopes: account.scopes,
    lastError: account.lastError,
    isPaused: account.isPaused,
    dailySendLimit: account.dailySendLimit,
    minDelayMinutes: account.minDelayMinutes,
    maxDelayMinutes: account.maxDelayMinutes,
    scheduleStartTime: account.scheduleStartTime,
    scheduleEndTime: account.scheduleEndTime,
    timezone: account.timezone,
    allowedWeekdays,
    signatureHtml: account.signatureHtml,
    signatureEnabled: account.signatureEnabled,
    whatsappNotificationsEnabled: account.whatsappNotificationsEnabled,
    nextEligibleSendAt: account.nextEligibleSendAt,
    lastActivityAt: account.lastActivityAt,
    lastInboxSyncAt: account.lastInboxSyncAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    stats: {
      ...stats,
      remainingToday: Math.max(0, account.dailySendLimit - stats.sentToday),
    },
  };
}

export async function buildAccountStats(prisma: PrismaClient, accountId: string, timezone: string) {
  const todayKey = getLocalTimeParts(new Date(), timezone).dateKey;

  const [
    dailyCounter,
    leadsAssigned,
    activeCampaigns,
    emailsSent,
    confirmedDeliveries,
    bounces,
    opensAgg,
    clicksAgg,
    replies,
  ] = await Promise.all([
    prisma.accountDailyCounter.findUnique({
      where: { outlookAccountId_dateKey: { outlookAccountId: accountId, dateKey: todayKey } },
    }),
    prisma.lead.count({ where: { outlookAccountId: accountId } }),
    prisma.campaign.count({ where: { outlookAccountId: accountId, status: 'ACTIVE' } }),
    prisma.emailMessage.count({
      where: {
        outlookAccountId: accountId,
        isTestEmail: false,
        status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'] },
      },
    }),
    prisma.emailMessage.count({
      where: {
        outlookAccountId: accountId,
        isTestEmail: false,
        deliveryStatus: 'CONFIRMED_DELIVERED',
      },
    }),
    prisma.emailMessage.count({
      where: { outlookAccountId: accountId, isTestEmail: false, status: 'BOUNCED' },
    }),
    prisma.emailMessage.aggregate({
      where: { outlookAccountId: accountId, isTestEmail: false },
      _sum: { openCount: true, clickCount: true },
    }),
    prisma.emailMessage.count({
      where: { outlookAccountId: accountId, isTestEmail: false, clickCount: { gt: 0 } },
    }),
    prisma.emailMessage.count({
      where: { outlookAccountId: accountId, isTestEmail: false, status: 'REPLIED' },
    }),
  ]);

  return {
    sentToday: dailyCounter?.sentCount ?? 0,
    leadsAssigned,
    activeCampaigns,
    emailsSent,
    confirmedDeliveries,
    bounces,
    opens: opensAgg._sum.openCount ?? 0,
    clicks: opensAgg._sum.clickCount ?? clicksAgg,
    replies,
  };
}

export function createAccountRoutes(
  prisma: PrismaClient,
  config: AppConfig,
  oauthService: MicrosoftOAuthService,
  graphClient: MicrosoftGraphClient,
  inboxSyncService: InboxSyncService,
): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const accounts = await prisma.outlookAccount.findMany({
        orderBy: { createdAt: 'desc' },
      });

      const items = await Promise.all(
        accounts.map(async (acc) => {
          const stats = await buildAccountStats(prisma, acc.id, acc.timezone);
          return serializeAccountPublic(acc, stats);
        }),
      );

      res.json({
        oauthConfigured: oauthService.isConfigured(),
        accounts: items,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/connect-url', async (req, res, next) => {
    try {
      const loginHint = typeof req.body?.loginHint === 'string' ? req.body.loginHint.trim() : undefined;
      const result = await oauthService.createAuthorizationUrl({ loginHint, redirectTo: '/accounts' });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const acc = await prisma.outlookAccount.findUnique({ where: { id: req.params.id } });
      if (!acc) {
        res.status(404).json({ error: 'Outlook account not found' });
        return;
      }
      const stats = await buildAccountStats(prisma, acc.id, acc.timezone);
      res.json({ account: serializeAccountPublic(acc, stats) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const acc = await prisma.outlookAccount.findUnique({ where: { id: req.params.id } });
      if (!acc) {
        res.status(404).json({ error: 'Outlook account not found' });
        return;
      }

      const parsed = accountConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid account configuration' });
        return;
      }

      const sanitizedSig =
        parsed.data.signatureHtml !== undefined
          ? parsed.data.signatureHtml
            ? sanitizeEmailHtml(parsed.data.signatureHtml)
            : null
          : acc.signatureHtml;

      const updated = await prisma.outlookAccount.update({
        where: { id: acc.id },
        data: {
          dailySendLimit: parsed.data.dailySendLimit,
          minDelayMinutes: parsed.data.minDelayMinutes,
          maxDelayMinutes: parsed.data.maxDelayMinutes,
          scheduleStartTime: parsed.data.scheduleStartTime,
          scheduleEndTime: parsed.data.scheduleEndTime,
          timezone: parsed.data.timezone,
          allowedWeekdays: JSON.stringify(parsed.data.allowedWeekdays),
          signatureHtml: sanitizedSig,
          signatureEnabled: parsed.data.signatureEnabled ?? acc.signatureEnabled,
          whatsappNotificationsEnabled:
            parsed.data.whatsappNotificationsEnabled ?? acc.whatsappNotificationsEnabled,
        },
      });

      await prisma.auditLog.create({
        data: {
          action: 'ACCOUNT_UPDATED',
          entityType: 'OutlookAccount',
          entityId: acc.id,
          detailsJson: JSON.stringify({
            dailySendLimit: updated.dailySendLimit,
            minDelayMinutes: updated.minDelayMinutes,
            maxDelayMinutes: updated.maxDelayMinutes,
            timezone: updated.timezone,
          }),
          ipAddress: req.ip,
        },
      });

      const stats = await buildAccountStats(prisma, updated.id, updated.timezone);
      res.json({ account: serializeAccountPublic(updated, stats) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/pause', async (req, res, next) => {
    try {
      const updated = await prisma.outlookAccount.update({
        where: { id: req.params.id },
        data: { isPaused: true },
      });
      await prisma.auditLog.create({
        data: { action: 'ACCOUNT_PAUSED', entityType: 'OutlookAccount', entityId: updated.id, ipAddress: req.ip },
      });
      res.json({ ok: true, isPaused: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/resume', async (req, res, next) => {
    try {
      const updated = await prisma.outlookAccount.update({
        where: { id: req.params.id },
        data: { isPaused: false },
      });
      await prisma.auditLog.create({
        data: { action: 'ACCOUNT_RESUMED', entityType: 'OutlookAccount', entityId: updated.id, ipAddress: req.ip },
      });
      res.json({ ok: true, isPaused: false });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/disconnect', async (req, res, next) => {
    try {
      const acc = await prisma.outlookAccount.findUnique({ where: { id: req.params.id } });
      if (!acc) {
        res.status(404).json({ error: 'Outlook account not found' });
        return;
      }

      await prisma.$transaction([
        prisma.outlookAccount.update({
          where: { id: acc.id },
          data: {
            connectionStatus: 'DISCONNECTED',
            authorizationStatus: 'DISCONNECTED',
            encryptedAccessToken: null,
            encryptedRefreshToken: null,
            tokenExpiresAt: null,
            graphSubscriptionId: null,
            graphSubscriptionExpiresAt: null,
            lastError: null,
          },
        }),
        prisma.campaign.updateMany({
          where: { outlookAccountId: acc.id, status: 'ACTIVE' },
          data: { status: 'PAUSED' },
        }),
        prisma.auditLog.create({
          data: {
            action: 'ACCOUNT_DISCONNECTED',
            entityType: 'OutlookAccount',
            entityId: acc.id,
            detailsJson: JSON.stringify({ email: acc.email, historicalDataPreserved: true }),
            ipAddress: req.ip,
          },
        }),
      ]);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/sync-inbox', async (req, res, next) => {
    try {
      const result = await inboxSyncService.syncAccountInbox(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/test-email', async (req, res, next) => {
    try {
      const acc = await prisma.outlookAccount.findUnique({ where: { id: req.params.id } });
      if (!acc || acc.connectionStatus !== 'CONNECTED') {
        res.status(400).json({ error: 'Outlook account must be connected to send a test email' });
        return;
      }

      const settings = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
      const verifiedRecipient = settings?.testModeRecipientEmail;
      const bodyParsed = z
        .object({
          recipientEmail: emailSchema.optional(),
          subject: z.string().trim().min(1).max(200).optional(),
          body: z.string().trim().min(1).max(10000).optional(),
        })
        .safeParse(req.body);

      if (!bodyParsed.success) {
        res.status(400).json({ error: bodyParsed.error.issues[0]?.message || 'Invalid test email payload' });
        return;
      }

      // Enforce test email only sends to verified test recipient or explicitly confirmed own address when no global test restriction blocks it
      const targetEmail = bodyParsed.data.recipientEmail || verifiedRecipient;
      if (!targetEmail) {
        res.status(400).json({
          error: 'Configure a verified test recipient email in Settings or enter your recipient address.',
        });
        return;
      }
      if (settings?.testMode && verifiedRecipient && targetEmail !== verifiedRecipient) {
        res.status(400).json({
          error: `Test Mode restricts test emails strictly to your verified email (${verifiedRecipient}).`,
        });
        return;
      }

      const accessToken = await oauthService.getValidAccessToken(acc.id);
      const correlationId = `test-${generateRandomToken(12)}`;
      const subject = bodyParsed.data.subject || `[Outreach Engine Test] Connection test from ${acc.email}`;
      const rawHtml = sanitizeEmailHtml(
        bodyParsed.data.body || `<p>This is a test email sent from <strong>${acc.email}</strong> via Outreach Engine.</p>`,
      );

      const draft = await graphClient.createDraft(accessToken, {
        subject,
        htmlBody: rawHtml,
        toEmail: targetEmail,
        correlationId,
      });
      await graphClient.sendDraft(accessToken, draft.id);

      const sentAt = new Date();
      await prisma.emailMessage.create({
        data: {
          outlookAccountId: acc.id,
          recipientEmail: targetEmail,
          subject,
          renderedBodyPreview: 'Test email dispatched via Microsoft Graph',
          isTestEmail: true,
          status: 'SENT',
          deliveryStatus: 'DELIVERY_UNKNOWN',
          graphDraftId: draft.id,
          graphMessageId: draft.id,
          internetMessageId: draft.internetMessageId ?? null,
          conversationId: draft.conversationId ?? null,
          correlationId,
          providerResponseCode: 202,
          providerResponseText: 'Test email accepted by Microsoft Graph',
          sentAt,
        },
      });

      res.json({ ok: true, recipientEmail: targetEmail, correlationId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createOAuthCallbackRoute(oauthService: MicrosoftOAuthService, config: AppConfig): Router {
  const router = Router();

  router.get('/callback', async (req, res) => {
    const frontendBase = config.nodeEnv === 'production' ? '' : config.corsOrigins[0] || 'http://localhost:5173';
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const error = typeof req.query.error === 'string' ? req.query.error : undefined;
      const errorDescription =
        typeof req.query.error_description === 'string' ? req.query.error_description : undefined;

      const result = await oauthService.handleCallback({
        code,
        state,
        error,
        errorDescription,
      });

      res.redirect(`${frontendBase}${result.redirectTo}?connected=${encodeURIComponent(result.email)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OAuth connection failed';
      res.redirect(`${frontendBase}/accounts?oauth_error=${encodeURIComponent(msg)}`);
    }
  });

  return router;
}
