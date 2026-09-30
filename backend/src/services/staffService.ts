import { pool } from '../db/pool';
import { StaffAppointmentsQuery } from '../schemas';
import { AppError } from '../utils/AppError';

interface Actor {
  id: string;
  businessId: string;
}

const toAppointment = (r: any) => ({
  id: r.id as string,
  service: r.service as string,
  startsAt: (r.starts_at as Date).toISOString(),
  endsAt: (r.ends_at as Date).toISOString(),
  status: r.status as string,
  notes: (r.notes as string | null) ?? null,
  createdVia: r.created_via as string,
});

const toUser = (r: any) => ({
  id: r.id as string,
  email: r.email as string,
  fullName: r.full_name as string,
  role: r.role as string,
  createdAt: (r.created_at as Date).toISOString(),
});

/** Every appointment in the actor's business, with the customer's name. Staff and admin only. */
export async function listBusinessAppointments(actor: Actor, query: StaffAppointmentsQuery) {
  const order = query.when === 'past' ? 'DESC' : 'ASC'; // chosen from a validated enum, never from raw input
  const { rows } = await pool.query(
    `SELECT a.id, a.service, a.starts_at, a.ends_at, a.status, a.notes, a.created_via,
            u.full_name AS customer_name, u.email AS customer_email
     FROM appointments a
     JOIN users u ON u.id = a.user_id
     WHERE a.business_id = $1
       AND ($2::text = 'all'
            OR ($2::text = 'upcoming' AND a.ends_at > now())
            OR ($2::text = 'past' AND a.ends_at <= now()))
       AND ($3::text IS NULL OR a.status = $3::text)
     ORDER BY a.starts_at ${order}
     LIMIT 200`,
    [actor.businessId, query.when, query.status ?? null],
  );
  return rows.map((r) => ({ ...toAppointment(r), customer: { name: r.customer_name as string, email: r.customer_email as string } }));
}

/** Staff can cancel any appointment in their own business (customers can only cancel their own). */
export async function cancelBusinessAppointment(actor: Actor, appointmentId: string) {
  const { rows } = await pool.query(
    `UPDATE appointments SET status = 'cancelled'
     WHERE id = $1 AND business_id = $2 AND status IN ('pending', 'confirmed')
     RETURNING id, service, starts_at, ends_at, status, notes, created_via`,
    [appointmentId, actor.businessId],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Appointment not found or already cancelled');
  return toAppointment(rows[0]);
}

/** Admin only: everyone in the business. */
export async function listUsers(actor: Actor) {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, created_at FROM users WHERE business_id = $1 ORDER BY created_at DESC LIMIT 200',
    [actor.businessId],
  );
  return rows.map(toUser);
}

/** Admin only: promote or demote someone in the same business. Admins cannot change their own role (avoids lockout). */
export async function setUserRole(actor: Actor, userId: string, role: string) {
  if (userId === actor.id) {
    throw new AppError(409, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
  }
  const { rows } = await pool.query(
    `UPDATE users SET role = $3 WHERE id = $1 AND business_id = $2
     RETURNING id, email, full_name, role, created_at`,
    [userId, actor.businessId, role],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return toUser(rows[0]);
}
