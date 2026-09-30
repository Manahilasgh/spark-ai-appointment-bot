import rateLimit from 'express-rate-limit';

const tooMany = (message: string) => (_req: unknown, res: any) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });

const base = { standardHeaders: true, legacyHeaders: false } as const;

// Everything under /api
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 120,
  handler: tooMany('Too many requests, please slow down.'),
});

// Brute-force protection for signup/login
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 20,
  handler: tooMany('Too many authentication attempts. Try again in a few minutes.'),
});

// Protects LLM spend. Mounted AFTER requireAuth so it can key on the user, not the IP.
export const chatLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.user?.id ?? 'anonymous',
  handler: tooMany('You are sending messages too quickly.'),
});
