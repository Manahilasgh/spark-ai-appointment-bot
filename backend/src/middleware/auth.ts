import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
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
