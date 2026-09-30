'use client';

import { useState } from 'react';
import type { Appointment } from '@/lib/types';

interface Props {
  appointments: Appointment[];
  loading: boolean;
  error: string | null;
  timezone?: string;
  onCancel: (id: string) => Promise<void>;
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

export default function AppointmentList({ appointments, loading, error, timezone, onCancel, onRetry }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
          const cancellable = upcoming && (a.status === 'confirmed' || a.status === 'pending');
          return (
            <li key={a.id} className="appt-item">
              <div>
                <div className="appt-service">{a.service}</div>
                <div className="muted">{formatWhen(a.startsAt, timezone)}</div>
                {a.notes && <div className="appt-notes">{a.notes}</div>}
              </div>
              <div className="appt-side">
                <span className={`badge badge-${a.status}`}>{a.status}</span>
                {cancellable && (
                  <button className="link-btn danger" disabled={busyId === a.id} onClick={() => cancel(a)}>
                    {busyId === a.id ? 'Cancelling...' : 'Cancel'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {timezone && appointments.length > 0 && <p className="hint">Times shown in {timezone}.</p>}
    </section>
  );
}
