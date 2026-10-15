import { HRMSPolicySettings } from '../settings/policy.types.js';
import { datesBetween } from '../../utils/istTime.js';
import { isHolidayDate, isWeeklyOffDate } from '../attendance/attendanceResolver.js';

export { datesBetween };

/** Dates in the range that actually consume leave: weekly offs and paid holidays do not. */
export const leaveWorkingDates = (start: string, end: string, policy: HRMSPolicySettings): string[] =>
  datesBetween(start, end).filter((d) => !isHolidayDate(d, policy) && !isWeeklyOffDate(d, policy));

/** Leave days to deduct for a request (0.5 for a single half-day). */
export const leaveDaysFor = (start: string, end: string, policy: HRMSPolicySettings, halfDay = false): number => {
  const n = leaveWorkingDates(start, end, policy).length;
  return halfDay && start === end && n === 1 ? 0.5 : n;
};
