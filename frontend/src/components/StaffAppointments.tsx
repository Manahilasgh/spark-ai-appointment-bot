'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { StaffAppointment } from '@/lib/types';

type When = 'upcoming' | 'past' | 'all';
const FILTERS: { value: When; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
  { value: 'all', label: 'All' },
];

function formatWhen(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  });
}

export default function StaffAppointments({ timezone }: { timezone?: string }) {
  const [when, setWhen] = useState<When>('upcoming');
  const [items, setItems] = useState<StaffAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await api.staffAppointments(when)).appointments);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load appointments.');
    } finally {
      setLoading(false);
    }
  }, [when]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancel(a: StaffAppointment) {
    if (!window.confirm(`Cancel ${a.customer.name}'s ${a.service} appointment?`)) return;
    setBusyId(a.id);
    setError(null);
    try {
      await api.staffCancel(a.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the appointment.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card" aria-labelledby="staff-title">
      <div className="card-head">
        <div>
          <h2 id="staff-title">All appointments</h2>
          <p className="muted small">Every booking in the business. Visible to staff and admins only.</p>
        </div>
        <div className="segmented" role="group" aria-label="Filter appointments">
          {FILTERS.map((f) => (
            <button key={f.value} className={f.value === when ? 'active' : ''} onClick={() => setWhen(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error} <button className="link-btn" onClick={load}>Retry</button>
        </div>
      )}
      {loading && <div className="skeleton-list" aria-busy="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
      {!loading && !error && items.length === 0 && (
        <div className="empty"><p><strong>Nothing to show</strong></p><p className="muted">No {when === 'all' ? '' : when} appointments.</p></div>
      )}

      {!loading && items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>When</th><th>Customer</th><th>Service</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const cancellable = a.status === 'confirmed' || a.status === 'pending';
                return (
                  <tr key={a.id}>
                    <td>{formatWhen(a.startsAt, timezone)}</td>
                    <td>
                      <div>{a.customer.name}</div>
                      <div className="muted small">{a.customer.email}</div>
                    </td>
                    <td>{a.service}</td>
                    <td><span className={`badge badge-${a.status}`}>{a.status}</span></td>
                    <td className="right">
                      {cancellable && (
                        <button className="link-btn danger" disabled={busyId === a.id} onClick={() => cancel(a)}>
                          {busyId === a.id ? 'Cancelling...' : 'Cancel'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {timezone && !loading && items.length > 0 && <p className="hint">Times shown in {timezone}.</p>}
    </section>
  );
}
