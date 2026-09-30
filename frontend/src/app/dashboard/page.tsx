'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import AppointmentList from '@/components/AppointmentList';
import ChatWidget from '@/components/ChatWidget';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Appointment, BookingOptions, DEFAULT_OPTIONS } from '@/lib/types';

export default function DashboardPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [options, setOptions] = useState<BookingOptions>(DEFAULT_OPTIONS);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  const loadAppointments = useCallback(async () => {
    setListError(null);
    try {
      const { appointments } = await api.listAppointments();
      setAppointments(appointments);
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : 'Could not load appointments.');
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadAppointments();
    api.getOptions().then(setOptions).catch(() => undefined); // defaults are fine if this fails
  }, [user, loadAppointments]);

  async function cancelAppointment(id: string) {
    await api.cancelAppointment(id);
    await loadAppointments();
  }

  async function rescheduleAppointment(id: string, values: { date: string; time: string }) {
    await api.rescheduleAppointment(id, values);
    await loadAppointments();
  }

  if (loading || !user) {
    return <div className="center-screen"><span className="spinner" aria-label="Loading" /></div>;
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark small" aria-hidden>BS</span> Bright Smile Dental</div>
          <div className="topbar-user">
            <span className="muted">{user.fullName}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => { logout(); router.replace('/login'); }}>Log out</button>
          </div>
        </div>
      </header>

      <main className="container">
        <div className="grid">
          <ChatWidget options={options} onBooked={loadAppointments} />
          <AppointmentList
            appointments={appointments}
            loading={listLoading}
            error={listError}
            options={options}
            onCancel={cancelAppointment}
            onReschedule={rescheduleAppointment}
            onRetry={loadAppointments}
          />
        </div>
      </main>
    </>
  );
}
