'use client';

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Appointment, BookingOptions, Draft } from '@/lib/types';
import AppointmentForm from './AppointmentForm';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

const SESSION_KEY = 'chat_session_id';
const uid = () => Math.random().toString(36).slice(2);
const GREETING: Msg = {
  id: 'greeting',
  role: 'assistant',
  content: "Hi! I can book your appointment. Tell me what you need, for example: 'Book a check-up tomorrow at 3pm'.",
};
const SUGGESTIONS = ['Book a check-up tomorrow at 3pm', 'I need a teeth cleaning next Monday morning', 'Consultation on Friday at 11am'];

export default function ChatWidget({ options, onBooked }: { options: BookingOptions; onBooked: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ready, setReady] = useState(false);
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending, showForm]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    addMsg('user', content);
    setInput('');
    setSending(true);
    setReady(false);
    try {
      const res = await api.sendMessage({ sessionId: sessionId ?? undefined, message: content });
      setSessionId(res.sessionId);
      window.localStorage.setItem(SESSION_KEY, res.sessionId);
      addMsg('assistant', res.reply);
      setDraft(res.draft);
      setReady(res.readyToConfirm);
      if (res.needsForm) setShowForm(true); // fallback: AI down or conversation not converging
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SESSION_CLOSED') {
        resetChat();
        addMsg('assistant', 'That conversation has finished. Please send your request again to start a new one.', true);
      } else {
        addMsg('assistant', err instanceof ApiError ? err.message : 'Something went wrong. Please try again.', true);
        setInput(content); // give the text back so the user can resend
      }
    } finally {
      setSending(false);
    }
  }

  async function confirm() {
    if (!sessionId || confirming) return;
    setConfirming(true);
    try {
      const { appointment } = await api.confirmSession(sessionId);
      finishBooking(appointment);
    } catch (err) {
      addMsg('assistant', err instanceof ApiError ? err.message : 'Could not confirm the booking. Please try again.', true);
      if (err instanceof ApiError && (err.code === 'SLOT_TAKEN' || err.code === 'INVALID_SLOT')) setReady(false);
    } finally {
      setConfirming(false);
    }
  }

  function finishBooking(a: Appointment) {
    const when = new Date(a.startsAt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: options.timezone,
    });
    addMsg('assistant', `You're all set: ${a.service} on ${when}. Need another appointment? Just tell me.`);
    resetChat();
    onBooked();
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
          <p className="muted small">Describe the appointment you want in your own words.</p>
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
            {Object.keys(draft).length > 0 ? "I've filled in what I understood so far. Please complete the rest." : 'Fill in the details below.'}
          </p>
          <AppointmentForm
            options={options}
            initial={draft}
            sessionId={sessionId}
            onCreated={finishBooking}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : (
        <>
          <div className="chat-body" role="log" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}${m.error ? ' error' : ''}`}>{m.content}</div>
            ))}
            {sending && (
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
                {confirming ? 'Booking...' : 'Confirm booking'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setReady(false); addMsg('assistant', 'No problem. What would you like to change?'); }} disabled={confirming}>
                Change details
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
