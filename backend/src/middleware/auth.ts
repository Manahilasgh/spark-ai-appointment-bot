import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header'));
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    req.user = { id: String(payload.sub), businessId: String(payload.bid), role: String(payload.role) };
    next();
  } catch {
    next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}

/**
 * Restricts a route to certain roles. Use after requireAuth.
 * The role is read from the database on every call (not from the JWT), so a promotion or demotion
 * takes effect immediately instead of waiting for the user's token to expire.
 */
export const requireRole =
  (...allowed: string[]) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
      const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
      const role: string | undefined = rows[0]?.role;
      if (!role || !allowed.includes(role)) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do that.');
      }
      req.user.role = role;
      next();
    } catch (err) {
      next(err);
    }
  };
