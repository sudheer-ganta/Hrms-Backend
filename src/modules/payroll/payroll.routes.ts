import { Router } from 'express';
import { payrollController } from './payroll.controller.js';
import { payrollRunController } from './payrollRun.controller.js';
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js';

const router = Router();

router.get('/all', payrollController.getAllPayroll);
router.get('/employee/:empCode', payrollController.getEmployeePayroll);
router.post('/send-payslip', payrollController.sendPayslip);

// Overtime & Payroll Adjustments — these edit/reveal individual pay figures,
// so (like payroll close/reopen below) they require an authenticated
// Super Admin / Founder, and the real user's identity is what gets recorded
// in the permanent audit trail for save/clear actions.
router.get('/adjustments/:month', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollController.getAdjustments);
router.post('/adjustments/:month', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollController.saveAdjustments);
router.delete('/adjustments/:month', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollController.clearAdjustments);
router.get('/adjustments/:month/history', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollController.getAdjustmentHistory);

// Monthly payroll closing (locking a permanent snapshot) is a consequential,
// audit-worthy action, so only Super Admin / Founder can close or reopen a month.
router.get('/runs', requireAuth, payrollRunController.listRuns);
router.get('/runs/:month', requireAuth, payrollRunController.getStatus);
router.post('/runs/:month/close', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollRunController.closeMonth);
router.post('/runs/:month/reopen', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollRunController.reopenMonth);

export default router;
