import { EmployeeProfile } from './employeeMaster.types.js';
import { daysInMonth } from '../../utils/istTime.js';

/**
 * Employment window: [doj, lastWorkingDay], both inclusive and both optional (no date = no limit on that side).
 * A day outside it is not an absence: the person was not employed, so payroll neither pays it nor counts it as loss of pay.
 */
type Window = Pick<EmployeeProfile, 'doj' | 'lastWorkingDay'>;

export const outsideEmployment = (p: Window, businessDate: string): boolean =>
  (!!p.doj && businessDate < p.doj) || (!!p.lastWorkingDay && businessDate > p.lastWorkingDay);

/** True when the employee was employed on at least one day of the month (otherwise they are not part of that month's payroll). */
export function employedDuring(p: Window, month: string): boolean {
  const days = daysInMonth(month);
  const first = days[0];
  const last = days[days.length - 1];
  return !(p.doj && p.doj > last) && !(p.lastWorkingDay && p.lastWorkingDay < first);
}
