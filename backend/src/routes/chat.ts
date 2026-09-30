import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { chatLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { chatMessageSchema, idParam } from '../schemas';
import * as chat from '../services/chatService';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export const chatRouter = Router();
chatRouter.use(requireAuth, chatLimiter);

// Send a message and get the complete reply as JSON. Omit sessionId to start a new conversation.
chatRouter.post(
  '/messages',
  validate({ body: chatMessageSchema }),
  asyncHandler(async (req, res) => {
    res.json(await chat.handleMessage(req.user!, req.body));
  }),
);

/**
 * Same as above, but streamed as server-sent events so the reply appears word by word.
 * Events (one JSON object per `data:` line):
 *   { type: 'delta', text }   a piece of the reply as it is written
 *   { type: 'final', ... }    the authoritative result (same body as the JSON endpoint)
 *   { type: 'error', code, message }
 * Errors that happen before streaming starts (auth, validation, rate limit) are ordinary JSON error responses.
 */
chatRouter.post('/messages/stream', validate({ body: chatMessageSchema }), async (req, res, next) => {
  let started = false;
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const send = (event: object) => {
    if (closed) return;
    if (!started) {
      started = true;
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // stop proxies from buffering the stream
      });
      res.flushHeaders();
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await chat.handleMessage(req.user!, req.body, (text) => send({ type: 'delta', text }));
    send({ type: 'final', ...result });
    res.end();
  } catch (err) {
    if (!started) return next(err); // nothing sent yet: use the normal JSON error handler
    if (!(err instanceof AppError)) logger.error({ err }, 'Error while streaming chat reply');
    const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
    send({ type: 'error', code: e.code, message: e.message });
    res.end();
  }
});

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
