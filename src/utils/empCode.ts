/**
 * Canonical employee identity key.
 *
 * Every module (User, EmployeeProfile, attendance, requests, payroll, JWT)
 * MUST go through this function so "abc001", " ABC001 " and "ABC001" are one person.
 */
const EMP_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._\-/]{0,31}$/;

export const normalizeEmpCode = (code: unknown): string => String(code ?? '').trim().toUpperCase();

export const isValidEmpCode = (code: unknown): boolean => EMP_CODE_PATTERN.test(normalizeEmpCode(code));

/** Normalizes and validates; throws a plain Error (callers wrap into ApiError). */
export const requireEmpCode = (code: unknown): string => {
  const n = normalizeEmpCode(code);
  if (!EMP_CODE_PATTERN.test(n)) throw new Error('Invalid employee code');
  return n;
};
