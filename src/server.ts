import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { ENV } from './config/env.js';
import { syncScheduler } from './modules/sync/syncScheduler.js';
import { policyService } from './modules/settings/policy.service.js';

const startServer = async (): Promise<void> => {
  const app = createApp();

  // Attempt database connection
  await connectDatabase();

  // Load policy settings from MongoDB (source of truth) before anything reads them
  await policyService.init();

  // Initialize background auto-sync scheduler
  syncScheduler.init();

  const server = app.listen(ENV.PORT, () => {
    console.log(`
🚀 e-TimeHR Server running on http://localhost:${ENV.PORT}
📊 API Endpoints available at http://localhost:${ENV.PORT}/api
📍 Configured locations: ${Object.keys(ENV.SOURCES).join(', ')}
    `);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('Shutting down server gracefully...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
