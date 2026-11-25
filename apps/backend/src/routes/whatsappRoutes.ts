import { Router } from 'express';
import { z } from 'zod';
import { internationalPhoneSchema } from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

export interface WhatsAppPublicState {
  connectionStatus: string;
  linkedPhoneNumber: string | null;
  recipientPhoneNumber: string | null;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  qrExpired: boolean;
  hasStoredSession: boolean;
  lastConnectedAt: Date | null;
  lastNotificationAt: Date | null;
  lastError: string | null;
  includeBodyPreview: boolean;
  notifyNewEmail: boolean;
  notifyReply: boolean;
  notifyCampaignComplete: boolean;
  notifySendError: boolean;
  notifyWhatsAppError: boolean;
}

export interface WhatsAppManagerPort {
  getState(): Promise<WhatsAppPublicState>;
  connect(): Promise<WhatsAppPublicState>;
  refreshQr(): Promise<WhatsAppPublicState>;
  disconnect(): Promise<WhatsAppPublicState>;
  deleteStoredSession(): Promise<WhatsAppPublicState>;
  sendTestNotification(): Promise<{ jobId: string; status: string; providerMessageId?: string | null }>;
  retryNotification(jobId: string): Promise<{ ok: boolean; status: string }>;
}

export function createWhatsAppRoutes(
  prisma: PrismaClient,
  waManager: WhatsAppManagerPort,
): Router {
  const router = Router();

  router.get('/status', async (_req, res, next) => {
    try {
      const state = await waManager.getState();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/connect', async (req, res, next) => {
    try {
      const state = await waManager.connect();
      await prisma.auditLog.create({
        data: { action: 'WHATSAPP_CONNECT_INITIATED', entityType: 'WhatsApp', ipAddress: req.ip },
      });
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh-qr', async (_req, res, next) => {
    try {
      const state = await waManager.refreshQr();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/disconnect', async (req, res, next) => {
    try {
      const state = await waManager.disconnect();
      await prisma.auditLog.create({
        data: { action: 'WHATSAPP_DISCONNECTED', entityType: 'WhatsApp', ipAddress: req.ip },
      });
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/session', async (req, res, next) => {
    try {
      const state = await waManager.deleteStoredSession();
      await prisma.auditLog.create({
        data: { action: 'WHATSAPP_SESSION_DELETED', entityType: 'WhatsApp', ipAddress: req.ip },
      });
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/settings', async (req, res, next) => {
    try {
      const schema = z.object({
        recipientPhoneNumber: internationalPhoneSchema.nullable().optional(),
        includeBodyPreview: z.boolean().optional(),
        notifyNewEmail: z.boolean().optional(),
        notifyReply: z.boolean().optional(),
        notifyCampaignComplete: z.boolean().optional(),
        notifySendError: z.boolean().optional(),
        notifyWhatsAppError: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid WhatsApp settings' });
        return;
      }

      await prisma.whatsAppConfig.upsert({
        where: { id: 'default' },
        create: { id: 'default', ...parsed.data },
        update: parsed.data,
      });

      const state = await waManager.getState();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/test', async (req, res, next) => {
    try {
      const result = await waManager.sendTestNotification();
      await prisma.auditLog.create({
        data: {
          action: 'WHATSAPP_TEST_SENT',
          entityType: 'WhatsAppNotificationJob',
          entityId: result.jobId,
          ipAddress: req.ip,
        },
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not connected')) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes('recipient')) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get('/notifications', async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const notifications = await prisma.whatsAppNotificationJob.findMany({
        where: status ? { status } : undefined,
        include: {
          outlookAccount: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json({ notifications });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/:id/retry', async (req, res, next) => {
    try {
      const result = await waManager.retryNotification(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes('not connected')) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
