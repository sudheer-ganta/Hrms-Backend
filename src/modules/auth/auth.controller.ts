import { Request, Response } from 'express';
import { authService } from './auth.service.js';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { handle } from '../../utils/apiError.js';
import { requireNonEmptyString, requireObject } from '../../utils/validate.js';

export class AuthController {
  /** POST /api/auth/login */
  public login = handle(async (req: Request, res: Response) => {
    const body = requireObject(req.body);
    const identifier = requireNonEmptyString(body.identifier ?? body.email, 'identifier', 254);
    const password = requireNonEmptyString(body.password, 'password', 128);
    const result = await authService.login(identifier, password);
    res.json({ success: true, data: result });
  });

  /** GET /api/auth/me: the CURRENT user from the database (not stale token claims). */
  public getMe = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: req.user });
  });

  /** POST /api/auth/logout: revokes all sessions of the caller. */
  public logout = handle(async (req: AuthRequest, res: Response) => {
    await authService.revokeSessions(req.user!.id);
    res.json({ success: true, data: { loggedOut: true } });
  });

  /** POST /api/auth/change-password */
  public changePassword = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const result = await authService.changePassword(
      req.user!.id,
      requireNonEmptyString(body.currentPassword, 'currentPassword', 128),
      requireNonEmptyString(body.newPassword, 'newPassword', 128)
    );
    res.json({ success: true, data: result });
  });

  /** POST /api/auth/users (Super Admin) */
  public createUser = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const user = await authService.createUser({
      email: requireNonEmptyString(body.email, 'email', 254),
      name: typeof body.name === 'string' ? body.name : undefined,
      password: requireNonEmptyString(body.password, 'password', 128),
      role: body.role as 'FOUNDER' | 'EMPLOYEE',
      empCode: typeof body.empCode === 'string' ? body.empCode : undefined,
    });
    res.status(201).json({ success: true, data: user });
  });

  public getAllUsers = handle(async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await authService.getAllUsers() });
  });

  public deleteUser = handle(async (req: AuthRequest, res: Response) => {
    await authService.deleteUser(String(req.params.id), req.user!.id);
    res.json({ success: true, data: { deleted: true } });
  });

  public toggleStatus = handle(async (req: AuthRequest, res: Response) => {
    const updated = await authService.toggleStatus(String(req.params.id), req.user!.id);
    res.json({ success: true, data: updated });
  });

  public resetPassword = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    await authService.resetPassword(String(req.params.id), requireNonEmptyString(body.newPassword, 'newPassword', 128));
    res.json({ success: true, data: { reset: true } });
  });
}

export const authController = new AuthController();
