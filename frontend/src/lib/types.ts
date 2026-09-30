export interface User {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  businessId: string;
}

export interface Draft {
  service?: string;
  date?: string;
  time?: string;
  notes?: string;
}

export interface Appointment {
  id: string;
  service: string;
  startsAt: string;
  endsAt: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  notes: string | null;
  createdVia: string;
}

export interface BookingOptions {
  services: string[];
  hours: { open: string; close: string; slotMinutes: number };
  timezone?: string;
}

// Used until /options loads (or if it fails), so the form is always usable.
export const DEFAULT_OPTIONS: BookingOptions = {
  services: ['Teeth cleaning', 'Check-up', 'Filling', 'Consultation'],
  hours: { open: '09:00', close: '18:00', slotMinutes: 30 },
};

export interface ChatReply {
  sessionId: string;
  reply: string;
  draft: Draft;
  missing: string[];
  readyToConfirm: boolean;
  summary: string | null;
  needsForm: boolean;
}

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface SessionView {
  session: { id: string; status: string; draft: Draft; missing: string[]; readyToConfirm: boolean };
  messages: StoredMessage[];
}
