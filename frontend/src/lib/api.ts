import type { Appointment, BookingOptions, ChatReply, Draft, SessionView, User } from './types';

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
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const err = payload?.error;
    // A rejected token on a protected call means the session expired: tell the AuthProvider.
    if (res.status === 401 && token && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('auth:expired'));
    }
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Something went wrong.', err?.details);
  }
  return res.json() as Promise<T>;
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
  cancelAppointment: (id: string) =>
    request<{ appointment: Appointment }>(`/api/appointments/${id}/cancel`, { method: 'PATCH' }),

  sendMessage: (b: { sessionId?: string; message: string }) =>
    request<ChatReply>('/api/chat/messages', { method: 'POST', body: b }),
  getSession: (id: string) => request<SessionView>(`/api/chat/sessions/${id}`),
  confirmSession: (id: string) =>
    request<{ appointment: Appointment }>(`/api/chat/sessions/${id}/confirm`, { method: 'POST' }),
};

export type { Draft };
