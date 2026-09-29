import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { payrollRunService } from './payrollRun.service.js';
import { payrollService } from './payroll.service.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PayrollRunController {
  public getStatus = async (req: AuthRequest, res: Response) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_PATTERN.test(month)) {
        return res.status(400).json({ success: false, error: 'Month must be in YYYY-MM format' });
      }
      const status = await payrollRunService.getRunStatus(month);
      res.json({ success: true, data: status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public listRuns = async (req: AuthRequest, res: Response) => {
    try {
      const runs = await payrollRunService.listRuns();
      res.json({ success: true, data: runs });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public closeMonth = async (req: AuthRequest, res: Response) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_PATTERN.test(month)) {
        return res.status(400).json({ success: false, error: 'Month must be in YYYY-MM format' });
      }
      const closedBy = req.user?.name || req.user?.email || 'Unknown';

      // Compute live figures for every employee one last time, then lock them in.
      const snapshot = await payrollService.calculateAllEmployeesPayroll(month);
      const run = await payrollRunService.closeMonth(month, snapshot, closedBy);

      res.json({
        success: true,
        message: `${month} payroll closed and locked by ${closedBy}.`,
        data: run,
      });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

  public reopenMonth = async (req: AuthRequest, res: Response) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_PATTERN.test(month)) {
        return res.status(400).json({ success: false, error: 'Month must be in YYYY-MM format' });
      }
      const reopenedBy = req.user?.name || req.user?.email || 'Unknown';

      const run = await payrollRunService.reopenMonth(month, reopenedBy);
      payrollService.invalidateAllPayrollCache(month);

      res.json({
        success: true,
        message: `${month} payroll reopened by ${reopenedBy}. It's back to live calculation until you close it again.`,
        data: run,
      });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  };
}

export const payrollRunController = new PayrollRunController();
