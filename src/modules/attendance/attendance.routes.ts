import { Router } from 'express';
import { attendanceController as AttendanceController } from './attendance.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// EMPLOYEE_SELF: employees see only their own attendance; admins see everyone.
router.get('/days', ...access.EMPLOYEE_SELF, AttendanceController.getDays);
router.get('/calendar', ...access.EMPLOYEE_SELF, AttendanceController.getCalendar);
router.get('/punch/today', ...access.EMPLOYEE_SELF, AttendanceController.getTodayPunchStatus);
router.post('/punch', ...access.EMPLOYEE_SELF, AttendanceController.recordPunch);

// HR_OR_ABOVE: timesheet, raw swipes, stats, recompute, manual day adjustments
router.get('/raw-swipes', ...access.HR_OR_ABOVE, AttendanceController.getRawPunches);
router.get('/timesheet', ...access.HR_OR_ABOVE, AttendanceController.getTimesheet);
router.get('/stats', ...access.HR_OR_ABOVE, AttendanceController.getDashboardStats);
router.post('/recompute', ...access.HR_OR_ABOVE, AttendanceController.recompute);
router.post('/adjust', ...access.HR_OR_ABOVE, AttendanceController.adjustDay);
router.post('/adjust/revoke', ...access.HR_OR_ABOVE, AttendanceController.revokeAdjustment);
router.post('/adjust/:id/revoke', ...access.HR_OR_ABOVE, AttendanceController.revokeAdjustment);

export default router;

