import { PayrollAdjustmentModel } from './payrollAdjustment.model.js';
import { PayrollAdjustmentAuditModel, IPayrollAdjustmentAudit } from './payrollAdjustmentAudit.model.js';
import { EmployeeOtAdjustment } from './payrollAdjustment.types.js';
import { payrollRunService } from './payrollRun.service.js';
import { ApiError } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { isValidEmpCode, normalizeEmpCode } from '../../utils/empCode.js';
import { optionalNumber, requireMonth, requireObject } from '../../utils/validate.js';

/** Validates the manual OT/Sunday adjustments payload (employee code → adjustment). */
export function validateAdjustments(input: unknown): Record<string, EmployeeOtAdjustment> {
  const body = requireObject(input, 'adjustments');
  const out: Record<string, EmployeeOtAdjustment> = {};
  const entries = Object.entries(body);
  if (entries.length > 5000) throw ApiError.validation('Too many adjustments in one request.');
  for (const [rawCode, value] of entries) {
    if (!isValidEmpCode(rawCode)) throw ApiError.validation(`Invalid employee code "${rawCode}".`, [{ field: `adjustments.${rawCode}`, issue: 'Invalid code' }]);
    const v = requireObject(value, `adjustments.${rawCode}`);
    const adj: EmployeeOtAdjustment = {};
    const otHours = optionalNumber(v.otHours, `${rawCode}.otHours`, { min: 0, max: 744 });
    const totalWorkHours = optionalNumber(v.totalWorkHours, `${rawCode}.totalWorkHours`, { min: 0, max: 744 });
    const multiplier = optionalNumber(v.multiplier, `${rawCode}.multiplier`, { min: 0, max: 10 });
    const weeklyOffWorkDays = optionalNumber(v.weeklyOffWorkDays ?? v.sundayDays, `${rawCode}.weeklyOffWorkDays`, { min: 0, max: 31 }); // sundayDays = legacy alias
    const holidayWorkDays = optionalNumber(v.holidayWorkDays, `${rawCode}.holidayWorkDays`, { min: 0, max: 31 });
    if (otHours !== undefined) adj.otHours = otHours;
    if (totalWorkHours !== undefined) adj.totalWorkHours = totalWorkHours;
    if (multiplier !== undefined) adj.multiplier = multiplier;
    if (weeklyOffWorkDays !== undefined) adj.weeklyOffWorkDays = weeklyOffWorkDays;
    if (holidayWorkDays !== undefined) adj.holidayWorkDays = holidayWorkDays;
    if (Object.keys(adj).length) out[normalizeEmpCode(rawCode)] = adj;
  }
  return out;
}

class PayrollAdjustmentService {
  public async getAdjustments(month: string): Promise<Record<string, EmployeeOtAdjustment>> {
    requireDb();
    const doc = (await PayrollAdjustmentModel.findOne({ month }).lean()) as any;
    return (doc && doc.adjustments) || {};
  }

  public async saveAdjustments(monthInput: string, input: unknown, updatedBy: string, reasonInput?: unknown): Promise<Record<string, EmployeeOtAdjustment>> {
    requireDb();
    const month = requireMonth(monthInput);
    await payrollRunService.assertMonthOpen(month, 'Saving payroll adjustments');
    const adjustments = validateAdjustments(input);
    const previous = await this.getAdjustments(month);

    // Changing the recognized off-day work is a business override of the attendance verdict: it must be explained.
    const offDay = (a?: EmployeeOtAdjustment) => `${a?.weeklyOffWorkDays ?? a?.sundayDays ?? ''}|${a?.holidayWorkDays ?? ''}`;
    const offDayChanged = Array.from(new Set([...Object.keys(previous), ...Object.keys(adjustments)])).some((c) => offDay(previous[c]) !== offDay(adjustments[c]));
    const reason = typeof reasonInput === 'string' ? reasonInput.trim().slice(0, 500) : '';
    if (offDayChanged && reason.length < 5) {
      throw ApiError.validation('A reason (at least 5 characters) is required when overriding weekly-off or holiday work days.', [{ field: 'reason', issue: 'Required' }]);
    }

    await PayrollAdjustmentModel.findOneAndUpdate(
      { month },
      { month, adjustments, updatedBy, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    await this.audit({ month, action: 'SAVE', performedBy: updatedBy, performedAt: new Date(), previousAdjustments: previous, newAdjustments: adjustments, ...(reason ? { reason } : {}) }, previous);
    return adjustments;
  }

  public async clearAdjustments(monthInput: string, clearedBy: string): Promise<void> {
    requireDb();
    const month = requireMonth(monthInput);
    await payrollRunService.assertMonthOpen(month, 'Clearing payroll adjustments');
    const previous = await this.getAdjustments(month);
    await PayrollAdjustmentModel.deleteOne({ month });
    await this.audit({ month, action: 'CLEAR', performedBy: clearedBy, performedAt: new Date(), previousAdjustments: previous, newAdjustments: {} }, previous);
  }

  public async getAdjustmentHistory(monthInput: string): Promise<IPayrollAdjustmentAudit[]> {
    requireDb();
    const month = requireMonth(monthInput);
    return (await PayrollAdjustmentAuditModel.find({ month }).sort({ performedAt: -1 }).lean()) as unknown as IPayrollAdjustmentAudit[];
  }

  /** An unrecorded payroll change is not acceptable: if the audit row cannot be written, the change is rolled back. */
  private async audit(entry: IPayrollAdjustmentAudit, restore: Record<string, EmployeeOtAdjustment>): Promise<void> {
    try {
      await PayrollAdjustmentAuditModel.create(entry);
    } catch (err) {
      console.error('[PayrollAdjustment] audit write failed, rolling back:', err);
      if (Object.keys(restore).length) {
        await PayrollAdjustmentModel.findOneAndUpdate({ month: entry.month }, { month: entry.month, adjustments: restore }, { upsert: true });
      } else {
        await PayrollAdjustmentModel.deleteOne({ month: entry.month });
      }
      throw new ApiError('INTERNAL', 'Could not record the audit trail; the change was not applied.');
    }
  }
}

export const payrollAdjustmentService = new PayrollAdjustmentService();
