import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';
import { AiError, AiResult, ChatTurn, extractBooking } from './aiService';
import {
  cancelAppointment,
  createAppointment,
  isSlotFree,
  listUpcoming,
  rescheduleAppointment,
  UpcomingAppointment,
} from './appointmentService';
import { buildSlot, formatSlot, SERVICES } from './bookingRules';
import { getBusiness } from './businessService';

interface Actor {
  id: string;
  businessId: string;
}

export type Action = 'book' | 'cancel' | 'reschedule';

/** Conversation state ("memory") persisted in chat_sessions.draft_booking. */
export interface Draft {
  action?: Action;
  service?: string;
  date?: string;
  time?: string;
  notes?: string;
  appointmentId?: string; // target of a cancel / reschedule
}

// What must be known before the user can be asked to confirm each kind of action
const REQUIRED: Record<Action, (keyof Draft)[]> = {
  book: ['service', 'date', 'time'],
  cancel: ['appointmentId'],
  reschedule: ['appointmentId', 'date', 'time'],
};

const MAX_HISTORY = 12; // only the last N messages are sent to the model (bounded cost + context)
const FORM_AFTER_USER_TURNS = 4; // still not converging after this many user messages -> offer the form
const AI_DOWN_BOOK =
  "I'm having trouble understanding requests right now. Please use the booking form below instead, or the Reschedule and Cancel buttons in your appointments list to change an existing booking.";
const AI_DOWN_CHANGE =
  "I'm having trouble understanding requests right now. Please use the Reschedule or Cancel buttons in your appointments list instead.";

// ---------- draft helpers ----------

const actionOf = (d: Draft): Action => d.action ?? 'book';
const missingFields = (d: Draft) => REQUIRED[actionOf(d)].filter((k) => !d[k]);

/** Never trust raw model output: coerce it into valid values or drop it. */
function normalizeExtracted(raw: Record<string, string | null | undefined>): Draft {
  const out: Draft = {};
  const service = SERVICES.find((s) => s.toLowerCase() === raw.service?.trim().toLowerCase());
  if (service) out.service = service;

  if (raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())) out.date = raw.date.trim();

  const t = raw.time?.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (t && +t[1] < 24 && +t[2] < 60) out.time = `${t[1].padStart(2, '0')}:${t[2]}`;

  if (raw.notes?.trim()) out.notes = raw.notes.trim().slice(0, 500);
  return out;
}

/**
 * Combines the model's suggested intent/details with the existing draft.
 * The model only PROPOSES; this function and the checks in handleMessage decide what is kept.
 */
function applyIntent(
  prev: Draft,
  intent: AiResult['intent'],
  ref: unknown,
  extracted: Draft,
  upcoming: UpcomingAppointment[],
): Draft {
  let next: Draft;
  if (intent === 'other') next = { ...prev };
  else if (actionOf(prev) === intent) next = { ...prev, action: intent }; // same flow continues
  else next = { action: intent }; // user switched goal: start fresh

  const action = actionOf(next);
  if (action === 'book') {
    next = { ...next, ...extracted };
  } else if (action === 'reschedule') {
    if (extracted.date) next.date = extracted.date;
    if (extracted.time) next.time = extracted.time;
  }

  if (action !== 'book') {
    // Resolve which existing appointment the user means (numbers refer to the list given to the model)
    const n = Number(ref);
    if (Number.isInteger(n) && n >= 1 && n <= upcoming.length) next.appointmentId = upcoming[n - 1].id;
    if (next.appointmentId && !upcoming.some((a) => a.id === next.appointmentId)) delete next.appointmentId;
    if (!next.appointmentId && upcoming.length === 1) next.appointmentId = upcoming[0].id;
  }
  return next;
}

// ---------- persistence ----------

async function createSession(actor: Actor) {
  const { rows } = await pool.query(
    'INSERT INTO chat_sessions (business_id, user_id) VALUES ($1, $2) RETURNING id, status, draft_booking',
    [actor.businessId, actor.id],
  );
  return { id: rows[0].id as string, status: rows[0].status as string, draft: rows[0].draft_booking as Draft };
}

