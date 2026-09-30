'use client';

import { FormEvent, useMemo, useState } from 'react';
import { buildSlots, label12, partsIn, todayIn } from '@/lib/slots';
import type { Appointment, BookingOptions } from '@/lib/types';

interface Props {
  appointments: Appointment[];
  loading: boolean;
  error: string | null;
  options: BookingOptions;
  onCancel: (id: string) => Promise<void>;
  onReschedule: (id: string, values: { date: string; time: string }) => Promise<void>;
  onRetry: () => void;
}

function formatWhen(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

function RescheduleForm({
  appt,
  options,
  onSave,
  onClose,
}: {
  appt: Appointment;
  options: BookingOptions;
  onSave: (values: { date: string; time: string }) => Promise<void>;
  onClose: () => void;
}) {
  const current = partsIn(appt.startsAt, options.timezone);
  const [date, setDate] = useState(current.date);
  const [time, setTime] = useState(current.time);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = useMemo(() => {
    const s = buildSlots(options.hours);
    return s.includes(current.time) ? s : [...s, current.time].sort();
  }, [options.hours, current.time]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!date || !time) return setError('Choose a date and a time.');
    if (date === current.date && time === current.time) return setError('That is already your current time.');
    setSaving(true);
    try {
      await onSave({ date, time });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reschedule. Please try again.');
      setSaving(false);
    }
  }

  return (
    <form className="reschedule-form" onSubmit={submit} noValidate>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`rs-date-${appt.id}`}>New date</label>
          <input
            id={`rs-date-${appt.id}`}
            type="date"
            min={todayIn(options.timezone)}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`rs-time-${appt.id}`}>New time</label>
          <select id={`rs-time-${appt.id}`} value={time} onChange={(e) => setTime(e.target.value)}>
            {slots.map((t) => (
              <option key={t} value={t}>{label12(t)}</option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="reschedule-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Close</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? 'Saving...' : 'Save new time'}
        </button>
      </div>
    </form>
  );
}

export default function AppointmentList({ appointments, loading, error, options, onCancel, onReschedule, onRetry }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const timezone = options.timezone;

  async function cancel(a: Appointment) {
    if (!window.confirm(`Cancel your ${a.service} appointment?`)) return;
    setBusyId(a.id);
    setActionError(null);
    try {
      await onCancel(a.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not cancel the appointment.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card" aria-labelledby="appts-title">
      <div className="card-head">
        <h2 id="appts-title">Your appointments</h2>
      </div>

      {loading && <div className="skeleton-list" aria-busy="true"><div className="skeleton" /><div className="skeleton" /></div>}

      {!loading && error && (
        <div className="alert alert-error" role="alert">
          {error} <button className="link-btn" onClick={onRetry}>Retry</button>
        </div>
      )}

      {!loading && !error && appointments.length === 0 && (
        <div className="empty">
          <p><strong>No appointments yet</strong></p>
          <p className="muted">Ask the assistant to book one, or use the booking form.</p>
        </div>
      )}

      {actionError && <div className="alert alert-error" role="alert">{actionError}</div>}

      <ul className="appt-list">
        {appointments.map((a) => {
          const upcoming = new Date(a.startsAt).getTime() > Date.now();
          const changeable = upcoming && (a.status === 'confirmed' || a.status === 'pending');
          return (
            <li key={a.id} className="appt-item">
              <div className="appt-row">
                <div>
                  <div className="appt-service">{a.service}</div>
                  <div className="muted">{formatWhen(a.startsAt, timezone)}</div>
                  {a.notes && <div className="appt-notes">{a.notes}</div>}
                </div>
                <div className="appt-side">
                  <span className={`badge badge-${a.status}`}>{a.status}</span>
                  {changeable && (
                    <div className="appt-actions">
                      <button
                        className="link-btn"
                        disabled={busyId === a.id}
                        onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                      >
                        {editingId === a.id ? 'Close' : 'Reschedule'}
                      </button>
                      <button className="link-btn danger" disabled={busyId === a.id} onClick={() => cancel(a)}>
                        {busyId === a.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {editingId === a.id && (
                <RescheduleForm
                  appt={a}
                  options={options}
                  onSave={(values) => onReschedule(a.id, values)}
                  onClose={() => setEditingId(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {timezone && appointments.length > 0 && <p className="hint">Times shown in {timezone}.</p>}
    </section>
  );
}
