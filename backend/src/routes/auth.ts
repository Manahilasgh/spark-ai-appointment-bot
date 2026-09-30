import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { loginSchema, signupSchema } from '../schemas';
import * as authService from '../services/authService';
import { asyncHandler } from '../utils/asyncHandler';

export const authRouter = Router();

authRouter.post(
  '/signup',
  authLimiter,
  validate({ body: signupSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await authService.signup(req.body));
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    res.json(await authService.login(req.body));
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.getUser(req.user!.id) });
  }),
);
