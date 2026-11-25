import { passwordSchema } from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from '../config/env.js';
import { hashPassword } from '../crypto/security.js';
import { logger } from '../utils/logger.js';

export async function bootstrapDatabase(prisma: PrismaClient, config: AppConfig): Promise<void> {
  await prisma.systemSettings.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      publicBaseUrl: config.appBaseUrl,
    },
    update: {},
  });

  await prisma.whatsAppConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      connectionStatus: 'DISCONNECTED',
    },
    update: {},
  });

  const existingAdmin = await prisma.adminUser.findUnique({
    where: { email: config.adminEmail },
  });

  if (!existingAdmin) {
    let passwordHash = config.adminPasswordHash?.trim();
    if (!passwordHash) {
      const initialPassword = config.adminInitialPassword?.trim();
      if (!initialPassword) {
        throw new Error(
          'No administrator account exists in database. Set ADMIN_INITIAL_PASSWORD or ADMIN_PASSWORD_HASH.',
        );
      }
      if (config.nodeEnv === 'production') {
        const validation = passwordSchema.safeParse(initialPassword);
        if (!validation.success) {
          throw new Error(
            `ADMIN_INITIAL_PASSWORD does not meet security policy: ${validation.error.issues[0]?.message}`,
          );
        }
      }
      passwordHash = hashPassword(initialPassword);
    }

    await prisma.adminUser.create({
      data: {
        email: config.adminEmail,
        passwordHash,
      },
    });
    logger.info('Bootstrapped single administrator user', { email: config.adminEmail });
  }
}
