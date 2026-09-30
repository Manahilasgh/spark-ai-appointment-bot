import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createAppointmentSchema, idParam, listAppointmentsQuery, rescheduleAppointmentSchema } from '../schemas';
import * as appointments from '../services/appointmentService';
import { BUSINESS_HOURS, SERVICES } from '../services/bookingRules';
import { getBusiness } from '../services/businessService';
import { asyncHandler } from '../utils/asyncHandler';

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

// Options for the booking form (kept server-side so form and chatbot share one source of truth)
appointmentsRouter.get(
  '/options',
  asyncHandler(async (req, res) => {
    const business = await getBusiness(req.user!.businessId);
    res.json({ services: SERVICES, hours: BUSINESS_HOURS, timezone: business.timezone });
  }),
);

appointmentsRouter.get(
  '/',
  validate({ query: listAppointmentsQuery }),
  asyncHandler(async (req, res) => {
    const status = (req.query as { status?: string }).status;
    res.json({ appointments: await appointments.listAppointments(req.user!, status) });
  }),
);

// Form-based booking (also the fallback when the chatbot can't complete a request)
appointmentsRouter.post(
  '/',
  validate({ body: createAppointmentSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ appointment: await appointments.createAppointment(req.user!, req.body, 'form') });
  }),
);

// Change the date/time of an existing appointment
appointmentsRouter.patch(
  '/:id',
  validate({ params: idParam, body: rescheduleAppointmentSchema }),
  asyncHandler(async (req, res) => {
    res.json({ appointment: await appointments.rescheduleAppointment(req.user!, req.params.id, req.body) });
  }),
);

appointmentsRouter.patch(
  '/:id/cancel',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ appointment: await appointments.cancelAppointment(req.user!, req.params.id) });
  }),
);
