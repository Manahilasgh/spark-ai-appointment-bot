import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';

export interface Business {
  id: string;
  name: string;
  timezone: string;
}

export async function getBusiness(id: string): Promise<Business> {
  const { rows } = await pool.query<Business>('SELECT id, name, timezone FROM businesses WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError(404, 'BUSINESS_NOT_FOUND', 'Business not found');
  return rows[0];
}
