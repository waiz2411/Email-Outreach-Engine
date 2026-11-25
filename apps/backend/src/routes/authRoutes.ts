import { Router } from 'express';
import { z } from 'zod';
import { passwordSchema } from '@outreach-engine/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { AppConfig } from '../config/env.js';
import {
  generateRandomToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../crypto/security.js';
import {
  SESSION_COOKIE_NAME,
  createAuthRateLimiter,
  createRequireAuth,
} from '../middleware/auth.js';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1, 'Password is required'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export function createAuthRoutes(prisma: PrismaClient, config: AppConfig): Router {
  const router = Router();
  const authRateLimiter = createAuthRateLimiter(15 * 60_000, config.nodeEnv === 'test' ? 1000 : 15);
  const requireAuth = createRequireAuth(prisma, config.sessionSecret);

  router.post('/login', authRateLimiter, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid email or password format' });
        return;
      }

      const email = parsed.data.email.toLowerCase();
      const user = await prisma.adminUser.findUnique({ where: { email } });

      if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
        await prisma.auditLog.create({
          data: {
            action: 'LOGIN_FAILED',
            entityType: 'AdminUser',
            detailsJson: JSON.stringify({ email }),
            ipAddress: req.ip,
          },
        });
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      // Clean up expired sessions
      await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

      const rawToken = generateRandomToken(32);
      const tokenHash = hashToken(rawToken, config.sessionSecret);
      const csrfSecret = generateRandomToken(24);
      const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

      await prisma.session.create({
        data: {
          tokenHash,
          csrfSecret,
          userId: user.id,
          ipAddress: req.ip,
          userAgent: req.get('user-agent')?.slice(0, 250) ?? null,
          expiresAt,
        },
      });

      await prisma.auditLog.create({
        data: {
          action: 'LOGIN_SUCCESS',
          entityType: 'AdminUser',
          entityId: user.id,
          ipAddress: req.ip,
        },
      });

      res.cookie(SESSION_COOKIE_NAME, rawToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production' && config.appBaseUrl.startsWith('https://'),
        expires: expiresAt,
        path: '/',
      });

      res.json({
        user: { id: user.id, email: user.email },
        csrfToken: csrfSecret,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      if (req.admin?.sessionId) {
        await prisma.session.delete({ where: { id: req.admin.sessionId } }).catch(() => undefined);
        await prisma.auditLog.create({
          data: {
            action: 'LOGOUT',
            entityType: 'AdminUser',
            entityId: req.admin.userId,
            ipAddress: req.ip,
          },
        });
      }
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({
      user: {
        id: req.admin!.userId,
        email: req.admin!.email,
      },
      csrfToken: req.admin!.csrfSecret,
    });
  });

  router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid password input' });
        return;
      }

      const user = await prisma.adminUser.findUnique({ where: { id: req.admin!.userId } });
      if (!user || !verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }

      const newHash = hashPassword(parsed.data.newPassword);
      await prisma.$transaction([
        prisma.adminUser.update({
          where: { id: user.id },
          data: { passwordHash: newHash },
        }),
        prisma.session.deleteMany({
          where: { userId: user.id, id: { not: req.admin!.sessionId } },
        }),
        prisma.auditLog.create({
          data: {
            action: 'PASSWORD_CHANGED',
            entityType: 'AdminUser',
            entityId: user.id,
            ipAddress: req.ip,
          },
        }),
      ]);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
