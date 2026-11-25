import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { hashToken, timingSafeEqualStrings } from '../crypto/security.js';

export const SESSION_COOKIE_NAME = 'outreach_session';

export interface AuthenticatedAdmin {
  userId: string;
  email: string;
  sessionId: string;
  csrfSecret: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
    }
  }
}

export interface SessionStoreDb {
  session: {
    findUnique(args: {
      where: { tokenHash: string };
      include: { user: true };
    }): Promise<{
      id: string;
      userId: string;
      csrfSecret: string;
      expiresAt: Date;
      user: { id: string; email: string };
    } | null>;
    update(args: { where: { id: string }; data: { lastSeenAt: Date } }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export function createAuthRateLimiter(windowMs = 15 * 60_000, max = 15) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many authentication attempts. Please wait a few minutes before trying again.',
    },
  });
}

export function createRequireAuth(db: SessionStoreDb, sessionSecret: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
      if (!rawToken) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const tokenHash = hashToken(rawToken, sessionSecret);
      const session = await db.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!session || session.expiresAt <= new Date()) {
        if (session) {
          await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
        }
        res.clearCookie(SESSION_COOKIE_NAME);
        res.status(401).json({ error: 'Session expired or invalid' });
        return;
      }

      // Verify CSRF token on state-changing requests
      const method = req.method.toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const headerCsrf = req.get('X-CSRF-Token') || '';
        if (!headerCsrf || !timingSafeEqualStrings(headerCsrf, session.csrfSecret)) {
          res.status(403).json({ error: 'Invalid or missing CSRF token' });
          return;
        }
      }

      req.admin = {
        userId: session.user.id,
        email: session.user.email,
        sessionId: session.id,
        csrfSecret: session.csrfSecret,
      };

      // Update lastSeenAt opportunistically without blocking request
      db.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);

      next();
    } catch (err) {
      next(err);
    }
  };
}
