import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  AI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  AI_MODEL: z.string().default('gemini-3.8-flash'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  DEFAULT_BUSINESS_ID: z.string().uuid().default('11111111-1111-1111-1111-111111111111'),
});

// Fail fast on bad config instead of crashing later at request time.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