async function loadSession(actor: Actor, sessionId: string) {
  const { rows } = await pool.query(
    'SELECT id, status, draft_booking FROM chat_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, actor.id],
  );
  if (!rows[0]) throw new AppError(404, 'SESSION_NOT_FOUND', 'Chat session not found');
  return { id: rows[0].id as string, status: rows[0].status as string, draft: rows[0].draft_booking as Draft };
}

const insertMessage = (sessionId: string, role: 'user' | 'assistant', content: string) =>
  pool.query('INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)', [sessionId, role, content]);

async function recentHistory(sessionId: string): Promise<ChatTurn[]> {
  const { rows } = await pool.query(
    `SELECT role, content FROM (
       SELECT id, role, content FROM chat_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id DESC LIMIT $2
     ) t ORDER BY id ASC`,
    [sessionId, MAX_HISTORY],
  );
  return rows as ChatTurn[];
}

const saveDraft = (sessionId: string, draft: Draft) =>
  pool.query('UPDATE chat_sessions SET draft_booking = $2 WHERE id = $1', [sessionId, JSON.stringify(draft)]);

const completeSession = (sessionId: string) =>
  pool.query(`UPDATE chat_sessions SET status = 'completed' WHERE id = $1`, [sessionId]);

// ---------- public API ----------

export async function handleMessage(
  actor: Actor,
  input: { sessionId?: string; message: string },
  onDelta?: (text: string) => void, // when set, the AI reply is streamed as it is generated
) {
  const business = await getBusiness(actor.businessId);
  const tz = business.timezone;
  const session = input.sessionId ? await loadSession(actor, input.sessionId) : await createSession(actor);
  if (session.status !== 'active') {
    throw new AppError(409, 'SESSION_CLOSED', 'This conversation is finished. Start a new one to continue.');
  }

  await insertMessage(session.id, 'user', input.message);
  const [history, upcoming] = await Promise.all([recentHistory(session.id), listUpcoming(actor)]);

  let draft: Draft = session.draft ?? {};
  let reply: string;
  let aiFailed = false;

  // 1) AI: work out the intent, extract details, draft a reply
  try {
    const ai = await extractBooking({
      businessId: actor.businessId,
      sessionId: session.id,
      businessName: business.name,
      timezone: tz,
      draft,
      appointments: upcoming.map((a, i) => ({ ref: i + 1, label: `${a.service}, ${formatSlot(a.startsAt, tz)}` })),
      history,
    }, onDelta);
    draft = applyIntent(draft, ai.intent, ai.appointmentRef, normalizeExtracted(ai.extracted), upcoming);
    reply = ai.reply;
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    aiFailed = true;
    reply = actionOf(draft) === 'book' ? AI_DOWN_BOOK : AI_DOWN_CHANGE;
  }

  // 2) Business logic decides: is it complete, valid and available? The model's opinion is advisory only.
  let missing = missingFields(draft);
  let readyToConfirm = false;
  let summary: string | null = null;

  if (!aiFailed) {
    const action = actionOf(draft);
    const target = draft.appointmentId ? upcoming.find((a) => a.id === draft.appointmentId) : undefined;

    if (action !== 'book' && upcoming.length === 0) {
      reply =
        action === 'cancel'
          ? "You don't have any upcoming appointments to cancel."
          : "You don't have any upcoming appointments to reschedule. Would you like to book one?";
      draft = {};
      missing = missingFields(draft);
    } else if (action !== 'book' && !target) {
      reply = `Which appointment do you mean?\n${upcoming
        .map((a, i) => `${i + 1}) ${a.service}, ${formatSlot(a.startsAt, tz)}`)
        .join('\n')}`;
    } else if (missing.length === 0) {
      try {
        if (action === 'cancel' && target) {
          summary = `${target.service} on ${formatSlot(target.startsAt, tz)}`;
          reply = `Do you want me to cancel your ${summary}? Please confirm.`;
          readyToConfirm = true;
        } else {
          const durationMin = target
            ? Math.round((target.endsAt.getTime() - target.startsAt.getTime()) / 60_000)
            : undefined;
          const slot = buildSlot(draft.date!, draft.time!, tz, durationMin);

          if (action === 'reschedule' && target && slot.startsAt.getTime() === target.startsAt.getTime()) {
            reply = 'That is already the time of your appointment. What new date and time would you like?';
            delete draft.date;
            delete draft.time;
            missing = missingFields(draft);
          } else if (!(await isSlotFree(actor.businessId, slot.startsAt, slot.endsAt, target?.id))) {
            reply = `Sorry, ${formatSlot(slot.startsAt, tz)} is already taken. What other time works for you?`;
            delete draft.time;
            missing = missingFields(draft);
          } else if (action === 'reschedule' && target) {
            summary = `${target.service}: ${formatSlot(target.startsAt, tz)} to ${formatSlot(slot.startsAt, tz)}`;
            reply = `I'll move your ${target.service} from ${formatSlot(target.startsAt, tz)} to ${formatSlot(slot.startsAt, tz)}. Please confirm.`;
            readyToConfirm = true;
          } else {
            summary = `${draft.service} on ${formatSlot(slot.startsAt, tz)}`;
            reply = `I have you down for ${summary}. Please confirm to book it.`;
            readyToConfirm = true;
          }
        }
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'INVALID_SLOT') throw err;
        reply = err.message;
        const field = (err.details as { field?: 'date' | 'time' } | undefined)?.field ?? 'time';
        delete draft[field];
        missing = missingFields(draft);
      }
    }
  }

  // 3) Fallback: for new bookings, hand over to the form if the AI is down or the chat isn't converging
  const userTurns = history.filter((m) => m.role === 'user').length;
  const finalAction = actionOf(draft);
  const needsForm =
    finalAction === 'book' && (aiFailed || (!readyToConfirm && userTurns >= FORM_AFTER_USER_TURNS));

  await insertMessage(session.id, 'assistant', reply);
  await saveDraft(session.id, draft);

  return { sessionId: session.id, reply, draft, action: finalAction, missing, readyToConfirm, summary, needsForm };
}

