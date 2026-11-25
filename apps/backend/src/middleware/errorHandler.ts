import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const statusCode =
    typeof (err as { statusCode?: unknown })?.statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;

  const message =
    statusCode >= 500
      ? 'An unexpected internal error occurred. Please check server logs.'
      : err instanceof Error
        ? err.message
        : 'Request failed';

  logger.error('HTTP request error', {
    method: req.method,
    path: req.path,
    statusCode,
    err,
  });

  if (res.headersSent) return;
  res.status(statusCode).json({ error: message });
}
