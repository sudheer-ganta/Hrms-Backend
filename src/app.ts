import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import apiRouter from './routes/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler, apiNotFound } from './middleware/errorHandler.js';
import { ENV } from './config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const securityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (ENV.IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
};

export const createApp = (): Express => {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render/Vercel proxies: needed so rate limiting sees the real client IP.
  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(
    cors({
      // Same-origin (Vercel /api rewrite) needs no CORS. Cross-origin callers must be listed in CORS_ORIGINS.
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ENV.CORS_ORIGINS.includes(origin)) return cb(null, true);
        if (!ENV.IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use(express.json({ limit: '300kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(requestLogger);

  app.use('/api', apiRouter);
  app.use('/api', apiNotFound);

  // Optional static client bundle
  const candidates = [
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), './client/dist'),
    path.resolve(__dirname, '../../client/dist'),
    path.resolve(__dirname, '../public'),
  ];
  const clientDist = candidates.find((c) => fs.existsSync(c));
  if (clientDist) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({ name: 'ColorMyles HRMS API', status: 'online' });
    });
  }

  app.use(errorHandler);
  return app;
};
