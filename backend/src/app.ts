import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { pool } from './db/pool';
import { errorHandler, notFound } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimit';
import { requestLogger } from './middleware/requestLogger';
import { appointmentsRouter } from './routes/appointments';
import { authRouter } from './routes/auth';
import { chatRouter } from './routes/chat';

export const app = express();

app.set('trust proxy', 1); // behind Render/Railway proxies, so rate limiting sees real client IPs
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '10kb' }));
app.use(requestLogger);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

app.use('/api', generalLimiter);
app.use('/api/auth', authRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/chat', chatRouter);

app.use(notFound);
app.use(errorHandler);

export default app;