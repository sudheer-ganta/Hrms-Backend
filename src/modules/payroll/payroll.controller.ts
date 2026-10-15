import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { payrollService } from './payroll.service.js';
import { emailService } from './email.service.js';
import { payrollAdjustmentService, validateAdjustments } from './payrollAdjustment.service.js';
import { handle } from '../../utils/apiError.js';
import { optionalMonth, requireMonth, requireObject, optionalString } from '../../utils/validate.js';
import { isValidEmpCode, normalizeEmpCode } from '../../utils/empCode.js';
import { ApiError } from '../../utils/apiError.js';

const actor = (req: AuthRequest) => req.user?.name || req.user?.email || 'Unknown';

export class PayrollController {
  public getEmployeePayroll = handle(async (req: AuthRequest, res: Response) => {
    const month = optionalMonth(req.query.month);
    const summary = await payrollService.calculateEmployeePayroll(String(req.params.empCode), month);
    res.json({ success: true, data: summary });
  });

  public getAllPayroll = handle(async (req: AuthRequest, res: Response) => {
    const summaries = await payrollService.calculateAllEmployeesPayroll(optionalMonth(req.query.month));
    res.json({ success: true, count: summaries.length, data: summaries });
  });

  public getAdjustments = handle(async (req: AuthRequest, res: Response) => {
    const data = await payrollAdjustmentService.getAdjustments(requireMonth(req.params.month));
    res.json({ success: true, data });
  });

  /** Prices UNSAVED OT Calculator edits through the real payroll engine. Persists nothing. */
  public previewPayroll = handle(async (req: AuthRequest, res: Response) => {
    const month = requireMonth(req.params.month);
    const body = requireObject(req.body);
    const adjustments = validateAdjustments(body.adjustments ?? {});
    const data = await payrollService.calculateAllEmployeesPayroll(month, { adjustmentsOverride: adjustments });
    res.json({ success: true, data });
  });

  public saveAdjustments = handle(async (req: AuthRequest, res: Response) => {
    const month = requireMonth(req.params.month);
    const body = requireObject(req.body);
    const data = await payrollAdjustmentService.saveAdjustments(month, body.adjustments ?? {}, actor(req), body.reason);
    res.json({ success: true, data });
  });

  public clearAdjustments = handle(async (req: AuthRequest, res: Response) => {
    await payrollAdjustmentService.clearAdjustments(requireMonth(req.params.month), actor(req));
    res.json({ success: true, data: { cleared: true } });
  });

  public getAdjustmentHistory = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await payrollAdjustmentService.getAdjustmentHistory(requireMonth(req.params.month)) });
  });

  public sendPayslip = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    if (!isValidEmpCode(body.empCode)) throw ApiError.validation('A valid empCode is required.', [{ field: 'empCode', issue: 'Invalid' }]);
    const month = requireMonth(body.month, 'month');
    const recipient = optionalString(body.recipientEmail, 'recipientEmail', 254);
    const summary = await payrollService.calculateEmployeePayroll(normalizeEmpCode(body.empCode), month);
    if (summary.isProvisional) {
      throw ApiError.rule(`Payroll for ${month} is not closed yet. Payslips are emailed only for closed months.`);
    }
    const result = await emailService.sendPayslipEmail(summary, recipient);
    res.json({ success: true, data: { message: result.message, sentTo: result.sentTo, previewHtml: result.previewHtml } });
  });
}

export const payrollController = new PayrollController();
