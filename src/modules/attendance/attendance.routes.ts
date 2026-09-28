import { Router } from 'express';
import { AttendanceController } from './attendance.controller.js';
import { InOutController } from './inOut.controller.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.middleware.js';

const router = Router();

// Raw Punches & Swipes
router.get('/', AttendanceController.getAttendance);
router.get('/raw-swipes', AttendanceController.getRawSwipes);
router.get('/stats', AttendanceController.getDashboardStats);

// Processed Daily Attendance (Check-in, Check-out, Working Hours, Overtime, Status)
router.get('/in-out', InOutController.getInOutAttendance);
router.get('/timesheet', InOutController.getTimesheet);

// Employee Geotagged Punch (Check-In / Check-Out with Server IST Enforcement)
router.get('/punch/today', optionalAuth, AttendanceController.getTodayPunchStatus);
router.post('/punch', optionalAuth, AttendanceController.recordPunch);

export default router;
