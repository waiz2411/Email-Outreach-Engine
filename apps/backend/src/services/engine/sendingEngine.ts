import {
  computeNextEligibleSendAt,
  computeRetryBackoffMs,
  getLocalTimeParts,
  isWithinSendingSchedule,
  looksLikeHtml,
  normalizeEmail,
  renderPersonalizedEmail,
  formatWhatsAppNotificationMessage,
} from '@outreach-engine/shared';
import type Database from 'better-sqlite3';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.js';
import { generateRandomToken } from '../../crypto/security.js';
import { logger } from '../../utils/logger.js';
import { stripHtmlToPlainText } from '../../utils/sanitizer.js';
import { GraphApiError, type MicrosoftGraphClient } from '../microsoft/graphTypes.js';
import { MicrosoftOAuthService, OAuthFlowError } from '../microsoft/oauthService.js';
import { prepareTrackedOutboundHtml } from '../tracking/trackingService.js';

export class SendingEngine {
  private timer: NodeJS.Timeout | null = null;
  private isTickRunning = false;
  private readonly workerId = `worker-${process.pid}-${generateRandomToken(4)}`;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sqlite: Database.Database,
    private readonly config: AppConfig,
    private readonly oauthService: MicrosoftOAuthService,
    private readonly graphClient: MicrosoftGraphClient,
    private readonly onWhatsAppNotificationQueued?: () => void,
    private readonly randomFn: () => number = Math.random,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => logger.error('Sending engine tick error', { err }));
    }, this.config.sendingEnginePollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Moves any jobs left in PROCESSING during an unexpected restart to UNCERTAIN so they are never blindly resent.
   */
  async recoverInterruptedJobs(): Promise<number> {
    const res = await this.prisma.sendingJob.updateMany({
      where: { status: 'PROCESSING' },
      data: {
        status: 'UNCERTAIN',
        lockedAt: null,
        lockedBy: null,
        lastError: 'Application restarted while send was in progress; reconcile before retrying.',
      },
    });
    if (res.count > 0) {
      logger.warn('Recovered interrupted sending jobs into UNCERTAIN state', { count: res.count });
    }
    return res.count;
  }

  /**
   * Ensures every eligible lead in an active campaign has a persistent SendingJob record.
   */
  async enqueueCampaignLeads(campaignId: string): Promise<number> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { outlookAccount: true },
    });
    if (!campaign) return 0;

    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    const maxRetries = settings?.maxSendRetries ?? 3;

    const eligibleLeads = await this.prisma.lead.findMany({
      where: {
        campaignId,
        outlookAccountId: campaign.outlookAccountId,
        status: { in: ['IMPORTED', 'VALIDATED', 'SCHEDULED'] },
        unsubscribed: false,
      },
      orderBy: { createdAt: 'asc' },
    });

    let createdCount = 0;
    for (const lead of eligibleLeads) {
      const idempotencyKey = `${campaign.id}:${lead.id}`;
      const existing = await this.prisma.sendingJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) continue;

      await this.prisma.$transaction(async (tx) => {
        await tx.sendingJob.create({
          data: {
            campaignId: campaign.id,
            leadId: lead.id,
            outlookAccountId: campaign.outlookAccountId,
            recipientEmail: normalizeEmail(lead.email),
            idempotencyKey,
            status: 'PENDING',
            scheduledFor: new Date(),
            maxAttempts: maxRetries,
          },
        });
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'SCHEDULED' },
        });
      });
      createdCount++;
    }
    return createdCount;
  }

  /**
   * Executes one scheduler pass across active campaigns. Safe against overlapping runs.
   */
  async tick(now: Date = new Date()): Promise<{ dispatched: number }> {
    if (this.isTickRunning) return { dispatched: 0 };
    this.isTickRunning = true;

    let dispatched = 0;
    try {
      const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
      if (settings?.globalPaused) {
        return { dispatched: 0 };
      }

      const activeCampaigns = await this.prisma.campaign.findMany({
        where: {
          status: 'ACTIVE',
          confirmedFirstSend: true,
        },
        include: {
          outlookAccount: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      const processedAccountsThisTick = new Set<string>();

      for (const campaign of activeCampaigns) {
        const account = campaign.outlookAccount;
        if (processedAccountsThisTick.has(account.id)) continue;
        if (account.connectionStatus !== 'CONNECTED' || account.isPaused) continue;

        // Check pacing delay persisted on account
        if (account.nextEligibleSendAt && account.nextEligibleSendAt > now) {
          continue;
        }

        const scheduleConfig = this.resolveEffectiveSchedule(account, campaign);
        const scheduleCheck = isWithinSendingSchedule(
          now,
          scheduleConfig,
          campaign.startDate,
          campaign.endDate,
        );
        if (!scheduleCheck.allowed) {
          continue;
        }

        // Check if campaign already has no pending/processing/uncertain jobs left
        const nextJob = await this.prisma.sendingJob.findFirst({
          where: {
            campaignId: campaign.id,
            status: 'PENDING',
            scheduledFor: { lte: now },
          },
          orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        });

        if (!nextJob) {
          await this.checkAndCompleteCampaign(campaign.id);
          continue;
        }

        processedAccountsThisTick.add(account.id);
        const didDispatch = await this.processSingleJob(nextJob.id, now, settings);
        if (didDispatch) {
          dispatched++;
        }
      }

      return { dispatched };
    } finally {
      this.isTickRunning = false;
    }
  }

  private resolveEffectiveSchedule(
    account: {
      dailySendLimit: number;
      minDelayMinutes: number;
      maxDelayMinutes: number;
      scheduleStartTime: string;
      scheduleEndTime: string;
      timezone: string;
      allowedWeekdays: string;
    },
    campaign: {
      useAccountDefaults: boolean;
      dailyLimit: number | null;
      minDelayMinutes: number | null;
      maxDelayMinutes: number | null;
      scheduleStartTime: string | null;
      scheduleEndTime: string | null;
      timezone: string | null;
      allowedWeekdays: string | null;
    },
  ) {
    const parseWeekdays = (raw: string | null | undefined): number[] => {
      try {
        const arr = JSON.parse(raw || '[1,2,3,4,5]');
        return Array.isArray(arr) ? arr.map(Number) : [1, 2, 3, 4, 5];
      } catch {
        return [1, 2, 3, 4, 5];
      }
    };

    if (campaign.useAccountDefaults) {
      return {
        dailyLimit: account.dailySendLimit,
        minDelayMinutes: account.minDelayMinutes,
        maxDelayMinutes: account.maxDelayMinutes,
        scheduleStartTime: account.scheduleStartTime,
        scheduleEndTime: account.scheduleEndTime,
        timezone: account.timezone,
        allowedWeekdays: parseWeekdays(account.allowedWeekdays),
      };
    }

    return {
      dailyLimit: Math.min(account.dailySendLimit, campaign.dailyLimit ?? account.dailySendLimit),
      minDelayMinutes: Math.max(account.minDelayMinutes, campaign.minDelayMinutes ?? account.minDelayMinutes),
      maxDelayMinutes: Math.max(
        account.minDelayMinutes,
        campaign.maxDelayMinutes ?? account.maxDelayMinutes,
      ),
      scheduleStartTime: campaign.scheduleStartTime ?? account.scheduleStartTime,
      scheduleEndTime: campaign.scheduleEndTime ?? account.scheduleEndTime,
      timezone: campaign.timezone ?? account.timezone,
      allowedWeekdays: campaign.allowedWeekdays
        ? parseWeekdays(campaign.allowedWeekdays)
        : parseWeekdays(account.allowedWeekdays),
    };
  }

  /**
   * Atomically reserves a daily quota slot inside a SQLite BEGIN IMMEDIATE transaction so
   * concurrent triggers can never exceed the account's configured daily limit.
   */
  public reserveDailyQuotaSlot(accountId: string, dateKey: string, maxDailyLimit: number): boolean {
    const tx = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare('SELECT id, sentCount FROM AccountDailyCounter WHERE outlookAccountId = ? AND dateKey = ?')
        .get(accountId, dateKey) as { id: string; sentCount: number } | undefined;

      if (!existing) {
        if (maxDailyLimit <= 0) return false;
        const id = generateRandomToken(12);
        this.sqlite
          .prepare(
            'INSERT INTO AccountDailyCounter (id, outlookAccountId, dateKey, sentCount, updatedAt) VALUES (?, ?, ?, 1, ?)',
          )
          .run(id, accountId, dateKey, new Date().toISOString());
        return true;
      }

      if (existing.sentCount >= maxDailyLimit) {
        return false;
      }

      this.sqlite
        .prepare('UPDATE AccountDailyCounter SET sentCount = sentCount + 1, updatedAt = ? WHERE id = ?')
        .run(new Date().toISOString(), existing.id);
      return true;
    });

    return tx.immediate();
  }

  public releaseDailyQuotaSlot(accountId: string, dateKey: string): void {
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          'UPDATE AccountDailyCounter SET sentCount = MAX(0, sentCount - 1), updatedAt = ? WHERE outlookAccountId = ? AND dateKey = ?',
        )
        .run(new Date().toISOString(), accountId, dateKey);
    });
    tx.immediate();
  }

  /**
   * Atomically claims a PENDING SendingJob using SQLite immediate locking.
   */
  private claimJobAtomically(jobId: string): boolean {
    const tx = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE SendingJob
           SET status = 'PROCESSING', attempts = attempts + 1, lockedAt = ?, lockedBy = ?, updatedAt = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(new Date().toISOString(), this.workerId, new Date().toISOString(), jobId);
      return result.changes === 1;
    });
    return tx.immediate();
  }

  async processSingleJob(
    jobId: string,
    now: Date = new Date(),
    preloadedSettings?: Awaited<ReturnType<PrismaClient['systemSettings']['findUnique']>>,
  ): Promise<boolean> {
    const job = await this.prisma.sendingJob.findUnique({
      where: { id: jobId },
      include: {
        campaign: true,
        lead: true,
        outlookAccount: true,
      },
    });
    if (!job || job.status !== 'PENDING') return false;
    if (job.campaign.status !== 'ACTIVE' || job.outlookAccount.connectionStatus !== 'CONNECTED' || job.outlookAccount.isPaused) {
      return false;
    }

    const settings =
      preloadedSettings ?? (await this.prisma.systemSettings.findUnique({ where: { id: 'default' } }));
    if (settings?.globalPaused) return false;

    const isTestMode = Boolean(settings?.testMode || job.campaign.isTestMode);
    const targetRecipient = isTestMode
      ? normalizeEmail(settings?.testModeRecipientEmail || '')
      : normalizeEmail(job.lead.email);

    if (isTestMode && (!targetRecipient || !targetRecipient.includes('@'))) {
      await this.failJobPermanently(
        job.id,
        job.leadId,
        job.outlookAccountId,
        job.campaignId,
        'Test mode is enabled, but no verified test recipient email is configured in Settings.',
        false,
      );
      return false;
    }

    // 1. Check suppression, unsubscribe, and duplicate campaign send before reserving quota
    if (!isTestMode) {
      if (job.lead.unsubscribed || job.lead.status === 'UNSUBSCRIBED' || job.lead.status === 'SUPPRESSED') {
        await this.cancelJob(job.id, 'Lead is unsubscribed or suppressed');
        return false;
      }

      const suppressed = await this.prisma.suppressionEntry.findUnique({
        where: { email: targetRecipient },
      });
      if (suppressed) {
        await this.prisma.$transaction([
          this.prisma.lead.update({
            where: { id: job.leadId },
            data: { status: 'SUPPRESSED', errorMessage: `Suppressed (${suppressed.reason})` },
          }),
          this.prisma.sendingJob.update({
            where: { id: job.id },
            data: { status: 'CANCELLED', lastError: `Recipient is in suppression list (${suppressed.reason})` },
          }),
        ]);
        return false;
      }

      const alreadySent = await this.prisma.emailMessage.findFirst({
        where: {
          campaignId: job.campaignId,
          recipientEmail: targetRecipient,
          isTestEmail: false,
          status: { notIn: ['FAILED', 'QUEUED'] },
        },
      });
      if (alreadySent) {
        await this.cancelJob(job.id, 'Duplicate campaign recipient prevented');
        return false;
      }
    }

    // 2. Render & validate personalization
    let customFields: Record<string, string> = {};
    try {
      customFields = JSON.parse(job.lead.customFieldsJson || '{}') as Record<string, string>;
    } catch {
      customFields = {};
    }

    const personalized = renderPersonalizedEmail(job.lead.subject, job.lead.body, {
      email: job.lead.email,
      first_name: job.lead.firstName,
      last_name: job.lead.lastName,
      company: job.lead.company,
      website: job.lead.website,
      phone: job.lead.phone,
      ...customFields,
    });

    if (!personalized.isValid) {
      const errMsg =
        personalized.missingVariables.length > 0
          ? `Missing personalization variable(s): ${personalized.missingVariables.join(', ')}`
          : 'Subject or body is empty after personalization';
      await this.failJobPermanently(job.id, job.leadId, job.outlookAccountId, job.campaignId, errMsg, false);
      return false;
    }

    // 3. Enforce daily sending limit atomically BEFORE claiming or sending
    const scheduleConfig = this.resolveEffectiveSchedule(job.outlookAccount, job.campaign);
    const localParts = getLocalTimeParts(now, scheduleConfig.timezone);
    const quotaReserved = this.reserveDailyQuotaSlot(
      job.outlookAccountId,
      localParts.dateKey,
      scheduleConfig.dailyLimit,
    );
    if (!quotaReserved) {
      return false;
    }

    // 4. Atomically claim job
    const claimed = this.claimJobAtomically(job.id);
    if (!claimed) {
      this.releaseDailyQuotaSlot(job.outlookAccountId, localParts.dateKey);
      return false;
    }

    const correlationId = `oe-${generateRandomToken(16)}`;
    let draftCreated = false;
    let emailMessageId = '';

    try {
      const emailMessage = await this.prisma.$transaction(async (tx) => {
        const created = await tx.emailMessage.create({
          data: {
            sendingJobId: job.id,
            outlookAccountId: job.outlookAccountId,
            campaignId: job.campaignId,
            leadId: job.leadId,
            recipientEmail: targetRecipient,
            subject: isTestMode ? `[TEST] ${personalized.renderedSubject}` : personalized.renderedSubject,
            renderedBodyPreview: stripHtmlToPlainText(personalized.renderedBody).slice(0, 280),
            isTestEmail: isTestMode,
            status: 'SENDING',
            deliveryStatus: 'SENDING',
            correlationId,
          },
        });
        await tx.lead.update({
          where: { id: job.leadId },
          data: {
            status: isTestMode ? job.lead.status : 'SENDING',
            lastAttemptedAt: now,
          },
        });
        await tx.emailEvent.create({
          data: {
            emailMessageId: created.id,
            outlookAccountId: job.outlookAccountId,
            campaignId: job.campaignId,
            leadId: job.leadId,
            eventType: 'SENDING',
            occurredAt: now,
          },
        });
        return created;
      });
      emailMessageId = emailMessage.id;

      const accessToken = await this.oauthService.getValidAccessToken(job.outlookAccountId);
      const baseUrl = (settings?.publicBaseUrl || this.config.appBaseUrl).replace(/\/+$/, '');

      const { html, unsubscribeUrl } = await prepareTrackedOutboundHtml({
        db: this.prisma,
        emailMessageId: emailMessage.id,
        leadId: isTestMode ? null : job.leadId,
        campaignId: job.campaignId,
        rawBody: personalized.renderedBody,
        isHtmlBody: job.lead.isHtmlBody || looksLikeHtml(personalized.renderedBody),
        signatureHtml: job.outlookAccount.signatureHtml,
        signatureEnabled: job.outlookAccount.signatureEnabled,
        openTrackingEnabled: Boolean(settings?.openTrackingEnabled ?? true) && !isTestMode,
        clickTrackingEnabled: Boolean(settings?.clickTrackingEnabled ?? true) && !isTestMode,
        unsubscribeFooterEnabled: Boolean(settings?.unsubscribeFooterEnabled ?? true) && !isTestMode,
        baseUrl,
        trackingSecret: this.config.trackingSecret,
      });

      // Step A: Create draft in Outlook and save identifiers BEFORE sending
      const draft = await this.graphClient.createDraft(accessToken, {
        subject: emailMessage.subject,
        htmlBody: html,
        toEmail: targetRecipient,
        correlationId,
        unsubscribeUrl,
      });
      draftCreated = true;

      await this.prisma.emailMessage.update({
        where: { id: emailMessage.id },
        data: {
          graphDraftId: draft.id,
          graphMessageId: draft.id,
          internetMessageId: draft.internetMessageId ?? null,
          conversationId: draft.conversationId ?? null,
        },
      });

      // Step B: Send the draft (if network/timeout happens here, transition to UNCERTAIN rather than blindly retrying)
      let sendResp: { statusCode: number };
      try {
        sendResp = await this.graphClient.sendDraft(accessToken, draft.id);
      } catch (sendErr) {
        // Explicit Graph 4xx/429 before send execution means it wasn't accepted; ambiguous network/5xx/timeout enters UNCERTAIN
        if (sendErr instanceof GraphApiError && sendErr.statusCode < 500) {
          throw sendErr;
        }
        await this.markJobUncertain(
          job.id,
          emailMessage.id,
          sendErr instanceof Error ? sendErr.message : 'Ambiguous network response during send',
        );
        return false;
      }

      const sentAt = new Date();
      const { nextEligibleAt } = computeNextEligibleSendAt(
        sentAt,
        scheduleConfig.minDelayMinutes,
        scheduleConfig.maxDelayMinutes,
        this.randomFn,
      );

      await this.prisma.$transaction(async (tx) => {
        await tx.sendingJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
        await tx.emailMessage.update({
          where: { id: emailMessage.id },
          data: {
            status: 'SENT',
            deliveryStatus: 'DELIVERY_UNKNOWN', // Honest default: Graph 202 queues send, does not confirm recipient inbox delivery
            deliverySource: 'NONE',
            providerResponseCode: sendResp.statusCode,
            providerResponseText: 'Accepted by Microsoft Graph for delivery',
            sentAt,
          },
        });
        if (!isTestMode) {
          await tx.lead.update({
            where: { id: job.leadId },
            data: {
              status: 'SENT',
              deliveryStatus: 'DELIVERY_UNKNOWN',
              lastSentAt: sentAt,
              errorMessage: null,
            },
          });
        } else {
          await tx.lead.update({
            where: { id: job.leadId },
            data: {
              status: 'VALIDATED',
              lastSentAt: sentAt,
            },
          });
        }
        await tx.outlookAccount.update({
          where: { id: job.outlookAccountId },
          data: {
            nextEligibleSendAt: nextEligibleAt,
            lastActivityAt: sentAt,
          },
        });
        await tx.emailEvent.create({
          data: {
            emailMessageId: emailMessage.id,
            outlookAccountId: job.outlookAccountId,
            campaignId: job.campaignId,
            leadId: job.leadId,
            eventType: 'SENT',
            metadataJson: JSON.stringify({ isTestMode, statusCode: sendResp.statusCode }),
            occurredAt: sentAt,
          },
        });
      });

      await this.checkAndCompleteCampaign(job.campaignId);
      return true;
    } catch (err) {
      if (!draftCreated) {
        this.releaseDailyQuotaSlot(job.outlookAccountId, localParts.dateKey);
      }
      await this.handleSendException(job, emailMessageId, err);
      return false;
    }
  }

  private async markJobUncertain(jobId: string, emailMessageId: string, errorMessage: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.sendingJob.update({
        where: { id: jobId },
        data: {
          status: 'UNCERTAIN',
          lockedAt: null,
          lockedBy: null,
          lastError: errorMessage,
        },
      }),
      this.prisma.emailMessage.update({
        where: { id: emailMessageId },
        data: {
          errorMessage: `Uncertain delivery attempt: ${errorMessage}`,
        },
      }),
      this.prisma.emailEvent.create({
        data: {
          emailMessageId,
          outlookAccountId: (await this.prisma.sendingJob.findUniqueOrThrow({ where: { id: jobId } })).outlookAccountId,
          eventType: 'UNCERTAIN',
          metadataJson: JSON.stringify({ errorMessage }),
        },
      }),
    ]);
  }

  /**
   * Safely reconciles an UNCERTAIN sending job by checking Outlook SentItems vs Drafts.
   */
  async reconcileUncertainJob(jobId: string): Promise<{ outcome: 'CONFIRMED_SENT' | 'REQUEUED_DRAFT' | 'STILL_UNCERTAIN' }> {
    const job = await this.prisma.sendingJob.findUnique({
      where: { id: jobId },
      include: { emailMessage: true },
    });
    if (!job || job.status !== 'UNCERTAIN' || !job.emailMessage) {
      return { outcome: 'STILL_UNCERTAIN' };
    }

    const accessToken = await this.oauthService.getValidAccessToken(job.outlookAccountId);
    const lookup = await this.graphClient.findSentByCorrelationOrMessageId(accessToken, {
      internetMessageId: job.emailMessage.internetMessageId,
      conversationId: job.emailMessage.conversationId,
      draftId: job.emailMessage.graphDraftId,
    });

    if (lookup.state === 'SENT') {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.sendingJob.update({
          where: { id: job.id },
          data: { status: 'COMPLETED', lastError: null },
        }),
        this.prisma.emailMessage.update({
          where: { id: job.emailMessage.id },
          data: {
            status: 'SENT',
            deliveryStatus: 'DELIVERY_UNKNOWN',
            graphMessageId: lookup.graphMessageId ?? job.emailMessage.graphMessageId,
            sentAt: now,
            errorMessage: null,
          },
        }),
        this.prisma.lead.update({
          where: { id: job.leadId },
          data: {
            status: 'SENT',
            deliveryStatus: 'DELIVERY_UNKNOWN',
            lastSentAt: now,
            errorMessage: null,
          },
        }),
      ]);
      return { outcome: 'CONFIRMED_SENT' };
    }

    if (lookup.state === 'DRAFT_ONLY') {
      // Confirmed NOT sent! Delete stale EmailMessage record and requeue cleanly.
      await this.prisma.$transaction([
        this.prisma.emailMessage.delete({ where: { id: job.emailMessage.id } }),
        this.prisma.sendingJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            scheduledFor: new Date(),
            lastError: 'Reconciled as unsent draft; safely requeued.',
          },
        }),
        this.prisma.lead.update({
          where: { id: job.leadId },
          data: { status: 'SCHEDULED' },
        }),
      ]);
      return { outcome: 'REQUEUED_DRAFT' };
    }

    return { outcome: 'STILL_UNCERTAIN' };
  }

  private async handleSendException(
    job: { id: string; leadId: string; outlookAccountId: string; campaignId: string; attempts: number; maxAttempts: number },
    emailMessageId: string,
    err: unknown,
  ): Promise<void> {
    const currentJob = await this.prisma.sendingJob.findUnique({ where: { id: job.id } });
    const attempts = currentJob?.attempts ?? job.attempts + 1;
    const maxAttempts = currentJob?.maxAttempts ?? job.maxAttempts;

    if (err instanceof OAuthFlowError || (err instanceof GraphApiError && err.isAuthRevoked)) {
      const msg = err instanceof Error ? err.message : 'Outlook authorization expired or revoked';
      await this.oauthService.markAccountAuthFailure(job.outlookAccountId, 'REVOKED', msg);
      await this.requeueWithBackoff(job.id, emailMessageId, msg, 120_000);
      return;
    }

    if (err instanceof GraphApiError) {
      if (err.isPermanent) {
        await this.failJobPermanently(
          job.id,
          job.leadId,
          job.outlookAccountId,
          job.campaignId,
          err.message,
          true,
          emailMessageId,
          err.statusCode,
        );
        return;
      }

      if (attempts < maxAttempts) {
        const delayMs = computeRetryBackoffMs(attempts, err.retryAfterSeconds, this.randomFn);
        await this.requeueWithBackoff(job.id, emailMessageId, err.message, delayMs);
        return;
      }

      await this.failJobPermanently(
        job.id,
        job.leadId,
        job.outlookAccountId,
        job.campaignId,
        err.message,
        true,
        emailMessageId,
        err.statusCode,
      );
      return;
    }

    const message = err instanceof Error ? err.message : 'Unexpected sending failure';
    if (attempts < maxAttempts) {
      const delayMs = computeRetryBackoffMs(attempts, undefined, this.randomFn);
      await this.requeueWithBackoff(job.id, emailMessageId, message, delayMs);
    } else {
      await this.failJobPermanently(job.id, job.leadId, job.outlookAccountId, job.campaignId, message, true, emailMessageId);
    }
  }

  private async requeueWithBackoff(
    jobId: string,
    emailMessageId: string,
    reason: string,
    delayMs: number,
  ): Promise<void> {
    const scheduledFor = new Date(Date.now() + delayMs);
    await this.prisma.$transaction(async (tx) => {
      if (emailMessageId) {
        await tx.emailMessage.delete({ where: { id: emailMessageId } }).catch(() => undefined);
      }
      await tx.sendingJob.update({
        where: { id: jobId },
        data: {
          status: 'PENDING',
          scheduledFor,
          lockedAt: null,
          lockedBy: null,
          lastError: reason,
        },
      });
    });
  }

  private async cancelJob(jobId: string, reason: string): Promise<void> {
    await this.prisma.sendingJob.update({
      where: { id: jobId },
      data: {
        status: 'CANCELLED',
        lockedAt: null,
        lockedBy: null,
        lastError: reason,
      },
    });
  }

  private async failJobPermanently(
    jobId: string,
    leadId: string,
    outlookAccountId: string,
    campaignId: string,
    errorMessage: string,
    notifyError: boolean,
    emailMessageId?: string,
    statusCode?: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.sendingJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          lockedAt: null,
          lockedBy: null,
          lastError: errorMessage,
        },
      });
      await tx.lead.update({
        where: { id: leadId },
        data: {
          status: 'FAILED',
          deliveryStatus: 'FAILED',
          errorMessage,
        },
      });
      if (emailMessageId) {
        await tx.emailMessage.update({
          where: { id: emailMessageId },
          data: {
            status: 'FAILED',
            deliveryStatus: 'FAILED',
            providerResponseCode: statusCode ?? null,
            errorMessage,
          },
        });
      }
      await tx.emailEvent.create({
        data: {
          emailMessageId: emailMessageId || null,
          outlookAccountId,
          campaignId,
          leadId,
          eventType: 'FAILED',
          metadataJson: JSON.stringify({ errorMessage }),
        },
      });
    });

    if (notifyError) {
      await this.queueErrorWhatsAppAlert(outlookAccountId, campaignId, errorMessage);
    }
    await this.checkAndCompleteCampaign(campaignId);
  }

  private async checkAndCompleteCampaign(campaignId: string): Promise<void> {
    const remaining = await this.prisma.sendingJob.count({
      where: {
        campaignId,
        status: { in: ['PENDING', 'PROCESSING', 'UNCERTAIN'] },
      },
    });
    if (remaining > 0) return;

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { outlookAccount: true },
    });
    if (!campaign || campaign.status !== 'ACTIVE') return;

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'COMPLETED' },
    });

    const waConfig = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (waConfig?.recipientPhoneNumber && waConfig.notifyCampaignComplete) {
      const dedupeKey = `campaign_complete:${campaign.id}`;
      try {
        await this.prisma.whatsAppNotificationJob.create({
          data: {
            dedupeKey,
            eventType: 'CAMPAIGN_COMPLETE',
            outlookAccountId: campaign.outlookAccountId,
            recipientPhone: waConfig.recipientPhoneNumber,
            messageText: formatWhatsAppNotificationMessage({
              eventType: 'CAMPAIGN_COMPLETE',
              outlookEmail: campaign.outlookAccount.email,
              campaignName: campaign.name,
              timezone: campaign.outlookAccount.timezone,
            }),
            status: 'PENDING',
          },
        });
        this.onWhatsAppNotificationQueued?.();
      } catch {
        // Dedupe key already handled
      }
    }
  }

  private async queueErrorWhatsAppAlert(
    outlookAccountId: string,
    campaignId: string,
    errorMessage: string,
  ): Promise<void> {
    const waConfig = await this.prisma.whatsAppConfig.findUnique({ where: { id: 'default' } });
    if (!waConfig?.recipientPhoneNumber || !waConfig.notifySendError) return;

    const [account, campaign] = await Promise.all([
      this.prisma.outlookAccount.findUnique({ where: { id: outlookAccountId } }),
      this.prisma.campaign.findUnique({ where: { id: campaignId } }),
    ]);

    try {
      await this.prisma.whatsAppNotificationJob.create({
        data: {
          dedupeKey: `send_error:${campaignId}:${Date.now()}:${generateRandomToken(4)}`,
          eventType: 'SEND_ERROR',
          outlookAccountId,
          recipientPhone: waConfig.recipientPhoneNumber,
          messageText: formatWhatsAppNotificationMessage({
            eventType: 'SEND_ERROR',
            outlookEmail: account?.email,
            campaignName: campaign?.name,
            errorMessage,
            timezone: account?.timezone ?? 'UTC',
          }),
          status: 'PENDING',
        },
      });
      this.onWhatsAppNotificationQueued?.();
    } catch {
      // Ignore dedupe failures
    }
  }
}
