import { Request, Response } from 'express';
import { authService } from './auth.service.js';
import { AuthRequest } from '../../middleware/auth.middleware.js';

export class AuthController {
  /**
   * POST /api/auth/login
   */
  public async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, identifier, password } = req.body;
      const targetId = identifier || email;

      if (!targetId || !password) {
        res.status(400).json({ success: false, message: 'Email or Employee Code and password are required.' });
        return;
      }

      const result = await authService.login(targetId, password);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(401).json({ success: false, message: err.message || 'Login failed.' });
    }
  }

  /**
   * GET /api/auth/me
   */
  public async getMe(req: AuthRequest, res: Response): Promise<void> {
    res.json({ success: true, data: req.user });
  }

  /**
   * POST /api/auth/create-user (Super Admin only)
   */
  public async createUser(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { email, name, password, role, empCode } = req.body;
      if (!email || !password || !role) {
        res.status(400).json({ success: false, message: 'Email, password, and role are required.' });
        return;
      }

      const user = await authService.createUser(
        { email, name, password, role, empCode },
        req.user?.role || 'EMPLOYEE'
      );

      res.status(201).json({ success: true, data: user, message: 'User created successfully.' });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Failed to create user.' });
    }
  }

  /**
   * GET /api/auth/users (Super Admin only)
   */
  public async getAllUsers(req: AuthRequest, res: Response): Promise<void> {
    try {
      const users = await authService.getAllUsers(req.user?.role || 'EMPLOYEE');
      res.json({ success: true, data: users });
    } catch (err: any) {
      res.status(403).json({ success: false, message: err.message });
    }
  }

  /**
   * DELETE /api/auth/users/:id (Super Admin only)
   */
  public async deleteUser(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      await authService.deleteUser(id, req.user?.role || 'EMPLOYEE');
      res.json({ success: true, message: 'User account deleted successfully.' });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/auth/users/:id/toggle-status (Super Admin only)
   */
  public async toggleStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const updated = await authService.toggleStatus(id, req.user?.role || 'EMPLOYEE');
      res.json({ success: true, data: updated, message: `User status changed to ${updated.status}.` });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  /**
   * POST /api/auth/users/:id/reset-password (Super Admin only)
   */
  public async resetPassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      const { newPassword } = req.body;
      if (!newPassword || newPassword.length < 4) {
        res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });
        return;
      }
      await authService.resetPassword(id, newPassword, req.user?.role || 'EMPLOYEE');
      res.json({ success: true, message: 'Password reset successfully.' });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
}

export const authController = new AuthController();
