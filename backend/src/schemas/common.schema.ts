import { z } from 'zod';

/** Calendar date, YYYY-MM-DD */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** 24-hour clock time, HH:mm */
export const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:mm');

/** Route param that must be a UUID, e.g. /appointments/:id */
export const idParam = z.object({ id: z.string().uuid() });
