import type {
  Appointment,
  BookingOptions,
  ChatAction,
  ChatReply,
  Draft,
  Role,
  SessionView,
  StaffAppointment,
  TeamUser,
  User,
} from './types';

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const TOKEN_KEY = 'auth_token';

export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns a failed HTTP response into an ApiError (and tells the app when the session has expired). */
async function failFrom(res: Response, token: string | null): Promise<never> {
  const payload = await res.json().catch(() => null);
  const err = payload?.error;
  if (res.status === 401 && token && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('auth:expired'));
  }
  throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Something went wrong.', err?.details);
}

const NETWORK_ERROR = () =>
  new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw NETWORK_ERROR();
  }
  if (!res.ok) return failFrom(res, token);
  return res.json() as Promise<T>;
}

/**
 * Sends a chat message and reads the reply as a server-sent-event stream.
 * `onDelta` receives pieces of the reply as they are written; the returned value is the authoritative result.
 */
async function streamMessage(
  body: { sessionId?: string; message: string },
  onDelta: (text: string) => void,
): Promise<ChatReply> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/chat/messages/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw NETWORK_ERROR();
  }
  if (!res.ok) return failFrom(res, token);
  if (!res.body) throw new ApiError(0, 'STREAM_UNSUPPORTED', 'Streaming is not supported by this browser.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: ChatReply | null = null;

  const handleEvent = (block: string) => {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === 'delta') onDelta(event.text as string);
    else if (event.type === 'final') final = event as ChatReply;
    else if (event.type === 'error') throw new ApiError(500, event.code, event.message);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      blocks.forEach(handleEvent);
    }
    if (buffer.trim()) handleEvent(buffer);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'STREAM_INTERRUPTED', 'The connection was interrupted. Please try again.');
  }

  if (!final) throw new ApiError(0, 'STREAM_INTERRUPTED', 'The connection was interrupted. Please try again.');
  return final;
}

export const api = {
  signup: (b: { fullName: string; email: string; password: string }) =>
    request<{ user: User; token: string }>('/api/auth/signup', { method: 'POST', body: b }),
  login: (b: { email: string; password: string }) =>
    request<{ user: User; token: string }>('/api/auth/login', { method: 'POST', body: b }),
  me: () => request<{ user: User }>('/api/auth/me'),

  getOptions: () => request<BookingOptions>('/api/appointments/options'),
  listAppointments: () => request<{ appointments: Appointment[] }>('/api/appointments'),
  createAppointment: (b: { service: string; date: string; time: string; notes?: string; sessionId?: string }) =>
    request<{ appointment: Appointment }>('/api/appointments', { method: 'POST', body: b }),
  rescheduleAppointment: (id: string, b: { date: string; time: string }) =>
    request<{ appointment: Appointment }>(`/api/appointments/${id}`, { method: 'PATCH', body: b }),
  cancelAppointment: (id: string) =>
    request<{ appointment: Appointment }>(`/api/appointments/${id}/cancel`, { method: 'PATCH' }),

  // staff and admin
  staffAppointments: (when: 'upcoming' | 'past' | 'all' = 'upcoming') =>
    request<{ appointments: StaffAppointment[] }>(`/api/staff/appointments?when=${when}`),
  staffCancel: (id: string) =>
    request<{ appointment: Appointment }>(`/api/staff/appointments/${id}/cancel`, { method: 'PATCH' }),
  adminUsers: () => request<{ users: TeamUser[] }>('/api/admin/users'),
  adminSetRole: (id: string, role: Role) =>
    request<{ user: TeamUser }>(`/api/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),

  sendMessage: (b: { sessionId?: string; message: string }) =>
    request<ChatReply>('/api/chat/messages', { method: 'POST', body: b }),
  streamMessage,
  getSession: (id: string) => request<SessionView>(`/api/chat/sessions/${id}`),
  confirmSession: (id: string) =>
    request<{ action: ChatAction; appointment: Appointment }>(`/api/chat/sessions/${id}/confirm`, { method: 'POST' }),
};

export type { Draft };
