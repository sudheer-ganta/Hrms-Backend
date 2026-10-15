import { Router } from 'express';
import { payrollController } from './payroll.controller.js';
import { payrollRunController } from './payrollRun.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// EMPLOYEE_SELF: an employee sees only their own payroll
router.get('/employee/:empCode', ...access.EMPLOYEE_SELF, payrollController.getEmployeePayroll);

// HR_OR_ABOVE: company payroll, adjustments, payslip emails, month close
router.get('/all', ...access.HR_OR_ABOVE, payrollController.getAllPayroll);
router.post('/send-payslip', ...access.HR_OR_ABOVE, payrollController.sendPayslip);

router.post('/preview/:month', ...access.HR_OR_ABOVE, payrollController.previewPayroll);
router.get('/adjustments/:month', ...access.HR_OR_ABOVE, payrollController.getAdjustments);
router.post('/adjustments/:month', ...access.HR_OR_ABOVE, payrollController.saveAdjustments);
router.delete('/adjustments/:month', ...access.HR_OR_ABOVE, payrollController.clearAdjustments);
router.get('/adjustments/:month/history', ...access.HR_OR_ABOVE, payrollController.getAdjustmentHistory);

router.get('/runs', ...access.HR_OR_ABOVE, payrollRunController.listRuns);
router.get('/runs/:month', ...access.HR_OR_ABOVE, payrollRunController.getStatus);
router.get('/runs/:month/versions', ...access.HR_OR_ABOVE, payrollRunController.listVersions);
router.get('/runs/:month/versions/:version', ...access.HR_OR_ABOVE, payrollRunController.getVersion);
router.get('/runs/:month/coverage', ...access.HR_OR_ABOVE, payrollRunController.getCoverage);
router.post('/runs/:month/close', ...access.HR_OR_ABOVE, payrollRunController.closeMonth);
// Reopening a closed payroll is the most consequential payroll action: SUPER_ADMIN only.
router.post('/runs/:month/reopen', ...access.SUPER_ADMIN_ONLY, payrollRunController.reopenMonth);

export default router;
