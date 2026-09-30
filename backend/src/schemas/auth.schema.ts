import { z } from 'zod';

// Deliberately permissive (international numbers vary a lot): any mix of digits and the
// usual separators, plus an optional leading +. Empty means "not given".
const PHONE_CHARS = /^\+?[\d\s()\-.]*$/;
const digitsIn = (v: string) => v.replace(/\D/g, '');

const phoneSchema = z
  .string()
  .trim()
  .max(30, 'Phone number must be 30 characters or fewer')
  .refine((v) => PHONE_CHARS.test(v), 'Enter a valid phone number')
  .refine((v) => v === '' || digitsIn(v).length >= 7, 'Phone number must have at least 7 digits')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72), // bcrypt limit
  fullName: z.string().trim().min(1).max(100),
  phone: phoneSchema, // stored as NULL when omitted or left blank
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
