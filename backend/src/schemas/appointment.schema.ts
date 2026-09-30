import { z } from 'zod';
import { SERVICES } from '../services/bookingRules';
import { dateString, timeString } from './common.schema';

export const createAppointmentSchema = z.object({
  service: z.enum(SERVICES),
  date: dateString,
  time: timeString,
  notes: z.string().trim().max(500).optional(),
  sessionId: z.string().uuid().optional(), // set when the form is the fallback for a chat
});

export const rescheduleAppointmentSchema = z.object({
  date: dateString,
  time: timeString,
});

export const listAppointmentsQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
});

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
