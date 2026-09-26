import { Router } from 'express';
import { AttendanceController } from './attendance.controller.js';
import { InOutController } from './inOut.controller.js';

const router = Router();

// Raw Punches & Swipes
router.get('/', AttendanceController.getAttendance);
router.get('/raw-swipes', AttendanceController.getRawSwipes);
router.get('/stats', AttendanceController.getDashboardStats);

// Processed Daily Attendance (Check-in, Check-out, Working Hours, Overtime, Status)
router.get('/in-out', InOutController.getInOutAttendance);
router.get('/timesheet', InOutController.getTimesheet);

export default router;
