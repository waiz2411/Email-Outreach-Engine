-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "globalPaused" BOOLEAN NOT NULL DEFAULT false,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "testModeRecipientEmail" TEXT,
    "openTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "clickTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "unsubscribeFooterEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxCampaignSize" INTEGER NOT NULL DEFAULT 5000,
    "maxSendRetries" INTEGER NOT NULL DEFAULT 3,
    "publicBaseUrl" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "codeVerifierEncrypted" TEXT NOT NULL,
    "redirectTo" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OutlookAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "microsoftUserId" TEXT,
    "tenantId" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "connectionStatus" TEXT NOT NULL DEFAULT 'CONNECTED',
    "authorizationStatus" TEXT NOT NULL DEFAULT 'AUTHORIZED',
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "scopes" TEXT,
    "lastError" TEXT,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "dailySendLimit" INTEGER NOT NULL DEFAULT 50,
    "minDelayMinutes" INTEGER NOT NULL DEFAULT 15,
    "maxDelayMinutes" INTEGER NOT NULL DEFAULT 25,
    "scheduleStartTime" TEXT NOT NULL DEFAULT '09:00',
    "scheduleEndTime" TEXT NOT NULL DEFAULT '17:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "allowedWeekdays" TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    "signatureHtml" TEXT,
    "signatureEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nextEligibleSendAt" DATETIME,
    "lastActivityAt" DATETIME,
    "graphSubscriptionId" TEXT,
    "graphSubscriptionExpiresAt" DATETIME,
    "graphClientStateHash" TEXT,
    "inboxDeltaLink" TEXT,
    "lastInboxSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AccountDailyCounter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outlookAccountId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountDailyCounter_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeadImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outlookAccountId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "invalidRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateResolution" TEXT,
    "invalidRowsReportJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadImportBatch_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outlookAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "importBatchId" TEXT,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "campaignNameHint" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isHtmlBody" BOOLEAN NOT NULL DEFAULT false,
    "customFieldsJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'VALIDATED',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'NONE',
    "bounceType" TEXT NOT NULL DEFAULT 'NONE',
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "lastAttemptedAt" DATETIME,
    "lastSentAt" DATETIME,
    "lastReplyAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lead_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Lead_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "LeadImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "outlookAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" DATETIME,
    "endDate" DATETIME,
    "confirmedFirstSend" BOOLEAN NOT NULL DEFAULT false,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "useAccountDefaults" BOOLEAN NOT NULL DEFAULT true,
    "dailyLimit" INTEGER,
    "minDelayMinutes" INTEGER,
    "maxDelayMinutes" INTEGER,
    "scheduleStartTime" TEXT,
    "scheduleEndTime" TEXT,
    "timezone" TEXT,
    "allowedWeekdays" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SendingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "outlookAccountId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledFor" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SendingJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendingJob_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendingJob_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sendingJobId" TEXT,
    "outlookAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "renderedBodyPreview" TEXT,
    "isTestEmail" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'QUEUED',
    "deliverySource" TEXT NOT NULL DEFAULT 'NONE',
    "bounceType" TEXT NOT NULL DEFAULT 'NONE',
    "bounceReason" TEXT,
    "graphDraftId" TEXT,
    "graphMessageId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "correlationId" TEXT NOT NULL,
    "providerResponseCode" INTEGER,
    "providerResponseText" TEXT,
    "errorMessage" TEXT,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    "bouncedAt" DATETIME,
    "firstOpenedAt" DATETIME,
    "firstClickedAt" DATETIME,
    "repliedAt" DATETIME,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailMessage_sendingJobId_fkey" FOREIGN KEY ("sendingJobId") REFERENCES "SendingJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackingLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "leadId" TEXT,
    "campaignId" TEXT,
    "destinationUrl" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingLink_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrackingLink_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TrackingLink_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailMessageId" TEXT,
    "outlookAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "eventType" TEXT NOT NULL,
    "metadataJson" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailEvent_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailEvent_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmailEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IncomingEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outlookAccountId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "inReplyTo" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "isBounceNdr" BOOLEAN NOT NULL DEFAULT false,
    "isCampaignReply" BOOLEAN NOT NULL DEFAULT false,
    "matchedCampaignId" TEXT,
    "matchedLeadId" TEXT,
    "matchedEmailMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncomingEmail_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IncomingEmail_matchedCampaignId_fkey" FOREIGN KEY ("matchedCampaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "IncomingEmail_matchedLeadId_fkey" FOREIGN KEY ("matchedLeadId") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "IncomingEmail_matchedEmailMessageId_fkey" FOREIGN KEY ("matchedEmailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceAccountId" TEXT,
    "sourceLeadId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WhatsAppConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "connectionStatus" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "linkedPhoneNumber" TEXT,
    "recipientPhoneNumber" TEXT,
    "lastConnectedAt" DATETIME,
    "lastNotificationAt" DATETIME,
    "lastError" TEXT,
    "includeBodyPreview" BOOLEAN NOT NULL DEFAULT false,
    "notifyNewEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifyReply" BOOLEAN NOT NULL DEFAULT true,
    "notifyCampaignComplete" BOOLEAN NOT NULL DEFAULT true,
    "notifySendError" BOOLEAN NOT NULL DEFAULT true,
    "notifyWhatsAppError" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WhatsAppAuthEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "encryptedValue" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WhatsAppNotificationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outlookAccountId" TEXT,
    "incomingEmailId" TEXT,
    "recipientPhone" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" DATETIME,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WhatsAppNotificationJob_outlookAccountId_fkey" FOREIGN KEY ("outlookAccountId") REFERENCES "OutlookAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WhatsAppNotificationJob_incomingEmailId_fkey" FOREIGN KEY ("incomingEmailId") REFERENCES "IncomingEmail" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detailsJson" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_state_key" ON "OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutlookAccount_email_key" ON "OutlookAccount"("email");

-- CreateIndex
CREATE INDEX "AccountDailyCounter_dateKey_idx" ON "AccountDailyCounter"("dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDailyCounter_outlookAccountId_dateKey_key" ON "AccountDailyCounter"("outlookAccountId", "dateKey");

-- CreateIndex
CREATE INDEX "LeadImportBatch_outlookAccountId_createdAt_idx" ON "LeadImportBatch"("outlookAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_outlookAccountId_email_idx" ON "Lead"("outlookAccountId", "email");

-- CreateIndex
CREATE INDEX "Lead_outlookAccountId_status_idx" ON "Lead"("outlookAccountId", "status");

-- CreateIndex
CREATE INDEX "Lead_campaignId_status_idx" ON "Lead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Campaign_outlookAccountId_status_idx" ON "Campaign"("outlookAccountId", "status");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SendingJob_idempotencyKey_key" ON "SendingJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SendingJob_status_scheduledFor_idx" ON "SendingJob"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "SendingJob_campaignId_status_idx" ON "SendingJob"("campaignId", "status");

-- CreateIndex
CREATE INDEX "SendingJob_outlookAccountId_status_idx" ON "SendingJob"("outlookAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_sendingJobId_key" ON "EmailMessage"("sendingJobId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_correlationId_key" ON "EmailMessage"("correlationId");

-- CreateIndex
CREATE INDEX "EmailMessage_outlookAccountId_sentAt_idx" ON "EmailMessage"("outlookAccountId", "sentAt");

-- CreateIndex
CREATE INDEX "EmailMessage_campaignId_status_idx" ON "EmailMessage"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EmailMessage_leadId_idx" ON "EmailMessage"("leadId");

-- CreateIndex
CREATE INDEX "EmailMessage_recipientEmail_idx" ON "EmailMessage"("recipientEmail");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_idx" ON "EmailMessage"("conversationId");

-- CreateIndex
CREATE INDEX "EmailMessage_internetMessageId_idx" ON "EmailMessage"("internetMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_token_key" ON "TrackingLink"("token");

-- CreateIndex
CREATE INDEX "TrackingLink_emailMessageId_idx" ON "TrackingLink"("emailMessageId");

-- CreateIndex
CREATE INDEX "EmailEvent_outlookAccountId_occurredAt_idx" ON "EmailEvent"("outlookAccountId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_campaignId_eventType_idx" ON "EmailEvent"("campaignId", "eventType");

-- CreateIndex
CREATE INDEX "EmailEvent_emailMessageId_idx" ON "EmailEvent"("emailMessageId");

-- CreateIndex
CREATE INDEX "IncomingEmail_outlookAccountId_receivedAt_idx" ON "IncomingEmail"("outlookAccountId", "receivedAt");

-- CreateIndex
CREATE INDEX "IncomingEmail_conversationId_idx" ON "IncomingEmail"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingEmail_outlookAccountId_graphMessageId_key" ON "IncomingEmail"("outlookAccountId", "graphMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_email_key" ON "SuppressionEntry"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppNotificationJob_dedupeKey_key" ON "WhatsAppNotificationJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "WhatsAppNotificationJob_status_nextRetryAt_idx" ON "WhatsAppNotificationJob"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WhatsAppNotificationJob_createdAt_idx" ON "WhatsAppNotificationJob"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
