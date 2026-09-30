import { z } from 'zod';

export const staffAppointmentsQuery = z.object({
  when: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
});

export const setRoleSchema = z.object({
  role: z.enum(['customer', 'staff', 'admin']),
});

export type StaffAppointmentsQuery = z.infer<typeof staffAppointmentsQuery>;
