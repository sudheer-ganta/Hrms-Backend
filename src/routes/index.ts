import { Router } from 'express';
import sourcesRouter from '../modules/sources/sources.routes.js';
import attendanceRouter from '../modules/attendance/attendance.routes.js';
import syncRouter from '../modules/sync/sync.routes.js';
import policyRouter from '../modules/settings/policy.routes.js';
import employeeRouter from '../modules/employees/employeeMaster.routes.js';
import payrollRouter from '../modules/payroll/payroll.routes.js';
import requestsRouter from '../modules/requests/requests.routes.js';
import authRouter from '../modules/auth/auth.routes.js';
import { isDbConnected } from '../config/db.js';

const router = Router();

// PUBLIC: minimal liveness only (no URIs, no internals)
router.get('/health', (_req, res) => {
  res.status(isDbConnected() ? 200 : 503).json({ success: isDbConnected(), data: { status: isDbConnected() ? 'ok' : 'degraded', database: { connected: isDbConnected() } } });
});

router.use('/auth', authRouter);
router.use('/sources', sourcesRouter);
router.use('/attendance', attendanceRouter);
router.use('/sync', syncRouter);
router.use('/settings', policyRouter);
router.use('/employees', employeeRouter);
router.use('/payroll', payrollRouter);
router.use('/requests', requestsRouter);

export default router;
