import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';
import { AiError, ChatTurn, extractBooking } from './aiService';
import { createAppointment, isSlotFree } from './appointmentService';
import { buildSlot, formatSlot, SERVICES } from './bookingRules';
import { getBusiness } from './businessService';

interface Actor {
  id: string;
  businessId: string;
}

export interface Draft {
  service?: string;
  date?: string;
  time?: string;
  notes?: string;
}

const REQUIRED: (keyof Draft)[] = ['service', 'date', 'time'];
const MAX_HISTORY = 12; // only the last N messages are sent to the model (bounded cost + context)
const FORM_AFTER_USER_TURNS = 4; // still incomplete after this many user messages -> offer the form
const AI_DOWN_MESSAGE =
  "I'm having trouble understanding requests right now. Please use the booking form below instead.";

// ---------- draft helpers ----------

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

const mergeDraft = (draft: Draft, extracted: Draft): Draft => ({ ...draft, ...extracted });
const missingFields = (d: Draft) => REQUIRED.filter((k) => !d[k]);

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

// ---------- public API ----------

export async function handleMessage(actor: Actor, input: { sessionId?: string; message: string }) {
  const business = await getBusiness(actor.businessId);
  const session = input.sessionId ? await loadSession(actor, input.sessionId) : await createSession(actor);
  if (session.status !== 'active') {
    throw new AppError(409, 'SESSION_CLOSED', 'This conversation is finished. Start a new one to book another appointment.');
  }

  await insertMessage(session.id, 'user', input.message);
  const history = await recentHistory(session.id);

  let draft: Draft = session.draft ?? {};
  let reply: string;
  let aiFailed = false;

  // 1) AI: extract details + draft a reply
  try {
    const ai = await extractBooking({
      businessId: actor.businessId,
      sessionId: session.id,
      businessName: business.name,
      timezone: business.timezone,
      draft,
      history,
    });
    draft = mergeDraft(draft, normalizeExtracted(ai.extracted));
    reply = ai.reply;
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    aiFailed = true;
    reply = AI_DOWN_MESSAGE;
  }

  // 2) Business logic decides: is it complete, valid and free? The model's opinion is advisory only.
  let missing = missingFields(draft);
  let readyToConfirm = false;
  let summary: string | null = null;

  if (!aiFailed && missing.length === 0) {
    try {
      const slot = buildSlot(draft.date!, draft.time!, business.timezone);
      if (await isSlotFree(actor.businessId, slot.startsAt, slot.endsAt)) {
        summary = `${draft.service} on ${formatSlot(slot.startsAt, business.timezone)}`;
        reply = `I have you down for ${summary}. Please confirm to book it.`;
        readyToConfirm = true;
      } else {
        reply = `Sorry, ${formatSlot(slot.startsAt, business.timezone)} is already taken. What other time works for you?`;
        delete draft.time;
        missing = missingFields(draft);
      }
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'INVALID_SLOT') throw err;
      reply = err.message;
      const field = (err.details as { field?: 'date' | 'time' } | undefined)?.field ?? 'time';
      delete draft[field];
      missing = missingFields(draft);
    }
  }

  // 3) Fallback: AI down, or the conversation isn't converging -> hand over to the form
  const userTurns = history.filter((m) => m.role === 'user').length;
  const needsForm = aiFailed || (!readyToConfirm && userTurns >= FORM_AFTER_USER_TURNS);

  await insertMessage(session.id, 'assistant', reply);
  await saveDraft(session.id, draft);

  return { sessionId: session.id, reply, draft, missing, readyToConfirm, summary, needsForm };
}

export async function getSession(actor: Actor, sessionId: string) {
  const session = await loadSession(actor, sessionId);
  const { rows } = await pool.query(
    `SELECT id, role, content, created_at FROM chat_messages
     WHERE session_id = $1 ORDER BY id ASC LIMIT 200`,
    [sessionId],
  );
  const missing = missingFields(session.draft ?? {});
  return {
    session: { id: session.id, status: session.status, draft: session.draft, missing, readyToConfirm: session.status === 'active' && missing.length === 0 },
    messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: (m.created_at as Date).toISOString() })),
  };
}

/** Only an explicit user confirmation creates the appointment. The AI can never book by itself. */
export async function confirmBooking(actor: Actor, sessionId: string) {
  const session = await loadSession(actor, sessionId);
  if (session.status !== 'active') throw new AppError(409, 'SESSION_CLOSED', 'This conversation is already finished.');

  const draft = session.draft ?? {};
  if (missingFields(draft).length > 0) {
    throw new AppError(422, 'INCOMPLETE_BOOKING', 'Some booking details are still missing.', { missing: missingFields(draft) });
  }

  const appointment = await createAppointment(
    actor,
    { service: draft.service as (typeof SERVICES)[number], date: draft.date!, time: draft.time!, notes: draft.notes, sessionId },
    'chat',
  );
  await insertMessage(sessionId, 'assistant', 'All set! Your appointment is confirmed.');
  return appointment;
}
