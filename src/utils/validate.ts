import { ApiError } from './apiError.js';
import { isValidBusinessDate, isValidBusinessMonth, TIME_RE } from './istTime.js';

/** Escape user text so it can be embedded safely in a RegExp. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const asString = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

export const requireMonth = (v: unknown, field = 'month'): string => {
  if (!isValidBusinessMonth(v)) throw ApiError.validation('Month must be YYYY-MM.', [{ field, issue: 'Invalid format' }]);
  return v;
};

export const optionalMonth = (v: unknown, field = 'month'): string | undefined =>
  v === undefined || v === '' ? undefined : requireMonth(v, field);

export const requireDate = (v: unknown, field = 'date'): string => {
  if (!isValidBusinessDate(v)) throw ApiError.validation('Date must be YYYY-MM-DD.', [{ field, issue: 'Invalid date' }]);
  return v;
};

export const optionalDate = (v: unknown, field = 'date'): string | undefined =>
  v === undefined || v === '' ? undefined : requireDate(v, field);

export const optionalTime = (v: unknown, field = 'time'): string | undefined => {
  if (v === undefined || v === '' || v === null) return undefined;
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw ApiError.validation('Time must be HH:mm.', [{ field, issue: 'Invalid time' }]);
  return v;
};

export const requireEnum = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw ApiError.validation(`${field} must be one of: ${allowed.join(', ')}.`, [{ field, issue: 'Invalid value' }]);
  }
  return v as T;
};

export const optionalEnum = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined =>
  v === undefined || v === '' ? undefined : requireEnum(v, allowed, field);

export const requireNonEmptyString = (v: unknown, field: string, max = 500): string => {
  if (typeof v !== 'string' || !v.trim()) throw ApiError.validation(`${field} is required.`, [{ field, issue: 'Required' }]);
  if (v.length > max) throw ApiError.validation(`${field} is too long.`, [{ field, issue: `Max ${max} characters` }]);
  return v.trim();
};

export const optionalString = (v: unknown, field: string, max = 500): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw ApiError.validation(`${field} must be text.`, [{ field, issue: 'Not a string' }]);
  if (v.length > max) throw ApiError.validation(`${field} is too long.`, [{ field, issue: `Max ${max} characters` }]);
  return v.trim();
};

export const optionalNumber = (v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw ApiError.validation(`${field} must be a number.`, [{ field, issue: 'Not a number' }]);
  if (opts.min !== undefined && n < opts.min) throw ApiError.validation(`${field} must be ≥ ${opts.min}.`, [{ field, issue: 'Too small' }]);
  if (opts.max !== undefined && n > opts.max) throw ApiError.validation(`${field} must be ≤ ${opts.max}.`, [{ field, issue: 'Too large' }]);
  return n;
};

export const pagination = (page: unknown, limit: unknown, maxLimit = 200): { page: number; limit: number } => {
  const p = Math.floor(Number(page ?? 1));
  const l = Math.floor(Number(limit ?? 50));
  return {
    page: Number.isFinite(p) && p > 0 ? p : 1,
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, maxLimit) : 50,
  };
};

export const safeSort = (v: unknown, allowed: readonly string[], fallback: string): string =>
  typeof v === 'string' && allowed.includes(v) ? v : fallback;

export const dateRange = (from: unknown, to: unknown, maxDays = 366): { from?: string; to?: string } => {
  const f = optionalDate(from, 'fromDate');
  const t = optionalDate(to, 'toDate');
  if (f && t) {
    if (f > t) throw ApiError.validation('fromDate must not be after toDate.', [{ field: 'fromDate', issue: 'After toDate' }]);
    const days = (Date.parse(t) - Date.parse(f)) / 86_400_000;
    if (days > maxDays) throw ApiError.validation(`Date range may not exceed ${maxDays} days.`, [{ field: 'toDate', issue: 'Range too large' }]);
  }
  return { from: f, to: t };
};

export const requireObject = (v: unknown, field = 'body'): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw ApiError.validation(`${field} must be an object.`, [{ field, issue: 'Not an object' }]);
  }
  return v as Record<string, unknown>;
};
