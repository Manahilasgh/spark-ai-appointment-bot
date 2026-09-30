export interface User {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  businessId: string;
}

export type ChatAction = 'book' | 'cancel' | 'reschedule';

export interface Draft {
  action?: ChatAction;
  appointmentId?: string;
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
  action: ChatAction;
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
  session: { id: string; status: string; draft: Draft; action: ChatAction; missing: string[]; readyToConfirm: boolean };
  messages: StoredMessage[];
}

export type Role = 'customer' | 'staff' | 'admin';

/** An appointment as seen by staff: includes who booked it. */
export interface StaffAppointment extends Appointment {
  customer: { name: string; email: string };
}

export interface TeamUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  createdAt: string;
}
