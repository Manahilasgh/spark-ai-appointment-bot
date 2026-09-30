'use client';

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Appointment, BookingOptions, ChatAction, Draft } from '@/lib/types';
import { Typewriter } from '@/lib/typewriter';
import AppointmentForm from './AppointmentForm';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  streaming?: boolean; // reply is still being written
}

const SESSION_KEY = 'chat_session_id';
const uid = () => Math.random().toString(36).slice(2);
const GREETING: Msg = {
  id: 'greeting',
  role: 'assistant',
  content:
    "Hi! I can book, reschedule or cancel appointments. Tell me what you need, for example: 'Book a check-up tomorrow at 3pm'.",
};
const SUGGESTIONS = [
  'Book a check-up tomorrow at 3pm',
  'I need a teeth cleaning next Monday morning',
  'Reschedule my appointment to Friday at 11am',
  'Cancel my next appointment',
];
const CONFIRM_LABEL: Record<ChatAction, string> = {
  book: 'Confirm booking',
  reschedule: 'Confirm new time',
  cancel: 'Confirm cancellation',
};

export default function ChatWidget({ options, onBooked }: { options: BookingOptions; onBooked: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false); // true once the first words of a reply have arrived
  const [confirming, setConfirming] = useState(false);
  const [ready, setReady] = useState(false);
  const [action, setAction] = useState<ChatAction>('book');
  const [draft, setDraft] = useState<Draft>({});
  const [showForm, setShowForm] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const addMsg = useCallback((role: Msg['role'], content: string, error = false) => {
    setMessages((m) => [...m, { id: uid(), role, content, error }]);
  }, []);

  const resetChat = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY);
    setSessionId(null);
    setDraft({});
    setAction('book');
    setReady(false);
    setShowForm(false);
    setInput('');
  }, []);

  // Resume an unfinished conversation after a page reload
  useEffect(() => {
    const id = window.localStorage.getItem(SESSION_KEY);
    if (!id) return;
    let cancelled = false;
    api
      .getSession(id)
      .then(({ session, messages: stored }) => {
        if (cancelled) return;
        if (session.status !== 'active') return window.localStorage.removeItem(SESSION_KEY);
        setSessionId(id);
        setDraft(session.draft ?? {});
        setAction(session.action ?? 'book');
        setReady(session.readyToConfirm);
        setMessages([
          GREETING,
          ...stored
            .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role !== 'system')
            .map((m) => ({ id: `s${m.id}`, role: m.role, content: m.content })),
        ]);
      })
      .catch(() => window.localStorage.removeItem(SESSION_KEY));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: sending ? 'auto' : 'smooth', block: 'end' });
  }, [messages, sending, showForm]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    addMsg('user', content);
    setInput('');
    setSending(true);
    setReady(false);

    const replyId = uid();
    let started = false;
    // Incoming text is revealed at a steady pace, so bursty chunks from the provider still read as a stream
    const typer = new Typewriter((piece) =>
      setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: x.content + piece } : x))),
    );
    const appendDelta = (piece: string) => {
      if (!started) {
        started = true;
        setStreaming(true);
        setMessages((m) => [...m, { id: replyId, role: 'assistant', content: '', streaming: true }]);
      }
      typer.push(piece);
    };

    try {
      const res = await api.streamMessage({ sessionId: sessionId ?? undefined, message: content }, appendDelta);
      await typer.drain(); // let the reveal finish before swapping in the authoritative text
      setSessionId(res.sessionId);
      window.localStorage.setItem(SESSION_KEY, res.sessionId);
      // The final text is authoritative: validation may have changed what the assistant should say
      setMessages((m) =>
        started
          ? m.map((x) => (x.id === replyId ? { ...x, content: res.reply, streaming: false } : x))
          : [...m, { id: replyId, role: 'assistant', content: res.reply }],
      );
      setDraft(res.draft);
      setAction(res.action ?? 'book');
      setReady(res.readyToConfirm);
      if (res.needsForm) setShowForm(true); // fallback: AI down or conversation not converging
    } catch (err) {
      typer.cancel();
      setMessages((m) => m.filter((x) => x.id !== replyId)); // drop any half-written reply
      if (err instanceof ApiError && err.code === 'SESSION_CLOSED') {
        resetChat();
        addMsg('assistant', 'That conversation has finished. Please send your request again to start a new one.', true);
      } else {
        addMsg('assistant', err instanceof ApiError ? err.message : 'Something went wrong. Please try again.', true);
        setInput(content); // give the text back so the user can resend
      }
    } finally {
      setSending(false);
      setStreaming(false);
    }
  }

  async function confirm() {
    if (!sessionId || confirming) return;
    setConfirming(true);
    try {
      const result = await api.confirmSession(sessionId);
      finishAction(result.action, result.appointment);
    } catch (err) {
      addMsg('assistant', err instanceof ApiError ? err.message : 'Could not complete that. Please try again.', true);
      if (err instanceof ApiError && ['SLOT_TAKEN', 'INVALID_SLOT', 'NOT_FOUND', 'NOT_RESCHEDULABLE'].includes(err.code)) {
        setReady(false);
        onBooked(); // the list may be out of date
      }
    } finally {
      setConfirming(false);
    }
  }

  function finishAction(kind: ChatAction, a: Appointment) {
    const when = new Date(a.startsAt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: options.timezone,
    });
    if (kind === 'cancel') addMsg('assistant', `Your ${a.service} appointment on ${when} has been cancelled. Anything else?`);
    else if (kind === 'reschedule') addMsg('assistant', `Done! Your ${a.service} is now on ${when}.`);
    else addMsg('assistant', `You're all set: ${a.service} on ${when}. Need another appointment? Just tell me.`);
    resetChat();
    onBooked();
  }

  function declineAction() {
    if (action === 'cancel') {
      resetChat();
      addMsg('assistant', 'No problem, I left your appointment as it is.');
    } else {
      setReady(false);
      addMsg('assistant', 'No problem. What would you like to change?');
    }
  }

  function newChat() {
    resetChat();
    setMessages([GREETING]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <section className="card chat-card" aria-labelledby="chat-title">
      <div className="card-head">
        <div>
          <h2 id="chat-title">Booking assistant</h2>
          <p className="muted small">Book, reschedule or cancel in your own words.</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Back to chat' : 'Use form instead'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={newChat} disabled={sending}>New chat</button>
        </div>
      </div>

      {showForm ? (
        <div className="chat-body">
          <p className="muted small">
            {draft.service || draft.date || draft.time
              ? "I've filled in what I understood so far. Please complete the rest."
              : 'Fill in the details below.'}
          </p>
          <AppointmentForm
            options={options}
            initial={draft}
            sessionId={sessionId}
            onCreated={(a) => finishAction('book', a)}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : (
        <>
          <div className="chat-body" role="log" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}${m.error ? ' error' : ''}${m.streaming ? ' streaming' : ''}`}>{m.content}</div>
            ))}
            {sending && !streaming && (
              <div className="msg assistant typing" aria-label="Assistant is typing">
                <span /><span /><span />
              </div>
            )}
            {messages.length === 1 && !sending && (
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {ready && (
            <div className="confirm-bar">
              <button className="btn btn-primary" onClick={confirm} disabled={confirming}>
                {confirming ? 'Working...' : CONFIRM_LABEL[action]}
              </button>
              <button className="btn btn-ghost" onClick={declineAction} disabled={confirming}>
                {action === 'cancel' ? 'Keep it' : 'Change details'}
              </button>
            </div>
          )}

          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type your message..."
              rows={1}
              maxLength={1000}
              aria-label="Message"
              disabled={sending}
            />
            <button className="btn btn-primary" onClick={() => send(input)} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        </>
      )}
    </section>
  );
}
