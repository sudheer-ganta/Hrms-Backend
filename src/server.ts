import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { ENV, assertEnv } from './config/env.js';
import { syncScheduler } from './modules/sync/syncScheduler.js';
import { policyService } from './modules/settings/policy.service.js';
import { authService } from './modules/auth/auth.service.js';
import { siteService } from './modules/sites/site.service.js';

const startServer = async (): Promise<void> => {
  assertEnv(); // refuses to start with an unsafe/missing JWT secret

  const app = createApp();
  const connected = await connectDatabase();

  if (connected) {
    await policyService.init();
    await siteService.ensureSites();
    await authService.bootstrapSuperAdmin();
  } else {
    // No fallback store: business endpoints answer 503 until MongoDB is reachable.
    console.error('[Startup] MongoDB is unreachable. Serving 503 for business endpoints; retrying in the background.');
    const { default: mongoose } = await import('mongoose');
    mongoose.connection.once('connected', async () => {
      await policyService.init();
      await siteService.ensureSites();
      await authService.bootstrapSuperAdmin();
    });
  }

  syncScheduler.init();

  const server = app.listen(ENV.PORT, () => {
    console.log(`ColorMyles HRMS API listening on :${ENV.PORT} (${ENV.NODE_ENV})`);
  });

  const shutdown = () => {
    console.log('Shutting down gracefully...');
    syncScheduler.stop(false);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

startServer().catch((err) => {
  console.error('Fatal error starting server:', err.message || err);
  process.exit(1);
});
