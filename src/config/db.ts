import mongoose from 'mongoose';
import { ApiError } from '../utils/apiError.js';

/**
 * MongoDB is the ONLY system of record. There is no local-file fallback:
 * when the database is unreachable, business operations fail closed with a
 * controlled SERVICE_UNAVAILABLE error instead of reading stale data.
 */
export const isDbConnected = (): boolean => mongoose.connection.readyState === 1;

export const requireDb = (): void => {
  if (!isDbConnected()) throw ApiError.unavailable();
};
