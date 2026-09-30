import { AppError } from '../utils/AppError';

// Business rules live here, NOT in the LLM prompt. The model only extracts; this decides.
export const SERVICES = ['Teeth cleaning', 'Check-up', 'Filling', 'Consultation'] as const;
export type Service = (typeof SERVICES)[number];

export const DEFAULT_DURATION_MIN = 30;
const OPEN_MIN = 9 * 60; // 09:00
const CLOSE_MIN = 18 * 60; // 18:00

/** Offset (ms) between a timezone's wall-clock and UTC at a given instant. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - at.getTime();
}

/** Interprets "2026-10-05" + "15:00" as wall-clock time in `timeZone` and returns the UTC instant. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - tzOffsetMs(new Date(guess), timeZone));
}

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); // YYYY-MM-DD
}

/** Validates a requested slot and returns UTC start/end. Throws a friendly 422 if invalid. */
export function buildSlot(date: string, time: string, timeZone: string, durationMin = DEFAULT_DURATION_MIN) {
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new AppError(422, 'INVALID_SLOT', 'That date does not exist. Which date would you like?', { field: 'date' });
  }

  const startsAt = zonedTimeToUtc(date, time, timeZone);
  if (startsAt.getTime() < Date.now() + 5 * 60_000) {
    const field = date < todayIn(timeZone) ? 'date' : 'time';
    throw new AppError(422, 'INVALID_SLOT', 'That time has already passed. Please pick a future date and time.', { field });
  }

  const [hh, mm] = time.split(':').map(Number);
  const startMin = hh * 60 + mm;
  if (startMin < OPEN_MIN || startMin + durationMin > CLOSE_MIN) {
    throw new AppError(422, 'INVALID_SLOT', 'We are open 09:00 to 18:00. Please choose a time within those hours.', {
      field: 'time',
    });
  }

  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) };
}

export function formatSlot(startsAt: Date, timeZone: string): string {
  const day = startsAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const clock = startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return `${day} at ${clock}`;
}

export const BUSINESS_HOURS = { open: '09:00', close: '18:00', slotMinutes: DEFAULT_DURATION_MIN };
