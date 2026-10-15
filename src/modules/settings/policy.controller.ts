import { Request, Response } from 'express';
import { policyService, getShiftStandardHours, isOvernightShift, lateThresholdMinutes } from './policy.service.js';
import { minutesToHhmm } from '../../utils/istTime.js';
import { payrollRunService } from '../payroll/payrollRun.service.js';
import { handle, ApiError } from '../../utils/apiError.js';
import { monthOf } from '../../utils/istTime.js';
import { requireObject } from '../../utils/validate.js';
import { validateHolidayInput } from './policy.service.js';

export class PolicyController {
  public getSettings = handle(async (_req: Request, res: Response) => {
    const p = policyService.getSettings();
    // Derived values are computed here so no client ever re-implements the shift math.
    res.json({ success: true, data: { ...p, derived: { standardDayHours: getShiftStandardHours(p.shift), overnightShift: isOvernightShift(p.shift), lateAfter: minutesToHhmm(lateThresholdMinutes(p.shift) % 1440) } } });
  });

  /**
   * Policy changes apply to OPEN months only. Closed months keep the frozen snapshot, so a policy
   * edit can never alter them; payroll reads the new policy when a month is (re)calculated.
   */
  public updateSettings = handle(async (req: Request, res: Response) => {
    const updated = await policyService.updateSettings(req.body);
    res.json({ success: true, data: updated });
  });

  public addHoliday = handle(async (req: Request, res: Response) => {
    const input = validateHolidayInput(requireObject(req.body));
    await payrollRunService.assertMonthOpen(monthOf(input.date), 'Adding this holiday');
    res.status(201).json({ success: true, data: await policyService.addHoliday(input) });
  });

  public removeHoliday = handle(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = policyService.findHoliday(id);
    if (!existing) throw ApiError.notFound('Holiday not found.');
    await payrollRunService.assertMonthOpen(monthOf(existing.date), 'Removing this holiday');
    await policyService.removeHoliday(id);
    res.json({ success: true, data: { removed: true } });
  });
}
