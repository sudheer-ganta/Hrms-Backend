import { AttendanceDayModel } from '../attendance/attendanceDay.model.js';
import { isHolidayDate, isWeeklyOffDate } from '../attendance/attendanceResolver.js';
import { HRMSPolicySettings } from '../settings/policy.types.js';
import { requireDb } from '../../config/db.js';
import { daysInMonth } from '../../utils/istTime.js';

/**
 * Did attendance for the month actually reach the database?
 *
 * A past day with no stored punch is resolved as ABSENT (loss of pay), so a month whose punches were never
 * synced would lock with everybody on LOP. A working day (not a weekly off / paid holiday) on which NOBODY in
 * the company has a single stored punch is therefore treated as "attendance missing", not as a company-wide absence.
 */
export interface AttendanceCoverage {
  month: string;
  /** Working days that have already elapsed (weekly offs and paid holidays excluded). */
  workingDays: number;
  /** Working days with at least one punch stored for somebody. */
  daysWithData: number;
  /** Working days with no punch for anyone: these need a vendor sync (or a recompute) before payroll is trustworthy. */
  missingDates: string[];
}

/** Pure part, so the rule is testable without a database. */
export function computeCoverage(
  month: string, dates: string[], datesWithPunches: Set<string>, policy: HRMSPolicySettings, today: string
): AttendanceCoverage {
  const working = dates.filter((d) => d <= today && !isWeeklyOffDate(d, policy) && !isHolidayDate(d, policy));
  const missingDates = working.filter((d) => !datesWithPunches.has(d));
  return { month, workingDays: working.length, daysWithData: working.length - missingDates.length, missingDates };
}

export async function attendanceCoverage(month: string, policy: HRMSPolicySettings, today: string): Promise<AttendanceCoverage> {
  requireDb();
  const dates = daysInMonth(month);
  const have: string[] = await AttendanceDayModel.distinct('businessDate', {
    businessDate: { $gte: dates[0], $lte: dates[dates.length - 1] },
    $or: [{ punchCount: { $gt: 0 } }, { workMinutes: { $gt: 0 } }],
  });
  return computeCoverage(month, dates, new Set(have), policy, today);
}
