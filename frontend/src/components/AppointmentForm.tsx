'use client';

import { FormEvent, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Appointment, BookingOptions, Draft } from '@/lib/types';

interface Props {
  options: BookingOptions;
  initial?: Draft;
  sessionId?: string | null; // links the appointment to the chat it came from
  onCreated: (a: Appointment) => void;
  onCancel?: () => void;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');
const label12 = (t: string) => {
  const h = Number(t.slice(0, 2));
  return `${((h + 11) % 12) + 1}:${t.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`;
};

function buildSlots({ open, close, slotMinutes }: BookingOptions['hours']): string[] {
  const out: string[] = [];
  for (let m = toMin(open); m + slotMinutes <= toMin(close); m += slotMinutes) {
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  }
  return out;
}

export default function AppointmentForm({ options, initial, sessionId, onCreated, onCancel }: Props) {
  const [service, setService] = useState(initial?.service ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial?.time ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const slots = useMemo(() => {
    const s = buildSlots(options.hours);
    return time && !s.includes(time) ? [...s, time].sort() : s;
  }, [options.hours, time]);

  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the browser's timezone

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const missing: Record<string, string> = {};
    if (!service) missing.service = 'Choose a service';
    if (!date) missing.date = 'Choose a date';
    if (!time) missing.time = 'Choose a time';
    setFieldErrors(missing);
    if (Object.keys(missing).length) return;

    setSubmitting(true);
    try {
      const { appointment } = await api.createAppointment({
        service,
        date,
        time,
        notes: notes.trim() || undefined,
        sessionId: sessionId ?? undefined,
      });
      onCreated(appointment);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.details?.length) setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
        setError(err.code === 'VALIDATION_ERROR' ? 'Please check the highlighted fields.' : err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="appt-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor="af-service">Service</label>
        <select id="af-service" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Select a service</option>
          {options.services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {fieldErrors.service && <span className="field-error">{fieldErrors.service}</span>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="af-date">Date</label>
          <input id="af-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
          {fieldErrors.date && <span className="field-error">{fieldErrors.date}</span>}
        </div>
        <div className="field">
          <label htmlFor="af-time">Time</label>
          <select id="af-time" value={time} onChange={(e) => setTime(e.target.value)}>
            <option value="">Select a time</option>
            {slots.map((t) => (
              <option key={t} value={t}>{label12(t)}</option>
            ))}
          </select>
          {fieldErrors.time && <span className="field-error">{fieldErrors.time}</span>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="af-notes">Notes <span className="muted">(optional)</span></label>
        <textarea id="af-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
            Back to chat
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Booking...' : 'Book appointment'}
        </button>
      </div>
    </form>
  );
}
