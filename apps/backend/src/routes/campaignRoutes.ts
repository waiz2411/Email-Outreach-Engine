import { Router } from 'express';
import { z } from 'zod';
import {
  campaignCreateSchema,
  looksLikeHtml,
  normalizeEmail,
  renderPersonalizedEmail,
} from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SendingEngine } from '../services/engine/sendingEngine.js';
import { generateGenericCsvExport } from '../services/leads/leadFileService.js';
import { buildEmailPreviewHtml } from '../services/tracking/trackingService.js';

async function buildCampaignMetrics(prisma: PrismaClient, campaignId: string) {
  const [
    totalLeads,
    emailsSent,
    confirmedDeliveries,
    bounces,
    opensAgg,
    uniqueOpens,
    uniqueClicks,
    replies,
    failures,
    pendingJobs,
    uncertainJobs,
  ] = await Promise.all([
    prisma.lead.count({ where: { campaignId } }),
    prisma.emailMessage.count({
      where: {
        campaignId,
        isTestEmail: false,
        status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'] },
      },
    }),
    prisma.emailMessage.count({
      where: { campaignId, isTestEmail: false, deliveryStatus: 'CONFIRMED_DELIVERED' },
    }),
    prisma.emailMessage.count({ where: { campaignId, isTestEmail: false, status: 'BOUNCED' } }),
    prisma.emailMessage.aggregate({
      where: { campaignId, isTestEmail: false },
      _sum: { openCount: true, clickCount: true },
    }),
    prisma.emailMessage.count({ where: { campaignId, isTestEmail: false, openCount: { gt: 0 } } }),
    prisma.emailMessage.count({ where: { campaignId, isTestEmail: false, clickCount: { gt: 0 } } }),
    prisma.emailMessage.count({ where: { campaignId, isTestEmail: false, status: 'REPLIED' } }),
    prisma.emailMessage.count({ where: { campaignId, isTestEmail: false, status: 'FAILED' } }),
    prisma.sendingJob.count({ where: { campaignId, status: 'PENDING' } }),
    prisma.sendingJob.count({ where: { campaignId, status: 'UNCERTAIN' } }),
  ]);

  return {
    totalLeads,
    emailsSent,
    confirmedDeliveries,
    bounces,
    opens: opensAgg._sum.openCount ?? 0,
    uniqueOpens,
    clicks: opensAgg._sum.clickCount ?? 0,
    uniqueClicks,
    replies,
    failures,
    pendingJobs,
    uncertainJobs,
  };
}

