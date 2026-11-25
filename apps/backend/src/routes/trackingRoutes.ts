import { Router } from 'express';
import { isValidHttpUrl, normalizeEmail } from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from '../config/env.js';
import { hashToken, timingSafeEqualStrings, verifyTrackingToken } from '../crypto/security.js';
import type { InboxSyncService } from '../services/microsoft/inboxSyncService.js';
import { TRANSPARENT_GIF_BUFFER } from '../services/tracking/trackingService.js';

export function createTrackingRoutes(prisma: PrismaClient, config: AppConfig): Router {
  const router = Router();

  // Open tracking 1x1 pixel
  router.get('/o/:tokenFile', async (req, res) => {
    try {
      const token = req.params.tokenFile.replace(/\.gif$/i, '');
      const emailMessageId = verifyTrackingToken(token, 'open', config.trackingSecret);
      if (emailMessageId) {
        const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId } });
        if (msg) {
          const now = new Date();
          await prisma.$transaction(async (tx) => {
            await tx.emailMessage.update({
              where: { id: msg.id },
              data: {
                openCount: { increment: 1 },
                firstOpenedAt: msg.firstOpenedAt ?? now,
                status: ['SENT', 'DELIVERED', 'DELIVERY_UNKNOWN'].includes(msg.status) ? 'OPENED' : msg.status,
              },
            });
            if (msg.leadId) {
              await tx.lead.update({
                where: { id: msg.leadId },
                data: { openCount: { increment: 1 } },
              });
            }
            await tx.emailEvent.create({
              data: {
                emailMessageId: msg.id,
                outlookAccountId: msg.outlookAccountId,
                campaignId: msg.campaignId,
                leadId: msg.leadId,
                eventType: 'OPEN',
                ipAddress: req.ip,
                userAgent: req.get('user-agent')?.slice(0, 200) ?? null,
                occurredAt: now,
              },
            });
          });
        }
      }
    } catch {
      // Always serve the 1x1 transparent GIF cleanly
    }

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(TRANSPARENT_GIF_BUFFER);
  });

  // Click tracking redirect (HMAC-verified + DB destination URL validation — no open redirects!)
  router.get('/c/:signedToken', async (req, res) => {
    try {
      const linkToken = verifyTrackingToken(req.params.signedToken, 'click', config.trackingSecret);
      if (!linkToken) {
        res.status(400).send('Invalid tracking link');
        return;
      }

      const link = await prisma.trackingLink.findUnique({
        where: { token: linkToken },
        include: { emailMessage: true },
      });
      if (!link || !isValidHttpUrl(link.destinationUrl)) {
        res.status(404).send('Tracking link not found or unsafe destination');
        return;
      }

      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.emailMessage.update({
          where: { id: link.emailMessageId },
          data: {
            clickCount: { increment: 1 },
            firstClickedAt: link.emailMessage.firstClickedAt ?? now,
            status: ['SENT', 'DELIVERED', 'DELIVERY_UNKNOWN', 'OPENED'].includes(link.emailMessage.status)
              ? 'CLICKED'
              : link.emailMessage.status,
          },
        });
        if (link.leadId) {
          await tx.lead.update({
            where: { id: link.leadId },
            data: { clickCount: { increment: 1 } },
          });
        }
        await tx.emailEvent.create({
          data: {
            emailMessageId: link.emailMessageId,
            outlookAccountId: link.emailMessage.outlookAccountId,
            campaignId: link.campaignId,
            leadId: link.leadId,
            eventType: 'CLICK',
            metadataJson: JSON.stringify({ destinationUrl: link.destinationUrl }),
            ipAddress: req.ip,
            userAgent: req.get('user-agent')?.slice(0, 200) ?? null,
            occurredAt: now,
          },
        });
      });

      res.redirect(302, link.destinationUrl);
    } catch {
      res.status(400).send('Unable to process link');
    }
  });

  // Unsubscribe confirmation & processing
  const handleUnsubscribe = async (signedToken: string, ip?: string) => {
    const emailMessageId = verifyTrackingToken(signedToken, 'unsub', config.trackingSecret);
    if (!emailMessageId) return null;

    const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId } });
    if (!msg) return null;

    const normalized = normalizeEmail(msg.recipientEmail);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.suppressionEntry.upsert({
        where: { email: normalized },
        create: {
          email: normalized,
          reason: 'UNSUBSCRIBED',
          sourceAccountId: msg.outlookAccountId,
          sourceLeadId: msg.leadId,
          notes: 'Recipient clicked unsubscribe link',
        },
        update: {
          reason: 'UNSUBSCRIBED',
        },
      });

      await tx.lead.updateMany({
        where: { email: normalized },
        data: { unsubscribed: true, status: 'UNSUBSCRIBED' },
      });

      await tx.sendingJob.updateMany({
        where: { recipientEmail: normalized, status: 'PENDING' },
        data: { status: 'CANCELLED', lastError: 'Recipient unsubscribed' },
      });

      await tx.emailEvent.create({
        data: {
          emailMessageId: msg.id,
          outlookAccountId: msg.outlookAccountId,
          campaignId: msg.campaignId,
          leadId: msg.leadId,
          eventType: 'UNSUBSCRIBE',
          ipAddress: ip,
          occurredAt: now,
        },
      });
    });
    return normalized;
  };

  router.get('/u/:signedToken', async (req, res) => {
    const email = await handleUnsubscribe(req.params.signedToken, req.ip);
    if (!email) {
      res.status(400).send('Invalid unsubscribe link.');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;padding:24px;color:#0f172a;">
<h2 style="margin-top:0;">You have been unsubscribed</h2>
<p><strong>${email.replace(/</g, '&lt;')}</strong> has been removed from future outreach emails.</p>
</body></html>`);
  });

  router.post('/u/:signedToken', async (req, res) => {
    const email = await handleUnsubscribe(req.params.signedToken, req.ip);
    if (!email) {
      res.status(400).json({ error: 'Invalid unsubscribe token' });
      return;
    }
    res.json({ ok: true, email });
  });

  return router;
}

export function createWebhookRoutes(
  prisma: PrismaClient,
  config: AppConfig,
  inboxSyncService: InboxSyncService,
): Router {
  const router = Router();

  router.post('/microsoft-graph', async (req, res) => {
    // Handle Graph subscription validation handshake
    if (typeof req.query.validationToken === 'string') {
      res.status(200).type('text/plain').send(req.query.validationToken);
      return;
    }

    const notifications = Array.isArray(req.body?.value) ? req.body.value : [];
    res.status(202).json({ received: notifications.length });

    for (const item of notifications) {
      try {
        const subscriptionId = String(item.subscriptionId || '');
        const clientState = String(item.clientState || '');
        const resourceId = String(item.resourceData?.id || '');
        if (!subscriptionId || !resourceId) continue;

        const account = await prisma.outlookAccount.findFirst({
          where: { graphSubscriptionId: subscriptionId },
        });
        if (!account || !account.graphClientStateHash) continue;

        const expectedHash = hashToken(clientState, config.sessionSecret);
        if (!timingSafeEqualStrings(expectedHash, account.graphClientStateHash)) {
          continue;
        }

        await inboxSyncService.handleWebhookMessageNotification(account.id, resourceId);
      } catch {
        // Webhook background failures are caught and covered by delta fallback polling
      }
    }
  });

  return router;
}
