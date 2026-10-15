import { ApiError } from './apiError.js';

/** Password policy: ≥10 chars, at least one letter and one digit, not equal to the account id. */
export const assertStrongPassword = (password: unknown, ...forbidden: Array<string | undefined>): string => {
  if (typeof password !== 'string') throw ApiError.validation('Password is required.', [{ field: 'password', issue: 'Required' }]);
  const issues: string[] = [];
  if (password.length < 10) issues.push('at least 10 characters');
  if (password.length > 128) issues.push('at most 128 characters');
  if (!/[A-Za-z]/.test(password)) issues.push('a letter');
  if (!/\d/.test(password)) issues.push('a digit');
  const lower = password.toLowerCase();
  for (const f of forbidden) {
    const v = (f || '').trim().toLowerCase();
    if (v.length >= 3 && (lower === v || lower === v.split('@')[0])) issues.push('must not match your email or employee code');
  }
  if (issues.length) {
    throw ApiError.validation(`Password must contain ${issues.join(', ')}.`, [{ field: 'password', issue: issues.join('; ') }]);
  }
  return password;
};
