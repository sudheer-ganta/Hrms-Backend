import { Request, Response } from 'express';
import { payrollService } from './payroll.service.js';
import { emailService } from './email.service.js';
import { payrollAdjustmentService } from './payrollAdjustment.service.js';

export class PayrollController {
  public getEmployeePayroll = async (req: Request, res: Response) => {
    try {
      const empCode = req.params.empCode as string;
      const month = req.query.month as string | undefined;
      const summary = await payrollService.calculateEmployeePayroll(empCode, month);
      res.json({ success: true, data: summary });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getAllPayroll = async (req: Request, res: Response) => {
    try {
      const month = req.query.month as string | undefined;
      const summaries = await payrollService.calculateAllEmployeesPayroll(month);
      res.json({
        success: true,
        count: summaries.length,
        data: summaries
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getAdjustments = async (req: Request, res: Response) => {
    try {
      const month = req.params.month as string;
      const data = await payrollAdjustmentService.getAdjustments(month);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public saveAdjustments = async (req: Request, res: Response) => {
    try {
      const month = req.params.month as string;
      const { adjustments } = req.body;
      const user = (req as any).user?.username || (req as any).user?.email || 'Admin';
      const data = await payrollAdjustmentService.saveAdjustments(month, adjustments || {}, user);
      res.json({
        success: true,
        message: 'Overtime adjustments saved to payroll successfully.',
        data,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public clearAdjustments = async (req: Request, res: Response) => {
    try {
      const month = req.params.month as string;
      await payrollAdjustmentService.clearAdjustments(month);
      res.json({
        success: true,
        message: 'Overtime adjustments cleared successfully.',
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public sendPayslip = async (req: Request, res: Response) => {
    try {
      const { empCode, month, recipientEmail } = req.body;
      if (!empCode) {
        return res.status(400).json({ success: false, error: 'empCode is required' });
      }

      const summary = await payrollService.calculateEmployeePayroll(empCode, month);
      const result = await emailService.sendPayslipEmail(summary, recipientEmail);
      
      res.json({
        success: true,
        message: result.message,
        sentTo: result.sentTo,
        previewHtml: result.previewHtml
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

export const payrollController = new PayrollController();

