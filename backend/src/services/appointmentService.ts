import { pool } from '../db/pool';
import { CreateAppointmentInput } from '../schemas';
import { AppError } from '../utils/AppError';
import { getBusiness } from './businessService';
import { buildSlot } from './bookingRules';

interface Actor {
  id: string;
  businessId: string;
}

const COLUMNS = 'id, service, starts_at, ends_at, status, notes, created_via';

const toApi = (r: any) => ({
  id: r.id as string,
  service: r.service as string,
  startsAt: (r.starts_at as Date).toISOString(),
  endsAt: (r.ends_at as Date).toISOString(),
  status: r.status as string,
  notes: (r.notes as string | null) ?? null,
  createdVia: r.created_via as string,
});

export async function createAppointment(actor: Actor, input: CreateAppointmentInput, via: 'chat' | 'form') {
  const business = await getBusiness(actor.businessId);
  const { startsAt, endsAt } = buildSlot(input.date, input.time, business.timezone);

  // The subselect only links the chat session if it belongs to this user.
  // Double-booking is prevented by the DB exclusion constraint (-> 409 SLOT_TAKEN in errorHandler).
  const { rows } = await pool.query(
    `INSERT INTO appointments
       (business_id, user_id, chat_session_id, service, starts_at, ends_at, status, notes, created_via)
     VALUES ($1, $2, (SELECT id FROM chat_sessions WHERE id = $3::uuid AND user_id = $2),
             $4, $5, $6, 'confirmed', $7, $8)
     RETURNING ${COLUMNS}`,
    [actor.businessId, actor.id, input.sessionId ?? null, input.service, startsAt, endsAt, input.notes ?? null, via],
  );

  if (input.sessionId) {
    await pool.query(`UPDATE chat_sessions SET status = 'completed' WHERE id = $1 AND user_id = $2`, [
      input.sessionId,
      actor.id,
    ]);
  }
  return toApi(rows[0]);
}

export async function listAppointments(actor: Actor, status?: string) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM appointments
     WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY starts_at DESC LIMIT 50`,
    [actor.id, status ?? null],
  );
  return rows.map(toApi);
}

export async function cancelAppointment(actor: Actor, id: string) {
  const { rows } = await pool.query(
    `UPDATE appointments SET status = 'cancelled'
     WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'confirmed')
     RETURNING ${COLUMNS}`,
    [id, actor.id],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Appointment not found or already cancelled');
  return toApi(rows[0]);
}

/** Moves an upcoming appointment to a new date/time (same duration). */
export async function rescheduleAppointment(actor: Actor, id: string, input: { date: string; time: string }) {
  const { rows: current } = await pool.query(
    'SELECT starts_at, ends_at, status FROM appointments WHERE id = $1 AND user_id = $2',
    [id, actor.id],
  );
  const appt = current[0];
  if (!appt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
  if (!['pending', 'confirmed'].includes(appt.status) || (appt.ends_at as Date).getTime() < Date.now()) {
    throw new AppError(409, 'NOT_RESCHEDULABLE', 'This appointment can no longer be changed.');
  }

  const business = await getBusiness(actor.businessId);
  const durationMin = Math.round(((appt.ends_at as Date).getTime() - (appt.starts_at as Date).getTime()) / 60_000);
  const { startsAt, endsAt } = buildSlot(input.date, input.time, business.timezone, durationMin);

  // The exclusion constraint rejects overlaps with OTHER bookings (-> 409 SLOT_TAKEN in errorHandler).
  const { rows } = await pool.query(
    `UPDATE appointments SET starts_at = $3, ends_at = $4
     WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'confirmed')
     RETURNING ${COLUMNS}`,
    [id, actor.id, startsAt, endsAt],
  );
  if (!rows[0]) throw new AppError(409, 'NOT_RESCHEDULABLE', 'This appointment can no longer be changed.');
  return toApi(rows[0]);
}

export async function isSlotFree(businessId: string, startsAt: Date, endsAt: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM appointments
     WHERE business_id = $1 AND status <> 'cancelled'
       AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
     LIMIT 1`,
    [businessId, startsAt, endsAt],
  );
  return rowCount === 0;
}
