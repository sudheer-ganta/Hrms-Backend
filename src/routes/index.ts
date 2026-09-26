import { Router } from 'express';
import sourcesRouter from '../modules/sources/sources.routes.js';
import attendanceRouter from '../modules/attendance/attendance.routes.js';
import syncRouter from '../modules/sync/sync.routes.js';
import policyRouter from '../modules/settings/policy.routes.js';
import employeeRouter from '../modules/employees/employeeMaster.routes.js';
import payrollRouter from '../modules/payroll/payroll.routes.js';
import requestsRouter from '../modules/requests/requests.routes.js';
import authRouter from '../modules/auth/auth.routes.js';
import { getDbStatus } from '../config/database.js';

const router = Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: getDbStatus(),
  });
});

// Mounted modules
router.use('/auth', authRouter);
router.use('/sources', sourcesRouter);
router.use('/attendance', attendanceRouter);
router.use('/sync', syncRouter);
router.use('/settings', policyRouter);
router.use('/employees', employeeRouter);
router.use('/payroll', payrollRouter);
router.use('/requests', requestsRouter);

export default router;
