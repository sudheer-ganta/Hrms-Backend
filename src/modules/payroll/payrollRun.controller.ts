import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { payrollRunService } from './payrollRun.service.js';
import { payrollService } from './payroll.service.js';
import { handle } from '../../utils/apiError.js';
import { requireMonth, requireObject, optionalString } from '../../utils/validate.js';
import { ApiError } from '../../utils/apiError.js';
import { attendanceCoverage } from './attendanceCoverage.js';
import { policyService } from '../settings/policy.service.js';
import { istToday } from '../../utils/istTime.js';

const actor = (req: AuthRequest) => req.user?.name || req.user?.email || 'Unknown';

export class PayrollRunController {
  public getStatus = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await payrollRunService.getRunStatus(requireMonth(req.params.month)) });
  });

  public listRuns = handle(async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await payrollRunService.listRuns() });
  });

  public listVersions = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await payrollRunService.listVersions(requireMonth(req.params.month)) });
  });

  public getVersion = handle(async (req: AuthRequest, res: Response) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw ApiError.validation('version must be a positive integer.', [{ field: 'version', issue: 'Invalid' }]);
    res.json({ success: true, data: await payrollRunService.getVersion(requireMonth(req.params.month), version) });
  });

  /** GET /payroll/runs/:month/coverage: which working days have no stored attendance at all (shown before locking). */
  public getCoverage = handle(async (req: AuthRequest, res: Response) => {
    const month = requireMonth(req.params.month);
    res.json({ success: true, data: await attendanceCoverage(month, policyService.getSettings(), istToday()) });
  });

  /**
   * Close = check attendance coverage → calculate → validate → freeze as a new immutable snapshot version.
   * A month with working days that have no attendance for anyone is refused, because those days would lock as
   * loss of pay for everybody; an administrator can still close it by sending `acknowledgeMissingAttendance: true`.
   */
  public closeMonth = handle(async (req: AuthRequest, res: Response) => {
    const month = requireMonth(req.params.month);
    const body = requireObject(req.body ?? {});
    if (await payrollRunService.isClosed(month)) throw ApiError.conflict(`${month} is already closed. Reopen it first.`);
    if (body.acknowledgeMissingAttendance !== true) {
      const cov = await attendanceCoverage(month, policyService.getSettings(), istToday());
      if (cov.missingDates.length) {
        const shown = cov.missingDates.slice(0, 5).join(', ');
        throw ApiError.rule(
          `Attendance is missing for ${cov.missingDates.length} of ${cov.workingDays} working days of ${month} (${shown}${cov.missingDates.length > 5 ? ', …' : ''}). ` +
          'Everyone would be locked as loss of pay on those days. Sync attendance for the month first, or confirm that those days really had no attendance.'
        );
      }
    }
    const snapshot = await payrollService.calculateAllEmployeesPayroll(month, { forceLive: true });
    const run = await payrollRunService.closeMonth(month, snapshot, actor(req));
    res.json({ success: true, data: run });
  });

  public reopenMonth = handle(async (req: AuthRequest, res: Response) => {
    const month = requireMonth(req.params.month);
    const body = requireObject(req.body ?? {});
    const run = await payrollRunService.reopenMonth(month, actor(req), optionalString(body.reason, 'reason', 500) ?? '');
    res.json({ success: true, data: run });
  });
}

export const payrollRunController = new PayrollRunController();
