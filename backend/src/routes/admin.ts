import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idParam, setRoleSchema } from '../schemas';
import * as staff from '../services/staffService';
import { asyncHandler } from '../utils/asyncHandler';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    res.json({ users: await staff.listUsers(req.user!) });
  }),
);

adminRouter.patch(
  '/users/:id/role',
  validate({ params: idParam, body: setRoleSchema }),
  asyncHandler(async (req, res) => {
    res.json({ user: await staff.setUserRole(req.user!, req.params.id, req.body.role) });
  }),
);
