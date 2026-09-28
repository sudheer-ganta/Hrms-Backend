import { Router } from 'express';
import { payrollController } from './payroll.controller.js';
import { payrollRunController } from './payrollRun.controller.js';
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js';

const router = Router();

router.get('/all', payrollController.getAllPayroll);
router.get('/employee/:empCode', payrollController.getEmployeePayroll);
router.post('/send-payslip', payrollController.sendPayslip);

// Overtime & Payroll Adjustments
router.get('/adjustments/:month', payrollController.getAdjustments);
router.post('/adjustments/:month', payrollController.saveAdjustments);
router.delete('/adjustments/:month', payrollController.clearAdjustments);

// Monthly payroll closing (locking a permanent snapshot) is a consequential,
// audit-worthy action, so only Super Admin / Founder can close or reopen a month.
router.get('/runs', requireAuth, payrollRunController.listRuns);
router.get('/runs/:month', requireAuth, payrollRunController.getStatus);
router.post('/runs/:month/close', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollRunController.closeMonth);
router.post('/runs/:month/reopen', requireAuth, requireRole(['SUPER_ADMIN', 'FOUNDER']), payrollRunController.reopenMonth);

export default router;
