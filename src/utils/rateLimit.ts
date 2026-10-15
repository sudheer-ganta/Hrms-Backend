import { Request, Response, NextFunction } from 'express';
import { ApiError, sendError } from './apiError.js';

/**
 * Minimal in-memory fixed-window limiter. Per-process: if the API is scaled to
 * several instances, front it with a shared limiter (e.g. at the proxy).
 */
export const createRateLimiter = (opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) => {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(opts.windowMs, 60_000));
  timer.unref?.();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const k = opts.key(req);
    const now = Date.now();
    const cur = hits.get(k);
    if (!cur || cur.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    cur.count += 1;
    if (cur.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((cur.resetAt - now) / 1000)));
      return sendError(res, ApiError.tooMany(opts.message));
    }
    next();
  };
  return Object.assign(middleware, { reset: () => hits.clear() });
};