export async function getSession(actor: Actor, sessionId: string) {
  const session = await loadSession(actor, sessionId);
  const { rows } = await pool.query(
    `SELECT id, role, content, created_at FROM chat_messages
     WHERE session_id = $1 ORDER BY id ASC LIMIT 200`,
    [sessionId],
  );
  const draft = session.draft ?? {};
  const missing = missingFields(draft);
  return {
    session: {
      id: session.id,
      status: session.status,
      draft,
      action: actionOf(draft),
      missing,
      readyToConfirm: session.status === 'active' && missing.length === 0,
    },
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: (m.created_at as Date).toISOString(),
    })),
  };
}

/**
 * Only an explicit user confirmation changes anything. The AI can never book, move or cancel by itself.
 */
export async function confirmBooking(actor: Actor, sessionId: string) {
  const session = await loadSession(actor, sessionId);
  if (session.status !== 'active') throw new AppError(409, 'SESSION_CLOSED', 'This conversation is already finished.');

  const draft = session.draft ?? {};
  const action = actionOf(draft);
  const missing = missingFields(draft);
  if (missing.length > 0) {
    throw new AppError(422, 'INCOMPLETE_BOOKING', 'Some details are still missing.', { missing });
  }

  if (action === 'cancel') {
    const appointment = await cancelAppointment(actor, draft.appointmentId!);
    await completeSession(sessionId);
    await insertMessage(sessionId, 'assistant', 'Your appointment has been cancelled.');
    return { action, appointment };
  }

  if (action === 'reschedule') {
    const appointment = await rescheduleAppointment(actor, draft.appointmentId!, {
      date: draft.date!,
      time: draft.time!,
    });
    await completeSession(sessionId);
    await insertMessage(sessionId, 'assistant', 'Your appointment has been rescheduled.');
    return { action, appointment };
  }

  const appointment = await createAppointment(
    actor,
    { service: draft.service as (typeof SERVICES)[number], date: draft.date!, time: draft.time!, notes: draft.notes, sessionId },
    'chat',
  );
  await insertMessage(sessionId, 'assistant', 'All set! Your appointment is confirmed.');
  return { action, appointment };
}
