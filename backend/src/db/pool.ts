import { Pool } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

pool.on('error', (err) => logger.error({ err }, 'Unexpected Postgres pool error'));
