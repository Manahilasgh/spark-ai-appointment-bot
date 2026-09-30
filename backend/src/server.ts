import { app } from './app';
import { env } from './config/env';
import { pool } from './db/pool';
import { logger } from './utils/logger';

const server = app.listen(env.PORT, () => logger.info(`API listening on port ${env.PORT}`));

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
