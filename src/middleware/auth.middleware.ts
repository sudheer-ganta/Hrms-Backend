import { Request, Response, NextFunction } from 'express';
import { authService } from '../modules/auth/auth.service.js';
import { IUser, UserRole } from '../modules/auth/auth.types.js';
import { ApiError, handle, sendError } from '../utils/apiError.js';
import { normalizeEmpCode } from '../utils/empCode.js';

export interface AuthRequest extends Request {
  /** The CURRENT user loaded from the database for this request. */
  user?: IUser;
}

/** Valid, non-revoked token of an ACTIVE user (checked against the database on every request). */
export const requireAuth = handle(async (req: AuthRequest, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw ApiError.unauthenticated('Missing or invalid token.');
  const user = await authService.authenticateToken(header.slice(7).trim());
  if (!user) throw ApiError.unauthenticated('Invalid, expired or revoked token.');
  req.user = user;
  next();
});

export const requireRole = (roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) return sendError(res, ApiError.unauthenticated());
    if (!roles.includes(req.user.role)) return sendError(res, ApiError.forbidden('Insufficient permissions.'));
    next();
  };
};

/**
 * EMPLOYEE_SELF: employees may only touch their own data. Any empCode supplied
 * (param, query or body) that is not the caller's is rejected, and the canonical
 * code is pinned into the request. SUPER_ADMIN / FOUNDER pass through untouched.
 */
export const scopeToSelf = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const user = req.user;
  if (!user) return sendError(res, ApiError.unauthenticated());
  if (user.role !== 'EMPLOYEE') return next();

  const own = normalizeEmpCode(user.empCode);
  if (!own) return sendError(res, ApiError.forbidden('This account is not linked to an employee code.'));

  const supplied = [req.params?.empCode, req.query?.empCode, req.query?.employeeCode, req.body?.empCode];
  if (supplied.some((v) => v !== undefined && v !== '' && normalizeEmpCode(v) !== own)) {
    return sendError(res, ApiError.forbidden('You can only access your own records.'));
  }
  (req.query as any).empCode = own;
  (req.query as any).employeeCode = own;
  if (req.params && 'empCode' in req.params) (req.params as any).empCode = own;
  if (req.body && typeof req.body === 'object' && 'empCode' in req.body) req.body.empCode = own;
  next();
};

/** Access levels used by every route file. Backend is the only authority. */
export const access = {
  /** No authentication (login, minimal health). */
  PUBLIC: [] as Array<(req: any, res: Response, next: NextFunction) => void>,
  /** Any logged-in, active user. */
  AUTHENTICATED: [requireAuth],
  /** Logged-in user; employees are restricted to their own empCode. */
  EMPLOYEE_SELF: [requireAuth, scopeToSelf],
  /** HR, FOUNDER, or SUPER_ADMIN (standard operational actions). */
  HR_OR_ABOVE: [requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER', 'HR'])],
  /** SUPER_ADMIN or FOUNDER. */
  FOUNDER_OR_SUPER_ADMIN: [requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER'])],
  /** SUPER_ADMIN only (system configuration, user management, policy updates, payroll reopen). */
  SUPER_ADMIN_ONLY: [requireAuth, requireRole(['SUPER_ADMIN'])],
};

