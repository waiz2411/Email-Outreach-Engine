import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type Database from 'better-sqlite3';
import type { PrismaClient } from './generated/prisma/client.js';
import type { AppConfig } from './config/env.js';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAccountRoutes, createOAuthCallbackRoute } from './routes/accountRoutes.js';
import { createAnalyticsRoutes } from './routes/analyticsRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createCampaignRoutes } from './routes/campaignRoutes.js';
import { createLeadRoutes } from './routes/leadRoutes.js';
import { createTrackingRoutes, createWebhookRoutes } from './routes/trackingRoutes.js';
import { createWhatsAppRoutes, type WhatsAppManagerPort } from './routes/whatsappRoutes.js';
import { SendingEngine } from './services/engine/sendingEngine.js';
import { RealMicrosoftGraphClient } from './services/microsoft/graphClient.js';
import type { MicrosoftGraphClient } from './services/microsoft/graphTypes.js';
import { InboxSyncService } from './services/microsoft/inboxSyncService.js';
import { MicrosoftOAuthService, type OAuthHttpTransport, defaultOAuthTransport } from './services/microsoft/oauthService.js';
import { WhatsAppService, type WhatsAppSocketFactory } from './services/whatsapp/whatsappService.js';

export interface AppRuntimeDependencies {
  graphClient?: MicrosoftGraphClient;
  oauthTransport?: OAuthHttpTransport;
  whatsappSocketFactory?: WhatsAppSocketFactory;
  whatsappManagerOverride?: WhatsAppManagerPort;
  randomFn?: () => number;
}

export interface CreatedAppContext {
  app: express.Express;
  oauthService: MicrosoftOAuthService;
  graphClient: MicrosoftGraphClient;
  inboxSyncService: InboxSyncService;
  sendingEngine: SendingEngine;
  whatsappService: WhatsAppManagerPort;
  whatsappLifecycle?: WhatsAppService;
}

export function createAppContext(
  prisma: PrismaClient,
  sqlite: Database.Database,
  config: AppConfig,
  deps: AppRuntimeDependencies = {},
): CreatedAppContext {
  const app = express();
  app.set('trust proxy', 1);

  const graphClient = deps.graphClient ?? new RealMicrosoftGraphClient();
  const oauthService = new MicrosoftOAuthService(
    prisma,
    config,
    deps.oauthTransport ?? defaultOAuthTransport,
  );

  const whatsappLifecycle = deps.whatsappManagerOverride
    ? undefined
    : new WhatsAppService(prisma, config, deps.whatsappSocketFactory);
  const whatsappService: WhatsAppManagerPort = deps.whatsappManagerOverride ?? whatsappLifecycle!;

  const triggerWaQueue = () => {
    if (whatsappLifecycle) {
      void whatsappLifecycle.processPendingNotifications().catch(() => undefined);
    }
  };

  const inboxSyncService = new InboxSyncService(prisma, oauthService, graphClient, triggerWaQueue);
  const sendingEngine = new SendingEngine(
    prisma,
    sqlite,
    config,
    oauthService,
    graphClient,
    triggerWaQueue,
    deps.randomFn,
  );

  app.use(
    helmet({
      contentSecurityPolicy:
        config.nodeEnv === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
              },
            }
          : false,
    }),
  );

  if (config.nodeEnv !== 'production') {
    app.use(
      cors({
        origin: config.corsOrigins,
        credentials: true,
      }),
    );
  }

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Healthcheck (never exposes secrets)
  app.get('/api/health', async (_req, res) => {
    try {
      sqlite.prepare('SELECT 1').get();
      const [settings, waConfig] = await Promise.all([
        prisma.systemSettings.findUnique({ where: { id: 'default' } }),
        prisma.whatsAppConfig.findUnique({ where: { id: 'default' } }),
      ]);
      res.json({
        status: 'ok',
        database: 'ok',
        globalPaused: settings?.globalPaused ?? false,
        whatsappStatus: waConfig?.connectionStatus ?? 'DISCONNECTED',
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  // Public tracking pixels, signed click redirects, unsubscribe pages, and Microsoft Graph webhook
  app.use('/t', createTrackingRoutes(prisma, config));
  app.use('/api/webhooks', createWebhookRoutes(prisma, config, inboxSyncService));

  // Public auth endpoints (login has strict rate limiting; /logout, /me, /change-password enforce auth inside router)
  app.use('/api/auth', createAuthRoutes(prisma, config));

  // OAuth callback (state parameter validated in DB)
  app.use('/api/oauth/microsoft', createOAuthCallbackRoute(oauthService, config));

  // All authenticated admin API routes
  const requireAuth = createRequireAuth(prisma, config.sessionSecret);
  app.use('/api/accounts', requireAuth, createAccountRoutes(prisma, config, oauthService, graphClient, inboxSyncService));
  app.use('/api/leads', requireAuth, createLeadRoutes(prisma));
  app.use('/api/campaigns', requireAuth, createCampaignRoutes(prisma, sendingEngine));
  app.use('/api/whatsapp', requireAuth, createWhatsAppRoutes(prisma, whatsappService));
  app.use('/api', requireAuth, createAnalyticsRoutes(prisma, sqlite, sendingEngine));

  // Production SPA serving
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDistDir = path.resolve(currentDir, '../../frontend/dist');
  if (fs.existsSync(frontendDistDir)) {
    app.use(express.static(frontendDistDir));
    app.get(/^(?!\/api\/|\/t\/).*/, (_req, res) => {
      res.sendFile(path.join(frontendDistDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  return {
    app,
    oauthService,
    graphClient,
    inboxSyncService,
    sendingEngine,
    whatsappService,
    whatsappLifecycle,
  };
}