export function createCampaignRoutes(prisma: PrismaClient, sendingEngine: SendingEngine): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const accountId = typeof req.query.outlookAccountId === 'string' ? req.query.outlookAccountId : undefined;
      const campaigns = await prisma.campaign.findMany({
        where: accountId ? { outlookAccountId: accountId } : undefined,
        include: {
          outlookAccount: {
            select: {
              id: true,
              email: true,
              connectionStatus: true,
              isPaused: true,
              dailySendLimit: true,
              minDelayMinutes: true,
              maxDelayMinutes: true,
              scheduleStartTime: true,
              scheduleEndTime: true,
              timezone: true,
              allowedWeekdays: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const enriched = await Promise.all(
        campaigns.map(async (c) => ({
          ...c,
          allowedWeekdays: c.allowedWeekdays
            ? (JSON.parse(c.allowedWeekdays) as number[])
            : (JSON.parse(c.outlookAccount.allowedWeekdays) as number[]),
          effectiveDailyLimit: c.useAccountDefaults
            ? c.outlookAccount.dailySendLimit
            : Math.min(c.outlookAccount.dailySendLimit, c.dailyLimit ?? c.outlookAccount.dailySendLimit),
          effectiveMinDelayMinutes: c.useAccountDefaults
            ? c.outlookAccount.minDelayMinutes
            : Math.max(c.outlookAccount.minDelayMinutes, c.minDelayMinutes ?? c.outlookAccount.minDelayMinutes),
          effectiveMaxDelayMinutes: c.useAccountDefaults
            ? c.outlookAccount.maxDelayMinutes
            : Math.max(c.outlookAccount.minDelayMinutes, c.maxDelayMinutes ?? c.outlookAccount.maxDelayMinutes),
          metrics: await buildCampaignMetrics(prisma, c.id),
        })),
      );

      res.json({ campaigns: enriched });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = campaignCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid campaign payload' });
        return;
      }

      const account = await prisma.outlookAccount.findUnique({
        where: { id: parsed.data.outlookAccountId },
      });
      if (!account) {
        res.status(404).json({ error: 'Selected Outlook account not found' });
        return;
      }

      const settings = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
      const maxSize = settings?.maxCampaignSize ?? 5000;

      const leadIds = parsed.data.leadIds ?? [];
      if (leadIds.length > maxSize) {
        res.status(400).json({ error: `Campaign cannot exceed maximum configured size (${maxSize} leads).` });
        return;
      }

      if (leadIds.length > 0) {
        const matchedLeads = await prisma.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, outlookAccountId: true },
        });
        if (matchedLeads.length !== leadIds.length) {
          res.status(400).json({ error: 'One or more selected leads do not exist' });
          return;
        }
        const wrongAccount = matchedLeads.some((l) => l.outlookAccountId !== account.id);
        if (wrongAccount) {
          res.status(400).json({
            error: 'All leads in a campaign must belong to the same selected Outlook account.',
          });
          return;
        }
      }

      const campaign = await prisma.$transaction(async (tx) => {
        const created = await tx.campaign.create({
          data: {
            name: parsed.data.name,
            outlookAccountId: account.id,
            status: 'DRAFT',
            startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : null,
            endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
            isTestMode: parsed.data.isTestMode,
            useAccountDefaults: parsed.data.useAccountDefaults,
            dailyLimit: parsed.data.dailyLimit ?? null,
            minDelayMinutes: parsed.data.minDelayMinutes ?? null,
            maxDelayMinutes: parsed.data.maxDelayMinutes ?? null,
            scheduleStartTime: parsed.data.scheduleStartTime ?? null,
            scheduleEndTime: parsed.data.scheduleEndTime ?? null,
            timezone: parsed.data.timezone ?? null,
            allowedWeekdays: parsed.data.allowedWeekdays ? JSON.stringify(parsed.data.allowedWeekdays) : null,
          },
        });

        if (leadIds.length > 0) {
          await tx.lead.updateMany({
            where: { id: { in: leadIds }, outlookAccountId: account.id },
            data: { campaignId: created.id },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'CAMPAIGN_CREATED',
            entityType: 'Campaign',
            entityId: created.id,
            detailsJson: JSON.stringify({ name: created.name, leadCount: leadIds.length }),
            ipAddress: req.ip,
          },
        });

        return created;
      });

      res.status(201).json({ campaign });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          outlookAccount: { select: { id: true, email: true, connectionStatus: true, timezone: true } },
          leads: { orderBy: { createdAt: 'asc' }, take: 200 },
        },
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      const metrics = await buildCampaignMetrics(prisma, campaign.id);
      res.json({ campaign, metrics });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      const patchSchema = z.object({
        name: z.string().trim().min(2).max(160).optional(),
        startDate: z.string().datetime().nullable().optional(),
        endDate: z.string().datetime().nullable().optional(),
        isTestMode: z.boolean().optional(),
        useAccountDefaults: z.boolean().optional(),
        dailyLimit: z.number().int().min(1).max(2000).nullable().optional(),
        minDelayMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        maxDelayMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        scheduleStartTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
        scheduleEndTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
        timezone: z.string().nullable().optional(),
        allowedWeekdays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
        leadIdsToAdd: z.array(z.string().min(1)).optional(),
      });

      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid campaign update' });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const c = await tx.campaign.update({
          where: { id: existing.id },
          data: {
            name: parsed.data.name ?? existing.name,
            startDate:
              parsed.data.startDate !== undefined
                ? parsed.data.startDate
                  ? new Date(parsed.data.startDate)
                  : null
                : existing.startDate,
            endDate:
              parsed.data.endDate !== undefined
                ? parsed.data.endDate
                  ? new Date(parsed.data.endDate)
                  : null
                : existing.endDate,
            isTestMode: parsed.data.isTestMode ?? existing.isTestMode,
            useAccountDefaults: parsed.data.useAccountDefaults ?? existing.useAccountDefaults,
            dailyLimit: parsed.data.dailyLimit !== undefined ? parsed.data.dailyLimit : existing.dailyLimit,
            minDelayMinutes:
              parsed.data.minDelayMinutes !== undefined ? parsed.data.minDelayMinutes : existing.minDelayMinutes,
            maxDelayMinutes:
              parsed.data.maxDelayMinutes !== undefined ? parsed.data.maxDelayMinutes : existing.maxDelayMinutes,
            scheduleStartTime:
              parsed.data.scheduleStartTime !== undefined
                ? parsed.data.scheduleStartTime
                : existing.scheduleStartTime,
            scheduleEndTime:
              parsed.data.scheduleEndTime !== undefined ? parsed.data.scheduleEndTime : existing.scheduleEndTime,
            timezone: parsed.data.timezone !== undefined ? parsed.data.timezone : existing.timezone,
            allowedWeekdays:
              parsed.data.allowedWeekdays !== undefined
                ? parsed.data.allowedWeekdays
                  ? JSON.stringify(parsed.data.allowedWeekdays)
                  : null
                : existing.allowedWeekdays,
          },
        });

        if (parsed.data.leadIdsToAdd && parsed.data.leadIdsToAdd.length > 0) {
          await tx.lead.updateMany({
            where: {
              id: { in: parsed.data.leadIdsToAdd },
              outlookAccountId: existing.outlookAccountId,
            },
            data: { campaignId: existing.id },
          });
        }
        return c;
      });

      res.json({ campaign: updated });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/preview', async (req, res, next) => {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          outlookAccount: true,
          leads: { orderBy: { createdAt: 'asc' }, take: 50 },
        },
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      const previews = campaign.leads.map((lead) => {
        let customFields: Record<string, string> = {};
        try {
          customFields = JSON.parse(lead.customFieldsJson || '{}') as Record<string, string>;
        } catch {
          customFields = {};
        }
        const rendered = renderPersonalizedEmail(lead.subject, lead.body, {
          email: lead.email,
          first_name: lead.firstName,
          last_name: lead.lastName,
          company: lead.company,
          website: lead.website,
          phone: lead.phone,
          ...customFields,
        });

        const html = buildEmailPreviewHtml({
          rawBody: rendered.renderedBody,
          isHtmlBody: lead.isHtmlBody || looksLikeHtml(rendered.renderedBody),
          signatureHtml: campaign.outlookAccount.signatureHtml,
          signatureEnabled: campaign.outlookAccount.signatureEnabled,
        });

        return {
          leadId: lead.id,
          recipientEmail: lead.email,
          status: lead.status,
          subject: rendered.renderedSubject,
          htmlPreview: html,
          missingVariables: rendered.missingVariables,
          isValid: rendered.isValid,
        };
      });

      res.json({
        campaignId: campaign.id,
        campaignName: campaign.name,
        outlookEmail: campaign.outlookAccount.email,
        totalLeads: previews.length,
        invalidLeadsCount: previews.filter((p) => !p.isValid).length,
        previews,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/start', async (req, res, next) => {
    try {
      const confirmFirstSend = Boolean(req.body?.confirmFirstSend);
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          outlookAccount: true,
          leads: true,
        },
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      if (campaign.outlookAccount.connectionStatus !== 'CONNECTED') {
        res.status(400).json({ error: 'Cannot start campaign: assigned Outlook account is disconnected or requires reauthorization.' });
        return;
      }

      if (campaign.outlookAccount.minDelayMinutes <= 0 || campaign.outlookAccount.maxDelayMinutes < campaign.outlookAccount.minDelayMinutes) {
        res.status(400).json({ error: 'Cannot start campaign: invalid sending delay configuration.' });
        return;
      }

      const settings = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
      if ((settings?.testMode || campaign.isTestMode) && !settings?.testModeRecipientEmail) {
        res.status(400).json({
          error: 'Test mode is enabled, but no verified test recipient email is configured in Settings.',
        });
        return;
      }

      if (campaign.leads.length === 0) {
        res.status(400).json({ error: 'Cannot start campaign: no leads are assigned to this campaign.' });
        return;
      }

      const maxSize = settings?.maxCampaignSize ?? 5000;
      if (campaign.leads.length > maxSize) {
        res.status(400).json({ error: `Campaign exceeds maximum allowed size (${maxSize}).` });
        return;
      }

      const suppressedRows = await prisma.suppressionEntry.findMany({ select: { email: true } });
      const suppressedSet = new Set(suppressedRows.map((s) => normalizeEmail(s.email)));

      const validEligibleLeads = campaign.leads.filter((lead) => {
        if (!['IMPORTED', 'VALIDATED', 'SCHEDULED'].includes(lead.status)) return false;
        if (lead.unsubscribed || suppressedSet.has(normalizeEmail(lead.email))) return false;
        let customFields: Record<string, string> = {};
        try {
          customFields = JSON.parse(lead.customFieldsJson || '{}') as Record<string, string>;
        } catch {
          customFields = {};
        }
        const check = renderPersonalizedEmail(lead.subject, lead.body, {
          email: lead.email,
          first_name: lead.firstName,
          last_name: lead.lastName,
          company: lead.company,
          website: lead.website,
          phone: lead.phone,
          ...customFields,
        });
        return check.isValid;
      });

      if (validEligibleLeads.length === 0) {
        res.status(400).json({
          error: 'Cannot start campaign: no valid, non-suppressed recipients with complete personalization fields remain.',
        });
        return;
      }

      if (!campaign.confirmedFirstSend && !confirmFirstSend) {
        res.status(400).json({
          error: 'Confirmation before the first email is required before starting this campaign.',
          requiresConfirmation: true,
        });
        return;
      }

      await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: 'ACTIVE',
          confirmedFirstSend: true,
        },
      });

      const enqueued = await sendingEngine.enqueueCampaignLeads(campaign.id);
      await prisma.auditLog.create({
        data: {
          action: 'CAMPAIGN_STARTED',
          entityType: 'Campaign',
          entityId: campaign.id,
          detailsJson: JSON.stringify({ enqueued, isTestMode: campaign.isTestMode }),
          ipAddress: req.ip,
        },
      });

      res.json({ ok: true, status: 'ACTIVE', enqueued });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/pause', async (req, res, next) => {
    try {
      const updated = await prisma.campaign.update({
        where: { id: req.params.id },
        data: { status: 'PAUSED' },
      });
      await prisma.auditLog.create({
        data: { action: 'CAMPAIGN_PAUSED', entityType: 'Campaign', entityId: updated.id, ipAddress: req.ip },
      });
      res.json({ ok: true, status: 'PAUSED' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/resume', async (req, res, next) => {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: { outlookAccount: true },
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      if (campaign.outlookAccount.connectionStatus !== 'CONNECTED') {
        res.status(400).json({ error: 'Cannot resume campaign: assigned Outlook account is disconnected.' });
        return;
      }
      if (campaign.status === 'STOPPED') {
        res.status(400).json({ error: 'Stopped campaigns cannot be resumed; duplicate the campaign to restart.' });
        return;
      }
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'ACTIVE', confirmedFirstSend: true },
      });
      await sendingEngine.enqueueCampaignLeads(campaign.id);
      await prisma.auditLog.create({
        data: { action: 'CAMPAIGN_RESUMED', entityType: 'Campaign', entityId: campaign.id, ipAddress: req.ip },
      });
      res.json({ ok: true, status: 'ACTIVE' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/stop', async (req, res, next) => {
    try {
      const campaignId = req.params.id;
      const [campaign, cancelled] = await prisma.$transaction([
        prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'STOPPED' },
        }),
        prisma.sendingJob.updateMany({
          where: { campaignId, status: 'PENDING' },
          data: { status: 'CANCELLED', lastError: 'Campaign stopped by administrator' },
        }),
        prisma.auditLog.create({
          data: { action: 'CAMPAIGN_STOPPED', entityType: 'Campaign', entityId: campaignId, ipAddress: req.ip },
        }),
      ]);
      res.json({ ok: true, status: campaign.status, cancelledJobs: cancelled.count });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/duplicate', async (req, res, next) => {
    try {
      const source = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: { leads: true },
      });
      if (!source) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      const duplicated = await prisma.$transaction(async (tx) => {
        const created = await tx.campaign.create({
          data: {
            name: `${source.name} (Copy)`,
            outlookAccountId: source.outlookAccountId,
            status: 'DRAFT',
            isTestMode: source.isTestMode,
            useAccountDefaults: source.useAccountDefaults,
            dailyLimit: source.dailyLimit,
            minDelayMinutes: source.minDelayMinutes,
            maxDelayMinutes: source.maxDelayMinutes,
            scheduleStartTime: source.scheduleStartTime,
            scheduleEndTime: source.scheduleEndTime,
            timezone: source.timezone,
            allowedWeekdays: source.allowedWeekdays,
          },
        });

        for (const lead of source.leads) {
          await tx.lead.create({
            data: {
              outlookAccountId: lead.outlookAccountId,
              campaignId: created.id,
              email: lead.email,
              firstName: lead.firstName,
              lastName: lead.lastName,
              company: lead.company,
              website: lead.website,
              phone: lead.phone,
              campaignNameHint: created.name,
              subject: lead.subject,
              body: lead.body,
              isHtmlBody: lead.isHtmlBody,
              customFieldsJson: lead.customFieldsJson,
              status: lead.unsubscribed ? 'UNSUBSCRIBED' : 'VALIDATED',
              unsubscribed: lead.unsubscribed,
            },
          });
        }
        return created;
      });

      res.status(201).json({ campaign: duplicated });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/export', async (req, res, next) => {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          outlookAccount: { select: { email: true } },
          leads: { orderBy: { createdAt: 'asc' } },
          emailMessages: true,
        },
      });
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      const msgByLead = new Map(campaign.emailMessages.map((m) => [m.leadId, m]));
      const csv = generateGenericCsvExport(
        campaign.leads.map((lead) => {
          const msg = msgByLead.get(lead.id);
          return {
            campaign_name: campaign.name,
            outlook_account: campaign.outlookAccount.email,
            recipient_email: lead.email,
            first_name: lead.firstName ?? '',
            last_name: lead.lastName ?? '',
            company: lead.company ?? '',
            subject: lead.subject,
            lead_status: lead.status,
            delivery_status: msg?.deliveryStatus ?? lead.deliveryStatus,
            delivery_source: msg?.deliverySource ?? 'NONE',
            bounce_type: msg?.bounceType ?? lead.bounceType,
            open_count: msg?.openCount ?? lead.openCount,
            click_count: msg?.clickCount ?? lead.clickCount,
            replied: lead.replied,
            sent_at: msg?.sentAt?.toISOString() ?? '',
            error_message: msg?.errorMessage ?? lead.errorMessage ?? '',
          };
        }),
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-report.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
