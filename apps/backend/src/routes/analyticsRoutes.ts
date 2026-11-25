import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { emailSchema, getLocalTimeParts, normalizeEmail } from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SendingEngine } from '../services/engine/sendingEngine.js';
import { generateGenericCsvExport } from '../services/leads/leadFileService.js';

export function createAnalyticsRoutes(
  prisma: PrismaClient,
  sqlite: Database.Database,
  sendingEngine: SendingEngine,
): Router {
  const router = Router();

  router.get('/dashboard', async (_req, res, next) => {
    try {
      const [
        settings,
        accounts,
        totalLeads,
        activeCampaigns,
        confirmedDeliveries,
        bounces,
        replies,
        recentEmails,
        recentReplies,
        recentErrors,
        whatsappConfig,
        recentWaNotifications,
      ] = await Promise.all([
        prisma.systemSettings.findUnique({ where: { id: 'default' } }),
        prisma.outlookAccount.findMany({ orderBy: { createdAt: 'asc' } }),
        prisma.lead.count(),
        prisma.campaign.count({ where: { status: 'ACTIVE' } }),
        prisma.emailMessage.count({ where: { isTestEmail: false, deliveryStatus: 'CONFIRMED_DELIVERED' } }),
        prisma.emailMessage.count({ where: { isTestEmail: false, status: 'BOUNCED' } }),
        prisma.emailMessage.count({ where: { isTestEmail: false, status: 'REPLIED' } }),
        prisma.emailMessage.findMany({
          include: {
            outlookAccount: { select: { email: true } },
            campaign: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        prisma.incomingEmail.findMany({
          where: { isCampaignReply: true },
          include: {
            outlookAccount: { select: { email: true } },
            matchedCampaign: { select: { name: true } },
          },
          orderBy: { receivedAt: 'desc' },
          take: 8,
        }),
        prisma.emailMessage.findMany({
          where: { status: 'FAILED' },
          include: { outlookAccount: { select: { email: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 8,
        }),
        prisma.whatsAppConfig.findUnique({ where: { id: 'default' } }),
        prisma.whatsAppNotificationJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
        }),
      ]);

      let sentTodayTotal = 0;
      let dailyLimitTotal = 0;
      const accountProgress = [];

      for (const acc of accounts) {
        const todayKey = getLocalTimeParts(new Date(), acc.timezone).dateKey;
        const counter = await prisma.accountDailyCounter.findUnique({
          where: { outlookAccountId_dateKey: { outlookAccountId: acc.id, dateKey: todayKey } },
        });
        const sentToday = counter?.sentCount ?? 0;
        if (acc.connectionStatus === 'CONNECTED') {
          sentTodayTotal += sentToday;
          dailyLimitTotal += acc.dailySendLimit;
        }
        accountProgress.push({
          id: acc.id,
          email: acc.email,
          connectionStatus: acc.connectionStatus,
          isPaused: acc.isPaused,
          dailySendLimit: acc.dailySendLimit,
          sentToday,
          remainingToday: Math.max(0, acc.dailySendLimit - sentToday),
        });
      }

      // 14-day activity series
      const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000);
      const events = await prisma.emailEvent.findMany({
        where: { occurredAt: { gte: fourteenDaysAgo } },
        select: { eventType: true, occurredAt: true },
      });

      const dayBuckets = new Map<
        string,
        { date: string; sent: number; delivered: number; opens: number; clicks: number; replies: number; bounces: number }
      >();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        dayBuckets.set(d, { date: d, sent: 0, delivered: 0, opens: 0, clicks: 0, replies: 0, bounces: 0 });
      }
      for (const ev of events) {
        const day = ev.occurredAt.toISOString().slice(0, 10);
        const bucket = dayBuckets.get(day);
        if (!bucket) continue;
        if (ev.eventType === 'SENT') bucket.sent++;
        if (ev.eventType === 'DELIVERED') bucket.delivered++;
        if (ev.eventType === 'OPEN') bucket.opens++;
        if (ev.eventType === 'CLICK') bucket.clicks++;
        if (ev.eventType === 'REPLY') bucket.replies++;
        if (ev.eventType.includes('BOUNCE')) bucket.bounces++;
      }

      const campaigns = await prisma.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { outlookAccount: { select: { email: true } } },
      });

      const campaignPerformance = await Promise.all(
        campaigns.map(async (c) => {
          const [sent, delivered, repliedCount, bouncedCount] = await Promise.all([
            prisma.emailMessage.count({
              where: {
                campaignId: c.id,
                isTestEmail: false,
                status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'] },
              },
            }),
            prisma.emailMessage.count({
              where: { campaignId: c.id, isTestEmail: false, deliveryStatus: 'CONFIRMED_DELIVERED' },
            }),
            prisma.emailMessage.count({ where: { campaignId: c.id, isTestEmail: false, status: 'REPLIED' } }),
            prisma.emailMessage.count({ where: { campaignId: c.id, isTestEmail: false, status: 'BOUNCED' } }),
          ]);
          return {
            id: c.id,
            name: c.name,
            status: c.status,
            accountEmail: c.outlookAccount.email,
            sent,
            delivered,
            replies: repliedCount,
            bounces: bouncedCount,
          };
        }),
      );

      res.json({
        globalPaused: settings?.globalPaused ?? false,
        testMode: settings?.testMode ?? false,
        summary: {
          connectedAccounts: accounts.filter((a) => a.connectionStatus === 'CONNECTED').length,
          totalAccounts: accounts.length,
          totalLeads,
          emailsSentToday: sentTodayTotal,
          emailsRemainingToday: Math.max(0, dailyLimitTotal - sentTodayTotal),
          confirmedDeliveries,
          bounces,
          replies,
          activeCampaigns,
        },
        accountProgress,
        campaignPerformance,
        activitySeries: Array.from(dayBuckets.values()),
        recentEmails,
        recentReplies,
        recentErrors,
        whatsapp: {
          connectionStatus: whatsappConfig?.connectionStatus ?? 'DISCONNECTED',
          linkedPhoneNumber: whatsappConfig?.linkedPhoneNumber ?? null,
          recipientPhoneNumber: whatsappConfig?.recipientPhoneNumber ?? null,
          recentNotifications: recentWaNotifications,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/emails', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 25)));

      const where: Record<string, unknown> = {};
      if (accountId) where.outlookAccountId = accountId;
      if (campaignId) where.campaignId = campaignId;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { recipientEmail: { contains: search } },
          { subject: { contains: search } },
        ];
      }

      const [total, emails, uncertainJobs] = await Promise.all([
        prisma.emailMessage.count({ where }),
        prisma.emailMessage.findMany({
          where,
          include: {
            outlookAccount: { select: { id: true, email: true } },
            campaign: { select: { id: true, name: true } },
            lead: { select: { id: true, firstName: true, lastName: true, company: true } },
            sendingJob: { select: { id: true, status: true, attempts: true, maxAttempts: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.sendingJob.findMany({
          where: { status: 'UNCERTAIN' },
          include: {
            outlookAccount: { select: { email: true } },
            campaign: { select: { name: true } },
          },
        }),
      ]);

      res.json({
        emails,
        uncertainJobs,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/emails/export', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const where: Record<string, unknown> = {};
      if (accountId) where.outlookAccountId = accountId;
      if (campaignId) where.campaignId = campaignId;

      const rows = await prisma.emailMessage.findMany({
        where,
        include: {
          outlookAccount: { select: { email: true } },
          campaign: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const csv = generateGenericCsvExport(
        rows.map((m) => ({
          id: m.id,
          outlook_account: m.outlookAccount.email,
          campaign: m.campaign?.name ?? '',
          recipient_email: m.recipientEmail,
          subject: m.subject,
          is_test_email: m.isTestEmail,
          status: m.status,
          delivery_status: m.deliveryStatus,
          delivery_source: m.deliverySource,
          bounce_type: m.bounceType,
          open_count: m.openCount,
          click_count: m.clickCount,
          sent_at: m.sentAt?.toISOString() ?? '',
          delivered_at: m.deliveredAt?.toISOString() ?? '',
          replied_at: m.repliedAt?.toISOString() ?? '',
          graph_message_id: m.graphMessageId ?? '',
          internet_message_id: m.internetMessageId ?? '',
          error_message: m.errorMessage ?? '',
        })),
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="email-activity-export.csv"');
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/reconcile', async (req, res, next) => {
    try {
      const result = await sendingEngine.reconcileUncertainJob(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/analytics', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const leadId = typeof req.query.leadId === 'string' ? req.query.leadId : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const fromDate = typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : undefined;
      const toDate = typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : undefined;

      const msgWhere: Record<string, unknown> = { isTestEmail: false };
      if (accountId) msgWhere.outlookAccountId = accountId;
      if (campaignId) msgWhere.campaignId = campaignId;
      if (leadId) msgWhere.leadId = leadId;
      if (status) msgWhere.status = status;
      if (fromDate || toDate) {
        msgWhere.createdAt = {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lte: toDate } : {}),
        };
      }

      const jobWhere: Record<string, unknown> = { status: 'PENDING' };
      if (accountId) jobWhere.outlookAccountId = accountId;
      if (campaignId) jobWhere.campaignId = campaignId;
      if (leadId) jobWhere.leadId = leadId;

      const [
        totalQueued,
        messages,
        totalUnsubscribes,
      ] = await Promise.all([
        prisma.sendingJob.count({ where: jobWhere }),
        prisma.emailMessage.findMany({ where: msgWhere }),
        prisma.suppressionEntry.count({ where: { reason: 'UNSUBSCRIBED' } }),
      ]);

      const sentMessages = messages.filter((m) =>
        ['SENT', 'DELIVERED', 'DELIVERY_UNKNOWN', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'].includes(m.status),
      );
      const totalSent = sentMessages.length;
      const totalConfirmedDeliveries = sentMessages.filter(
        (m) => m.deliveryStatus === 'CONFIRMED_DELIVERED',
      ).length;
      const totalDeliveryUnknown = sentMessages.filter(
        (m) => m.deliveryStatus === 'DELIVERY_UNKNOWN' || m.deliveryStatus === 'SENT',
      ).length;
      const totalBounces = sentMessages.filter((m) => m.status === 'BOUNCED').length;
      const totalHardBounces = sentMessages.filter((m) => m.bounceType === 'HARD').length;
      const totalSoftBounces = sentMessages.filter((m) => m.bounceType === 'SOFT').length;
      const totalOpens = messages.reduce((sum, m) => sum + m.openCount, 0);
      const totalUniqueOpens = messages.filter((m) => m.openCount > 0).length;
      const totalClicks = messages.reduce((sum, m) => sum + m.clickCount, 0);
      const totalUniqueClicks = messages.filter((m) => m.clickCount > 0).length;
      const totalReplies = messages.filter((m) => m.status === 'REPLIED').length;
      const totalFailures = messages.filter((m) => m.status === 'FAILED').length;

      const pct = (num: number, den: number) => (den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0);

      res.json({
        metrics: {
          totalQueued,
          totalSent,
          totalConfirmedDeliveries,
          totalDeliveryUnknown,
          totalBounces,
          totalHardBounces,
          totalSoftBounces,
          totalOpens,
          totalUniqueOpens,
          totalClicks,
          totalUniqueClicks,
          totalReplies,
          totalFailures,
          totalUnsubscribes,
          confirmedDeliveryRate: pct(totalConfirmedDeliveries, totalSent),
          bounceRate: pct(totalBounces, totalSent),
          openRateEstimate: pct(totalUniqueOpens, totalSent),
          clickRateEstimate: pct(totalUniqueClicks, totalSent),
          replyRate: pct(totalReplies, totalSent),
        },
        methodology: {
          confirmedMetrics: [
            'Total Sent (Microsoft Graph accepted send request)',
            'Confirmed Deliveries (proven via DSN delivery receipt or recipient reply)',
            'Bounces & Hard/Soft Bounces (parsed from NDR bounce emails)',
            'Replies (matched by In-Reply-To / References / Conversation ID)',
            'Unsubscribes (explicit opt-out actions)',
          ],
          estimatedMetrics: [
            'Opens & Open Rate (pixel loads can be blocked by mail clients or pre-fetched by automated scanners)',
            'Clicks & Click Rate (security scanners may pre-fetch links before a human reads the email)',
            'Delivery Unknown (sent emails without explicit provider delivery confirmation or bounce)',
          ],
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Suppression list endpoints
  router.get('/suppression', async (_req, res, next) => {
    try {
      const entries = await prisma.suppressionEntry.findMany({ orderBy: { createdAt: 'desc' } });
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  router.post('/suppression', async (req, res, next) => {
    try {
      const parsed = z
        .object({
          email: emailSchema,
          reason: z.enum(['HARD_BOUNCE', 'UNSUBSCRIBED', 'MANUAL', 'COMPLAINT']).default('MANUAL'),
          notes: z.string().max(400).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid email' });
        return;
      }

      const normalized = normalizeEmail(parsed.data.email);
      const entry = await prisma.$transaction(async (tx) => {
        const upserted = await tx.suppressionEntry.upsert({
          where: { email: normalized },
          create: { email: normalized, reason: parsed.data.reason, notes: parsed.data.notes ?? null },
          update: { reason: parsed.data.reason, notes: parsed.data.notes ?? null },
        });
        await tx.lead.updateMany({
          where: { email: normalized },
          data: { status: 'SUPPRESSED' },
        });
        await tx.sendingJob.updateMany({
          where: { recipientEmail: normalized, status: 'PENDING' },
          data: { status: 'CANCELLED', lastError: 'Recipient suppressed' },
        });
        return upserted;
      });

      res.status(201).json({ entry });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/suppression/:id', async (req, res, next) => {
    try {
      await prisma.suppressionEntry.delete({ where: { id: req.params.id } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // System Settings & Global Pause
  router.get('/settings', async (_req, res, next) => {
    try {
      const settings = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
      res.json({ settings });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/settings', async (req, res, next) => {
    try {
      const schema = z.object({
        globalPaused: z.boolean().optional(),
        testMode: z.boolean().optional(),
        testModeRecipientEmail: emailSchema.nullable().optional(),
        openTrackingEnabled: z.boolean().optional(),
        clickTrackingEnabled: z.boolean().optional(),
        unsubscribeFooterEnabled: z.boolean().optional(),
        maxCampaignSize: z.number().int().min(1).max(50000).optional(),
        maxSendRetries: z.number().int().min(1).max(10).optional(),
        publicBaseUrl: z.string().url().nullable().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid settings' });
        return;
      }

      if (parsed.data.testMode && !parsed.data.testModeRecipientEmail) {
        const existing = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
        if (!existing?.testModeRecipientEmail) {
          res.status(400).json({
            error: 'Enter your verified test recipient email address before enabling Test Mode.',
          });
          return;
        }
      }

      const updated = await prisma.systemSettings.update({
        where: { id: 'default' },
        data: parsed.data,
      });

      await prisma.auditLog.create({
        data: {
          action: 'SETTINGS_UPDATED',
          entityType: 'SystemSettings',
          entityId: 'default',
          detailsJson: JSON.stringify(parsed.data),
          ipAddress: req.ip,
        },
      });

      res.json({ settings: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post('/settings/global-pause', async (req, res, next) => {
    try {
      const paused = Boolean(req.body?.paused);
      const updated = await prisma.systemSettings.update({
        where: { id: 'default' },
        data: { globalPaused: paused },
      });
      await prisma.auditLog.create({
        data: {
          action: paused ? 'GLOBAL_PAUSED' : 'GLOBAL_RESUMED',
          entityType: 'SystemSettings',
          entityId: 'default',
          ipAddress: req.ip,
        },
      });
      res.json({ ok: true, globalPaused: updated.globalPaused });
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit-logs', async (_req, res, next) => {
    try {
      const logs = await prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json({ logs });
    } catch (err) {
      next(err);
    }
  });

  // WAL-safe SQLite database backup download
  router.get('/system/backup', async (req, res, next) => {
    const tmpBackupPath = path.join(os.tmpdir(), `outreach-engine-backup-${Date.now()}.db`);
    try {
      await sqlite.backup(tmpBackupPath);
      await prisma.auditLog.create({
        data: { action: 'DATABASE_BACKUP_DOWNLOADED', entityType: 'System', ipAddress: req.ip },
      });
      res.download(tmpBackupPath, `outreach-engine-backup-${new Date().toISOString().slice(0, 10)}.db`, () => {
        fs.unlink(tmpBackupPath, () => undefined);
      });
    } catch (err) {
      fs.unlink(tmpBackupPath, () => undefined);
      next(err);
    }
  });

  return router;
}
