import { Request, Response, NextFunction } from 'express';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Path only: query strings can carry employee codes, names and search terms, which must not land in logs.
    console.log(`[HTTP] ${req.method} ${req.baseUrl}${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
};
