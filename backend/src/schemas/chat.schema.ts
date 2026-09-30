import { z } from 'zod';

export const chatMessageSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1, 'Message cannot be empty').max(1000),
});

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
