import express, { Express } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import apiRouter from './routes/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const createApp = (): Express => {
  const app = express();

  // Middleware
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Mount API router
  app.use('/api', apiRouter);

  // Check for built client dist
  const candidates = [
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), './client/dist'),
    path.resolve(__dirname, '../../client/dist'),
    path.resolve(__dirname, '../public')
  ];
  const clientDist = candidates.find(c => fs.existsSync(c));

  if (clientDist) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    // Root welcome route for API-only mode
    app.get('/', (req, res) => {
      res.json({
        name: 'e-TimeHR Attendance Portal API',
        version: '1.0.0',
        status: 'online',
        endpoints: {
          sources: '/api/sources',
          attendance: '/api/attendance',
          dashboardStats: '/api/attendance/stats',
          syncSource: '/api/sync/:sourceId',
          syncAll: '/api/sync/all',
          syncLogs: '/api/sync/logs',
          health: '/api/health',
        },
      });
    });
  }

  // Global error handler
  app.use(errorHandler);

  return app;
};
