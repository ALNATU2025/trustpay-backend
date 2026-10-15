'use strict';
const env = require('./config/env');
const log = require('./utils/log');
const { connect, disconnect } = require('./db');
const { createApp } = require('./app');

async function main() {
  env.assertValid();
  for (const w of env.warnings) log.warn(w);
  if (env.providerMode === 'sandbox') log.warn('PROVIDER_MODE=sandbox: no real money moves and no real SMS is sent.');

  await connect();
  log.info('MongoDB connected');

  const app = createApp();
  const server = app.listen(env.port, () => log.info(`TrustPay API listening on :${env.port}`, { env: env.NODE_ENV }));
  // Render closes idle connections after ~55s; keep ours slightly longer to avoid 502s on keep-alive reuse.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 70 * 1000;

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received: shutting down`);
    server.close(async () => {
      await disconnect().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('Unhandled rejection', { message: err && err.message }));
}

main().catch((err) => {
  log.error('Failed to start', { message: err.message });
  process.exit(1);
});
