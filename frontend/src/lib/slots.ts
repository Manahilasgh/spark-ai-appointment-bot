import type { BookingOptions } from './types';

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');

export const label12 = (t: string) => {
  const h = Number(t.slice(0, 2));
  return `${((h + 11) % 12) + 1}:${t.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** Bookable start times, e.g. 09:00, 09:30 ... 17:30 */
export function buildSlots({ open, close, slotMinutes }: BookingOptions['hours']): string[] {
  const out: string[] = [];
  for (let m = toMin(open); m + slotMinutes <= toMin(close); m += slotMinutes) {
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  }
  return out;
}

/** Date (YYYY-MM-DD) and time (HH:mm) of an ISO instant as seen in a given timezone. */
export function partsIn(iso: string, timeZone?: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-CA', { timeZone }),
    time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(d),
  };
}

export const todayIn = (timeZone?: string) => new Date().toLocaleDateString('en-CA', { timeZone });
