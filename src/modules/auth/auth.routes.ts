import { Router } from 'express';
import { authController } from './auth.controller.js';
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js';

const router = Router();

// Public routes
router.post('/login', (req, res) => authController.login(req, res));

// Authenticated user profile
router.get('/me', requireAuth, (req, res) => authController.getMe(req, res));

// Super Admin User Management routes
router.post('/create-user', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.createUser(req, res));
router.post('/users', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.createUser(req, res));
router.get('/users', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.getAllUsers(req, res));
router.delete('/users/:id', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.deleteUser(req, res));
router.post('/users/:id/toggle-status', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.toggleStatus(req, res));
router.post('/users/:id/reset-password', requireAuth, requireRole(['SUPER_ADMIN']), (req, res) => authController.resetPassword(req, res));

export default router;
