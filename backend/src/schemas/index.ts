import { z } from 'zod';
import { SERVICES } from '../services/bookingRules';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:mm');

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72), // bcrypt limit
  fullName: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});

export const createAppointmentSchema = z.object({
  service: z.enum(SERVICES),
  date,
  time,
  notes: z.string().trim().max(500).optional(),
  sessionId: z.string().uuid().optional(), // set when the form is the fallback for a chat
});

export const listAppointmentsQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
});

export const chatMessageSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1, 'Message cannot be empty').max(1000),
});

export const idParam = z.object({ id: z.string().uuid() });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
