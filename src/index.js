const http = require('http');
const config = require('./config');
const logger = require('./logging/logger');
const { initDatabase, closeDatabase } = require('./db/database');
const { createApiApp } = require('./api/app');
const { startSourceServer } = require('./protocol/sourceServer');

async function main() {
  if (!config.session.secret) {
    logger.warn('SESSION_SECRET is not set (not required for API-only operation, but recommended to set a random value)');
  }
  initDatabase();

  const apiApp = createApiApp();
  const apiServer = http.createServer(apiApp);
  await new Promise((resolve, reject) => {
    apiServer.on('error', reject);
    apiServer.listen(config.admin.port, config.admin.host, () => {
      logger.info({ host: config.admin.host, port: config.admin.port }, 'api_server_listening');
      resolve();
    });
  });

  const sourceServer = await startSourceServer();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutdown_requested');
    const force = setTimeout(() => {
      logger.error('forced_shutdown_timeout');
      process.exit(1);
    }, 10000);
    force.unref?.();

    await Promise.allSettled([
      new Promise((resolve) => apiServer.close(() => resolve())),
      new Promise((resolve) => sourceServer.close(() => resolve())),
    ]);
    try { closeDatabase(); } catch (err) { logger.error({ err }, 'error_closing_database'); }
    clearTimeout(force);
    logger.info('shutdown_complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('roadside_radio_gateway_started');
}

main().catch((err) => {
  // Avoid logging secrets; error objects are generally safe here.
  logger.fatal({ err }, 'fatal_startup_error');
  process.exit(1);
});
