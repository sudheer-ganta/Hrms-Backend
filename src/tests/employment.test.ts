import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { employedDuring, outsideEmployment } from '../modules/employees/employment.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { pickSalary } from '../modules/employees/salaryRevisions.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { resolveDay } from '../modules/attendance/attendanceResolver.js';
import { daysInMonth } from '../utils/istTime.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';

const SEPT = '2026-09';
const profile = (over: Partial<EmployeeProfile> = {}): EmployeeProfile =>
  ({ empCode: 'E1', name: 'T', otEligible: true, status: 'active', ...pickSalary(computeSalaryBreakdown({ monthlyCtc: 30000 })!), ...over });
// everyone who has a punch is present; Sundays are weekly offs (default policy)
const run = (p: EmployeeProfile, month = SEPT) => {
  const days = daysInMonth(month).map((d) => resolveDay(d, { firstIn: '09:00', lastOut: '18:00', workMinutes: 540, punchCount: 2 }, { policy: DEFAULT_SETTINGS, today: '2026-11-30' }));
  return computeEmployeePayroll({ profile: p, month, days, policy: DEFAULT_SETTINGS });
};

describe('employment window in payroll', () => {
  test('window helpers: inclusive dates, open-ended when a date is missing', () => {
    const p = { doj: '2026-09-16', lastWorkingDay: '2026-10-10' };
    assert.equal(outsideEmployment(p, '2026-09-15'), true);
    assert.equal(outsideEmployment(p, '2026-09-16'), false);
    assert.equal(outsideEmployment(p, '2026-10-10'), false);
    assert.equal(outsideEmployment(p, '2026-10-11'), true);
    assert.equal(outsideEmployment({}, '1999-01-01'), false);
    assert.equal(employedDuring(p, '2026-08'), false);
    assert.equal(employedDuring(p, '2026-09'), true);
    assert.equal(employedDuring(p, '2026-10'), true);
    assert.equal(employedDuring(p, '2026-11'), false);
  });

  test('a mid-month joiner is not shown as absent before joining, and is paid only for the days from joining', () => {
    const full = run(profile());
    const joiner = run(profile({ doj: '2026-09-16' }));
    assert.equal(joiner.notEmployedDays, 15);
    assert.equal(joiner.absentDays, 0);
    assert.equal(joiner.lopDays, 0);
    assert.equal(joiner.elapsedDays, 30, 'the calendar month is still fully elapsed (month close relies on it)');
    assert.equal(joiner.payableDays, 15);
    const line = joiner.payslip.deductions.find((l) => l.code === 'NOT_EMPLOYED');
    assert.ok(line, 'the unpaid days are an explicit payslip line');
    // the gross is cut by the 15 outside days, and PF / PT follow what was actually earned (statement method)
    assert.ok(joiner.pfDeduction < full.pfDeduction, 'PF is worked out on the earned wages');
    assert.equal(joiner.ptDeduction, 0, 'half a month of pay is below the PT line');
    assert.ok(joiner.netPayable < full.netPayable);
    assert.equal(joiner.payslip.totalEarnings - joiner.payslip.totalDeductions, joiner.netPayable, 'the payslip still foots');
  });

  test('a leaver is paid up to the last working day only', () => {
    const leaver = run(profile({ lastWorkingDay: '2026-09-10' }));
    assert.equal(leaver.notEmployedDays, 20);
    assert.equal(leaver.lopDays, 0);
    assert.equal(leaver.payableDays, 10);
  });

  test('someone fully employed (or with no dates, as every existing profile) is unaffected', () => {
    const r = run(profile());
    assert.equal(r.notEmployedDays, 0);
    assert.equal(r.payslip.deductions.some((l) => l.code === 'NOT_EMPLOYED'), false);
    assert.equal(r.payableDays, 30);
  });
});
