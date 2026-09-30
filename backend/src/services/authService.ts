import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { LoginInput, SignupInput } from '../schemas';
import { AppError } from '../utils/AppError';

interface UserRow {
  id: string;
  business_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  phone: string | null;
  role: string;
}

const toPublic = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  phone: u.phone,
  role: u.role,
  businessId: u.business_id,
});

const signToken = (u: UserRow) =>
  jwt.sign({ bid: u.business_id, role: u.role }, env.JWT_SECRET, { subject: u.id, expiresIn: '7d' });

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export async function signup(input: SignupInput) {
  const hash = await bcrypt.hash(input.password, 10);
  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (business_id, email, password_hash, full_name, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [env.DEFAULT_BUSINESS_ID, input.email, hash, input.fullName, input.phone ?? null],
    );
    return { user: toPublic(rows[0]), token: signToken(rows[0]) };
  } catch (err: any) {
    if (err?.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

export async function login(input: LoginInput) {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [input.email]);
  const user = rows[0];
  const ok = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  return { user: toPublic(user), token: signToken(user) };
}

export async function getUser(id: string) {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  return toPublic(rows[0]);
}
