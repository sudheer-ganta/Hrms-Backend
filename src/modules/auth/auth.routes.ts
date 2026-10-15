import { Router } from 'express';
import { authController } from './auth.controller.js';
import { access } from '../../middleware/auth.middleware.js';
import { createRateLimiter } from '../../utils/rateLimit.js';
import { normalizeEmpCode } from '../../utils/empCode.js';

const router = Router();

// Brute-force protection: per client IP + identifier, and a looser per-IP ceiling.
const loginPerAccount = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 8,
  key: (req) => `${req.ip}|${String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase() || normalizeEmpCode('')}`,
  message: 'Too many login attempts for this account. Try again in 15 minutes.',
});
const loginPerIp = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 60,
  key: (req) => String(req.ip),
  message: 'Too many login attempts. Try again later.',
});
export const loginLimiters = [loginPerIp, loginPerAccount];

// PUBLIC
router.post('/login', loginPerIp, loginPerAccount, authController.login);

// AUTHENTICATED
router.get('/me', ...access.AUTHENTICATED, authController.getMe);
router.post('/logout', ...access.AUTHENTICATED, authController.logout);
router.post('/change-password', ...access.AUTHENTICATED, authController.changePassword);

// SUPER_ADMIN_ONLY: user management
router.post('/users', ...access.SUPER_ADMIN_ONLY, authController.createUser);
router.get('/users', ...access.SUPER_ADMIN_ONLY, authController.getAllUsers);
router.delete('/users/:id', ...access.SUPER_ADMIN_ONLY, authController.deleteUser);
router.post('/users/:id/toggle-status', ...access.SUPER_ADMIN_ONLY, authController.toggleStatus);
router.post('/users/:id/reset-password', ...access.SUPER_ADMIN_ONLY, authController.resetPassword);

export default router;
