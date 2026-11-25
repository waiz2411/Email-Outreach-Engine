import { loadConfig } from './config/env.js';
import { bootstrapDatabase } from './db/bootstrap.js';
import { createDatabaseBundle } from './db/prisma.js';
import { createAppContext } from './app.js';
import { generateRandomToken, hashToken } from './crypto/security.js';
import { logger } from './utils/logger.js';

async function main() {
  const config = loadConfig();
  const db = await createDatabaseBundle(config.databasePath);
  await bootstrapDatabase(db.prisma, config);

  const ctx = createAppContext(db.prisma, db.sqlite, config);

  // Recover any interrupted jobs safely without blind duplicates
  await ctx.sendingEngine.recoverInterruptedJobs();
  ctx.sendingEngine.start();

  if (ctx.whatsappLifecycle) {
    await ctx.whatsappLifecycle.startBackgroundServices();
  }

  // Periodic inbox reconciliation & Graph subscription renewal
  const runInboxReconciliation = async () => {
    const accounts = await db.prisma.outlookAccount.findMany({
      where: { connectionStatus: 'CONNECTED' },
    });

    for (const acc of accounts) {
      try {
        await ctx.inboxSyncService.syncAccountInbox(acc.id);

        // Renew or create Microsoft Graph subscription if public HTTPS URL is configured
        const baseUrl = config.appBaseUrl;
        if (baseUrl.startsWith('https://') && !baseUrl.includes('localhost')) {
          const expiresSoon =
            !acc.graphSubscriptionExpiresAt ||
            acc.graphSubscriptionExpiresAt.getTime() - Date.now() < 12 * 3600_000;

          if (expiresSoon) {
            const token = await ctx.oauthService.getValidAccessToken(acc.id);
            const expirationDateTime = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
            const notificationUrl = `${baseUrl}/api/webhooks/microsoft-graph`;

            if (acc.graphSubscriptionId) {
              const renewed = await ctx.graphClient
                .renewSubscription(token, acc.graphSubscriptionId, expirationDateTime)
                .catch(() => null);
              if (renewed) {
                await db.prisma.outlookAccount.update({
                  where: { id: acc.id },
                  data: { graphSubscriptionExpiresAt: new Date(renewed.expirationDateTime) },
                });
                continue;
              }
            }

            const clientState = generateRandomToken(24);
            const sub = await ctx.graphClient.createInboxSubscription(
              token,
              notificationUrl,
              clientState,
              expirationDateTime,
            );
            await db.prisma.outlookAccount.update({
              where: { id: acc.id },
              data: {
                graphSubscriptionId: sub.id,
                graphSubscriptionExpiresAt: new Date(sub.expirationDateTime),
                graphClientStateHash: hashToken(clientState, config.sessionSecret),
              },
            });
          }
        }
      } catch (err) {
        logger.warn('Periodic inbox sync failed for account', { accountId: acc.id, err });
      }
    }
  };

  const inboxTimer = setInterval(() => {
    void runInboxReconciliation();
  }, config.inboxSyncPollMs);

  const server = ctx.app.listen(config.port, '0.0.0.0', () => {
    logger.info('Outreach Engine server started', {
      port: config.port,
      host: '0.0.0.0',
      nodeEnv: config.nodeEnv,
      databasePath: config.databasePath,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info('Graceful shutdown initiated', { signal });
    clearInterval(inboxTimer);
    ctx.sendingEngine.stop();
    if (ctx.whatsappLifecycle) {
      await ctx.whatsappLifecycle.shutdown();
    }
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(async () => {
      await db.close();
      process.exit(1);
    }, 8000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
