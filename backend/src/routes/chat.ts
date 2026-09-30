import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { chatLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { chatMessageSchema, idParam } from '../schemas';
import * as chat from '../services/chatService';
import { asyncHandler } from '../utils/asyncHandler';

export const chatRouter = Router();
chatRouter.use(requireAuth, chatLimiter);

// Send a message. Omit sessionId to start a new conversation.
chatRouter.post(
  '/messages',
  validate({ body: chatMessageSchema }),
  asyncHandler(async (req, res) => {
    res.json(await chat.handleMessage(req.user!, req.body));
  }),
);

// Reload a conversation (history + current draft)
chatRouter.get(
  '/sessions/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await chat.getSession(req.user!, req.params.id));
  }),
);

// The user explicitly confirms the drafted action (book, reschedule or cancel)
chatRouter.post(
  '/sessions/:id/confirm',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await chat.confirmBooking(req.user!, req.params.id);
    res.status(result.action === 'book' ? 201 : 200).json(result);
  }),
);
