import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idParam, StaffAppointmentsQuery, staffAppointmentsQuery } from '../schemas';
import * as staff from '../services/staffService';
import { asyncHandler } from '../utils/asyncHandler';

export const staffRouter = Router();
staffRouter.use(requireAuth, requireRole('staff', 'admin'));

// Front-desk view: all appointments in the business
staffRouter.get(
  '/appointments',
  validate({ query: staffAppointmentsQuery }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as StaffAppointmentsQuery;
    res.json({ appointments: await staff.listBusinessAppointments(req.user!, query) });
  }),
);

staffRouter.patch(
  '/appointments/:id/cancel',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ appointment: await staff.cancelBusinessAppointment(req.user!, req.params.id) });
  }),
);
