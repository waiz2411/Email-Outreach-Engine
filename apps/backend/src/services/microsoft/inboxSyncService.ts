import {
  classifyBounceMessage,
  formatWhatsAppNotificationMessage,
  normalizeEmail,
} from '@outreach-engine/shared';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { logger } from '../../utils/logger.js';
import type { GraphMailMessage, MicrosoftGraphClient } from './graphTypes.js';
import { MicrosoftOAuthService } from './oauthService.js';

function getHeaderValue(headers: GraphMailMessage['internetMessageHeaders'], name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === target)?.value;
}

function extractMessageIdsFromHeaders(headers: GraphMailMessage['internetMessageHeaders']): string[] {
  const refs: string[] = [];
  const inReplyTo = getHeaderValue(headers, 'in-reply-to');
  const references = getHeaderValue(headers, 'references');
  for (const val of [inReplyTo, references]) {
    if (!val) continue;
    const matches = val.match(/<[^>]+>/g);
    if (matches) {
      refs.push(...matches);
    } else {
      refs.push(val.trim());
    }
  }
  return Array.from(new Set(refs));
}

export class InboxSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauthService: MicrosoftOAuthService,
    private readonly graphClient: MicrosoftGraphClient,
    private readonly onNotificationQueued?: () => void,
  ) {}

  async syncAccountInbox(accountId: string): Promise<{ processed: number; replies: number; bounces: number }> {
    const account = await this.prisma.outlookAccount.findUnique({ where: { id: accountId } });
    if (!account || account.connectionStatus !== 'CONNECTED') {
      return { processed: 0, replies: 0, bounces: 0 };
    }

    const accessToken = await this.oauthService.getValidAccessToken(accountId);
    const delta = await this.graphClient.fetchInboxDelta(accessToken, account.inboxDeltaLink);

    let processed = 0;
    let replies = 0;
    let bounces = 0;

    for (const msg of delta.value) {
      if (!msg.id || msg.isDraft) continue;
      const result = await this.processIncomingGraphMessage(account, msg);
      if (result.processed) processed++;
      if (result.isReply) replies++;
      if (result.isBounce) bounces++;
    }

    await this.prisma.outlookAccount.update({
      where: { id: accountId },
      data: {
        inboxDeltaLink: delta['@odata.deltaLink'] ?? account.inboxDeltaLink,
        lastInboxSyncAt: new Date(),
      },
    });

    return { processed, replies, bounces };
  }

  async handleWebhookMessageNotification(accountId: string, graphMessageId: string): Promise<void> {
    const account = await this.prisma.outlookAccount.findUnique({ where: { id: accountId } });
    if (!account || account.connectionStatus !== 'CONNECTED') return;

    const accessToken = await this.oauthService.getValidAccessToken(accountId);
    const msg = await this.graphClient.fetchMessageById(accessToken, graphMessageId);
    await this.processIncomingGraphMessage(account, msg);
  }

  async processIncomingGraphMessage(
    account: {
      id: string;
      email: string;
      timezone: string;
      whatsappNotificationsEnabled: boolean;
    },
    msg: GraphMailMessage,
  ): Promise<{ processed: boolean; isReply: boolean; isBounce: boolean }> {
    const existing = await this.prisma.incomingEmail.findUnique({
      where: {
        outlookAccountId_graphMessageId: {
          outlookAccountId: account.id,
          graphMessageId: msg.id,
        },
      },
    });
    if (existing) {
      return { processed: false, isReply: false, isBounce: false };
    }

    const senderEmail = normalizeEmail(
      msg.from?.emailAddress?.address || msg.sender?.emailAddress?.address || '',
    );
    const senderName = msg.from?.emailAddress?.name || msg.sender?.emailAddress?.name || null;

    // Ignore our own messages if synced back into Inbox
    if (!senderEmail || senderEmail === normalizeEmail(account.email)) {
      return { processed: false, isReply: false, isBounce: false };
    }

    const subject = msg.subject || '(No subject)';
    const bodyText = msg.body?.content || msg.bodyPreview || '';
    const receivedAt = msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();
    const headerMessageIds = extractMessageIdsFromHeaders(msg.internetMessageHeaders);
    const inReplyTo = getHeaderValue(msg.internetMessageHeaders, 'in-reply-to') ?? null;

    // 1. Check if this incoming item is a bounce / DSN
    const bounce = classifyBounceMessage({
      senderEmail,
      subject,
      bodyText,
      headers: msg.internetMessageHeaders,
    });

    let matchedEmail = null as Awaited<ReturnType<typeof this.prisma.emailMessage.findFirst>>;
    let isCampaignReply = false;
    let isBounceNdr = false;

    if (bounce.isBounceOrDsn) {
      isBounceNdr = true;
      matchedEmail = await this.findOutboundMatch(account.id, {
        headerMessageIds,
        conversationId: msg.conversationId,
        recipientEmail: bounce.failedRecipient,
      });

      if (matchedEmail) {
        if (bounce.classification === 'DELIVERED_DSN') {
          await this.recordProviderDelivered(matchedEmail.id, matchedEmail.leadId, account.id, matchedEmail.campaignId, receivedAt);
        } else {
          const bounceType = bounce.classification === 'HARD' || bounce.classification === 'SOFT' ? bounce.classification : 'UNKNOWN';
          await this.recordBounce(matchedEmail, bounceType, bounce.reason || 'Bounce reported by provider', receivedAt);
        }
      }
    } else {
      // 2. Check if this incoming email is a reply to an outreach email (even after campaign completion)
      if (headerMessageIds.length > 0) {
        matchedEmail = await this.prisma.emailMessage.findFirst({
          where: {
            outlookAccountId: account.id,
            internetMessageId: { in: headerMessageIds },
          },
          orderBy: { sentAt: 'desc' },
        });
      }

      if (!matchedEmail && msg.conversationId) {
        matchedEmail = await this.prisma.emailMessage.findFirst({
          where: {
            outlookAccountId: account.id,
            conversationId: msg.conversationId,
            recipientEmail: senderEmail,
          },
          orderBy: { sentAt: 'desc' },
        });
      }

      if (matchedEmail) {
        isCampaignReply = true;
        await this.recordReply(matchedEmail, receivedAt);
      }
    }

    const incomingRecord = await this.prisma.incomingEmail.create({
      data: {
        outlookAccountId: account.id,
        graphMessageId: msg.id,
        internetMessageId: msg.internetMessageId ?? null,
        conversationId: msg.conversationId ?? null,
        inReplyTo,
        senderName,
        senderEmail,
        subject,
        bodyPreview: (msg.bodyPreview || '').slice(0, 300) || null,
        receivedAt,
        isBounceNdr,
        isCampaignReply,
        matchedCampaignId: matchedEmail?.campaignId ?? null,
        matchedLeadId: matchedEmail?.leadId ?? null,
        matchedEmailMessageId: matchedEmail?.id ?? null,
      },
    });

    await this.prisma.outlookAccount.update({
      where: { id: account.id },
      data: { lastActivityAt: receivedAt },
    });

    // 3. Queue WhatsApp notification for incoming emails and replies (never for system bounces)
    if (!isBounceNdr && account.whatsappNotificationsEnabled) {
      await this.queueIncomingWhatsAppAlert({
        account,
        incomingEmailId: incomingRecord.id,
        graphMessageId: msg.id,
        senderName,
        senderEmail,
        subject,
        bodyPreview: msg.bodyPreview ?? null,
        receivedAt,
        isCampaignReply,
        campaignId: matchedEmail?.campaignId ?? null,
      });
    }

    return {
      processed: true,
      isReply: isCampaignReply,
      isBounce: isBounceNdr && bounce.classification !== 'DELIVERED_DSN',
    };
  }

  private async findOutboundMatch(
    accountId: string,
    opts: { headerMessageIds: string[]; conversationId?: string; recipientEmail?: string },
  ) {
    if (opts.headerMessageIds.length > 0) {
      const byHeader = await this.prisma.emailMessage.findFirst({
        where: {
          outlookAccountId: accountId,
          internetMessageId: { in: opts.headerMessageIds },
        },
        orderBy: { sentAt: 'desc' },
      });
      if (byHeader) return byHeader;
    }

    if (opts.conversationId) {
      const byConv = await this.prisma.emailMessage.findFirst({
        where: {
          outlookAccountId: accountId,
          conversationId: opts.conversationId,
        },
        orderBy: { sentAt: 'desc' },
      });
      if (byConv) return byConv;
    }

    if (opts.recipientEmail) {
      return this.prisma.emailMessage.findFirst({
        where: {
          outlookAccountId: accountId,
          recipientEmail: normalizeEmail(opts.recipientEmail),
        },
        orderBy: { sentAt: 'desc' },
      });
    }

    return null;
  }

  private async recordProviderDelivered(
    emailMessageId: string,
    leadId: string | null,
    outlookAccountId: string,
    campaignId: string | null,
    deliveredAt: Date,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.emailMessage.update({
        where: { id: emailMessageId },
        data: {
          status: 'DELIVERED',
          deliveryStatus: 'CONFIRMED_DELIVERED',
          deliverySource: 'PROVIDER_CONFIRMED',
          deliveredAt,
        },
      });
      if (leadId) {
        await tx.lead.update({
          where: { id: leadId },
          data: {
            status: 'DELIVERED',
            deliveryStatus: 'DELIVERED',
          },
        });
      }
      await tx.emailEvent.create({
        data: {
          emailMessageId,
          outlookAccountId,
          campaignId,
          leadId,
          eventType: 'DELIVERED',
          occurredAt: deliveredAt,
        },
      });
    });
  }

  private async recordBounce(
    emailMessage: { id: string; outlookAccountId: string; campaignId: string | null; leadId: string | null; recipientEmail: string },
    bounceType: 'HARD' | 'SOFT' | 'UNKNOWN',
    reason: string,
    bouncedAt: Date,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.emailMessage.update({
        where: { id: emailMessage.id },
        data: {
          status: 'BOUNCED',
          deliveryStatus: 'BOUNCED',
          bounceType,
          bounceReason: reason,
          bouncedAt,
        },
      });

      if (emailMessage.leadId) {
        await tx.lead.update({
          where: { id: emailMessage.leadId },
          data: {
            status: bounceType === 'HARD' ? 'SUPPRESSED' : 'BOUNCED',
            deliveryStatus: 'BOUNCED',
            bounceType,
            errorMessage: reason,
          },
        });
      }

      if (bounceType === 'HARD') {
        await tx.suppressionEntry.upsert({
          where: { email: normalizeEmail(emailMessage.recipientEmail) },
          create: {
            email: normalizeEmail(emailMessage.recipientEmail),
            reason: 'HARD_BOUNCE',
            sourceAccountId: emailMessage.outlookAccountId,
            sourceLeadId: emailMessage.leadId,
            notes: reason,
          },
          update: {
            reason: 'HARD_BOUNCE',
            notes: reason,
          },
        });

        await tx.sendingJob.updateMany({
          where: {
            recipientEmail: normalizeEmail(emailMessage.recipientEmail),
            status: 'PENDING',
          },
          data: {
            status: 'CANCELLED',
            lastError: 'Suppressed after hard bounce',
          },
        });
      }

      await tx.emailEvent.create({
        data: {
          emailMessageId: emailMessage.id,
          outlookAccountId: emailMessage.outlookAccountId,
          campaignId: emailMessage.campaignId,
          leadId: emailMessage.leadId,
          eventType: bounceType === 'HARD' ? 'HARD_BOUNCE' : bounceType === 'SOFT' ? 'SOFT_BOUNCE' : 'UNKNOWN_BOUNCE',
          metadataJson: JSON.stringify({ reason }),
          occurredAt: bouncedAt,
        },
      });
    });
  }

  private async recordReply(
    emailMessage: { id: string; outlookAccountId: string; campaignId: string | null; leadId: string | null; deliveryStatus: string },
    repliedAt: Date,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.emailMessage.update({
        where: { id: emailMessage.id },
        data: {
          status: 'REPLIED',
          repliedAt,
          ...(emailMessage.deliveryStatus !== 'CONFIRMED_DELIVERED'
            ? {
                deliveryStatus: 'CONFIRMED_DELIVERED',
                deliverySource: 'PROVIDER_CONFIRMED',
                deliveredAt: repliedAt,
              }
            : {}),
        },
      });

      if (emailMessage.leadId) {
        await tx.lead.update({
          where: { id: emailMessage.leadId },
          data: {
            status: 'REPLIED',
            replied: true,
            lastReplyAt: repliedAt,
            deliveryStatus: 'DELIVERED',
          },
        });

        await tx.sendingJob.updateMany({
          where: {
            leadId: emailMessage.leadId,
            status: 'PENDING',
          },
          data: {
            status: 'CANCELLED',
            lastError: 'Lead replied',
          },
        });
      }

      await tx.emailEvent.create({
        data: {
          emailMessageId: emailMessage.id,
          outlookAccountId: emailMessage.outlookAccountId,
          campaignId: emailMessage.campaignId,
          leadId: emailMessage.leadId,
          eventType: 'REPLY',
          occurredAt: repliedAt,
        },
      });
    });
  }

  private async queueIncomingWhatsAppAlert(params: {
    account: { id: string; email: string; timezone: string };
    incomingEmailId: string;
    graphMessageId: string;
    senderName: string | null;
    senderEmail: string;
    subject: string;
    bodyPreview: string | null;
    receivedAt: Date;
    isCampaignReply: boolean;
    campaignId: string | null;
  }) {
    const waConfig = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (!waConfig?.recipientPhoneNumber) return;
    if (params.isCampaignReply && !waConfig.notifyReply) return;
    if (!params.isCampaignReply && !waConfig.notifyNewEmail) return;

    let campaignName: string | null = null;
    if (params.campaignId) {
      const camp = await this.prisma.campaign.findUnique({
        where: { id: params.campaignId },
        select: { name: true },
      });
      campaignName = camp?.name ?? null;
    }

    const eventType = params.isCampaignReply ? 'OUTREACH_REPLY' : 'NEW_EMAIL';
    const messageText = formatWhatsAppNotificationMessage({
      eventType,
      outlookEmail: params.account.email,
      senderName: params.senderName,
      senderEmail: params.senderEmail,
      subject: params.subject,
      campaignName,
      receivedAt: params.receivedAt,
      timezone: params.account.timezone,
      bodyPreview: params.bodyPreview,
      includeBodyPreview: waConfig.includeBodyPreview,
    });

    const dedupeKey = `incoming:${params.account.id}:${params.graphMessageId}`;
    try {
      await this.prisma.whatsAppNotificationJob.create({
        data: {
          dedupeKey,
          eventType,
          outlookAccountId: params.account.id,
          incomingEmailId: params.incomingEmailId,
          recipientPhone: waConfig.recipientPhoneNumber,
          messageText,
          status: 'PENDING',
        },
      });
      this.onNotificationQueued?.();
    } catch (err) {
      // Unique dedupeKey violation prevents duplicate notifications safely
      logger.warn('Skipped duplicate WhatsApp notification alert', { dedupeKey, err });
    }
  }
}
