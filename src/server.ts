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

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: shutting down gracefully...`);
    syncScheduler.stop(false);
    // Hard stop if connections do not drain (Render sends SIGKILL after its own grace period anyway).
    const force = setTimeout(() => { console.error('Graceful shutdown timed out; forcing exit.'); process.exit(1); }, 10_000);
    force.unref();
    server.close(async () => {
      try { const { default: mongoose } = await import('mongoose'); await mongoose.disconnect(); } catch { /* already closed */ }
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise nobody awaited must be visible, and must not leave the process in an unknown state.
  process.on('unhandledRejection', (reason) => { console.error('[Process] Unhandled rejection:', reason instanceof Error ? reason.message : reason); });
  process.on('uncaughtException', (err) => { console.error('[Process] Uncaught exception, exiting:', err.message); shutdown('uncaughtException'); });
};

startServer().catch((err) => {
  console.error('Fatal error starting server:', err.message || err);
  process.exit(1);
});
