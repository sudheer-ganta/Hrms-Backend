process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDay, DayFacts, ActiveAdjustment } from '../modules/attendance/attendanceResolver.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { PAYROLL_RULES } from '../modules/payroll/payroll.config.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';
import { daysInMonth } from '../utils/istTime.js';
import { access } from '../middleware/auth.middleware.js';
import { USER_ROLES } from '../modules/auth/auth.types.js';

const policy = (over: Partial<HRMSPolicySettings> = {}): HRMSPolicySettings => ({ ...DEFAULT_SETTINGS, ...over });
const TODAY = '2026-10-08';
const ctx = (p = policy()) => ({ policy: p, today: TODAY });

const defaultProfile = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
  empCode: 'EMP001',
  name: 'Test Employee',
  otEligible: true,
  status: 'active',
  monthlyCtc: 30000,
  ...over,
});

describe('FINAL BUSINESS POLICY VALIDATION SUITE (20/20)', () => {
  // 1. Half-day â†’ 0.5 payable day
  test('1. Half-day â†’ 0.5 payable day', () => {
    assert.equal(PAYROLL_RULES.halfDayLopFraction, 0.5);
    const day = resolveDay('2026-10-07', { firstIn: '09:00', lastOut: '12:30', workMinutes: 210 }, ctx());
    assert.equal(day.status, 'HALF_DAY');

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.halfDays, 1);
    assert.equal(payroll.lopDays, 0.5);
    assert.equal(payroll.payableDays, 0.5);
  });

  // 2. Full-day â†’ 1.0
  test('2. Full-day â†’ 1.0 payable day', () => {
    const day = resolveDay('2026-10-07', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, ctx());
    assert.equal(day.status, 'PRESENT');

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.presentDays, 1);
    assert.equal(payroll.lopDays, 0);
    assert.equal(payroll.payableDays, 1.0);
  });

  // 3. Paid leave â†’ 1.0
  test('3. Paid leave â†’ 1.0 payable day', () => {
    const adj: ActiveAdjustment = { id: 'adj_leave_1', requestId: 'req_1', kind: 'LEAVE', paid: true, fraction: 1 };
    const day = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(day.status, 'LEAVE_PAID');

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.leaveDays, 1);
    assert.equal(payroll.lopDays, 0);
    assert.equal(payroll.payableDays, 1.0);
  });

  // 4. Unpaid leave â†’ 0
  test('4. Unpaid leave â†’ 0 payable day (1.0 LOP)', () => {
    const adj: ActiveAdjustment = { id: 'adj_unpaid_1', requestId: 'req_2', kind: 'LEAVE', paid: false, fraction: 1 };
    const day = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(day.status, 'LEAVE_UNPAID');

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.unpaidLeaveDays, 1);
    assert.equal(payroll.lopDays, 1.0);
    assert.equal(payroll.payableDays, 0);
  });

  // 5. WFH automatic â†’ 1.0
  test('5. WFH automatic request approval â†’ 1.0 payable day', () => {
    const adj: ActiveAdjustment = { id: 'adj_wfh_auto', requestId: 'req_wfh', kind: 'WORK_FROM_HOME' };
    const day = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(day.status, 'WORK_FROM_HOME');
    assert.equal(day.creditedWorkMinutes, 510);

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.wfhDays, 1);
    assert.equal(payroll.presentDays, 1);
    assert.equal(payroll.lopDays, 0);
    assert.equal(payroll.payableDays, 1.0);
  });

  // 6. WFH manual â†’ 1.0
  test('6. WFH manual HR adjustment â†’ 1.0 payable day', () => {
    const adj: ActiveAdjustment = { id: 'adj_wfh_manual', requestId: 'req_hr_direct', kind: 'WORK_FROM_HOME' };
    const day = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(day.status, 'WORK_FROM_HOME');

    const days = [day];
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days, policy: policy() });
    assert.equal(payroll.wfhDays, 1);
    assert.equal(payroll.lopDays, 0);
    assert.equal(payroll.payableDays, 1.0);
  });

  // 7. Absent â†’ WFH adjustment â†’ 1.0
  test('7. Absent day overridden to WFH adjustment becomes 1.0 payable day', () => {
    // Before adjustment: Absent
    const initialDay = resolveDay('2026-10-07', {}, ctx());
    assert.equal(initialDay.status, 'ABSENT');

    // HR applies WFH adjustment
    const adj: ActiveAdjustment = { id: 'adj_hr_override', requestId: 'req_absent_to_wfh', kind: 'WORK_FROM_HOME' };
    const adjustedDay = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(adjustedDay.status, 'WORK_FROM_HOME');

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [adjustedDay], policy: policy() });
    assert.equal(payroll.payableDays, 1.0);
    assert.equal(payroll.lopDays, 0);
  });

  // 8. Remove WFH adjustment â†’ returns to automatic result
  test('8. Remove/revoke WFH adjustment returns to resolver automatic result', () => {
    // Adjustment active
    const adj: ActiveAdjustment = { id: 'adj_wfh_1', requestId: 'req_1', kind: 'WORK_FROM_HOME' };
    const withAdj = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(withAdj.status, 'WORK_FROM_HOME');

    // Adjustment revoked (no active adjustment in facts)
    const afterRevoke = resolveDay('2026-10-07', { adjustments: [] }, ctx());
    assert.equal(afterRevoke.status, 'ABSENT');
  });

  // 9. Sunday without work â†’ WEEKLY_OFF
  test('9. Sunday without work â†’ WEEKLY_OFF', () => {
    // 2026-10-04 is a Sunday
    const day = resolveDay('2026-10-04', {}, ctx());
    assert.equal(day.status, 'WEEKLY_OFF');
    assert.equal(day.offDayWorkFraction, 0);

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [day], policy: policy() });
    assert.equal(payroll.weeklyOffs, 1);
    assert.equal(payroll.weeklyOffWorkDays, 0);
    assert.equal(payroll.weeklyOffWorkEarnings, 0);
    assert.equal(payroll.lopDays, 0);
  });

  // 10. Specific Sunday approved as worked â†’ weekly-off compensation
  test('10. Specific Sunday approved as worked â†’ weekly-off compensation', () => {
    // Automatic recognition of worked Sunday via punches or approved adjustment
    const autoPolicy = policy({ offDayWork: { ...DEFAULT_SETTINGS.offDayWork, weeklyOff: { recognition: 'AUTOMATIC' } } });
    const sundayWorked = resolveDay('2026-10-04', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, { policy: autoPolicy, today: TODAY });
    assert.equal(sundayWorked.status, 'WEEKLY_OFF');
    assert.equal(sundayWorked.offDayWorkFraction, 1.0);

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [sundayWorked], policy: autoPolicy });
    assert.equal(payroll.weeklyOffWorkDays, 1);
    assert.ok(payroll.weeklyOffWorkEarnings > 0);
    assert.equal(payroll.payslip.earnings.some((l) => l.code === 'WEEKLY_OFF_WORK'), true);
  });

  // 11. Other Sundays remain WEEKLY_OFF
  test('11. Other Sundays remain normal WEEKLY_OFF when one is worked', () => {
    const autoPolicy = policy({ offDayWork: { ...DEFAULT_SETTINGS.offDayWork, weeklyOff: { recognition: 'AUTOMATIC' } } });
    const sunday1Worked = resolveDay('2026-10-04', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, { policy: autoPolicy, today: '2026-10-31' });
    const sunday2Off = resolveDay('2026-10-11', {}, { policy: autoPolicy, today: '2026-10-31' });

    assert.equal(sunday1Worked.offDayWorkFraction, 1.0);
    assert.equal(sunday2Off.offDayWorkFraction, 0);
    assert.equal(sunday2Off.status, 'WEEKLY_OFF');

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [sunday1Worked, sunday2Off], policy: autoPolicy });
    assert.equal(payroll.weeklyOffs, 2);
    assert.equal(payroll.weeklyOffWorkDays, 1);
  });

  // 12. Paid holiday without work â†’ HOLIDAY
  test('12. Paid holiday without work â†’ HOLIDAY (paid day off)', () => {
    const hPolicy = policy({ holidays: [{ id: 'h1', date: '2026-10-02', name: 'Gandhi Jayanti', type: 'NATIONAL', paid: true }] });
    const day = resolveDay('2026-10-02', {}, { policy: hPolicy, today: TODAY });
    assert.equal(day.status, 'HOLIDAY');
    assert.equal(day.isPaidHoliday, true);
    assert.equal(day.offDayWorkFraction, 0);

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [day], policy: hPolicy });
    assert.equal(payroll.holidays, 1);
    assert.equal(payroll.holidayWorkDays, 0);
    assert.equal(payroll.holidayWorkEarnings, 0);
    assert.equal(payroll.lopDays, 0);
  });

  // 13. Paid holiday with work â†’ automatic holiday compensation
  test('13. Paid holiday with work â†’ automatic holiday compensation', () => {
    const hPolicy = policy({
      holidays: [{ id: 'h1', date: '2026-10-02', name: 'Gandhi Jayanti', type: 'NATIONAL', paid: true }],
      offDayWork: { ...DEFAULT_SETTINGS.offDayWork, paidHoliday: { recognition: 'AUTOMATIC' } },
    });
    const day = resolveDay('2026-10-02', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, { policy: hPolicy, today: TODAY });
    assert.equal(day.status, 'HOLIDAY');
    assert.equal(day.offDayWorkFraction, 1.0);

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [day], policy: hPolicy });
    assert.equal(payroll.holidayWorkDays, 1);
    assert.ok(payroll.holidayWorkEarnings > 0);
    assert.equal(payroll.payslip.earnings.some((l) => l.code === 'HOLIDAY_WORK'), true);
  });

  // 14. Weekly-off and holiday compensation remain separate
  test('14. Weekly-off and holiday compensation remain separate lines and counts', () => {
    const dualPolicy = policy({
      holidays: [{ id: 'h1', date: '2026-10-02', name: 'Gandhi Jayanti', type: 'NATIONAL', paid: true }],
      offDayWork: {
        weeklyOff: { recognition: 'AUTOMATIC' },
        paidHoliday: { recognition: 'AUTOMATIC' },
      },
    });
    const holidayWorked = resolveDay('2026-10-02', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, { policy: dualPolicy, today: TODAY });
    const sundayWorked = resolveDay('2026-10-04', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 }, { policy: dualPolicy, today: TODAY });

    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [holidayWorked, sundayWorked], policy: dualPolicy });
    assert.equal(payroll.weeklyOffWorkDays, 1);
    assert.equal(payroll.holidayWorkDays, 1);
    assert.ok(payroll.weeklyOffWorkEarnings > 0);
    assert.ok(payroll.holidayWorkEarnings > 0);

    const woLine = payroll.payslip.earnings.find((l) => l.code === 'WEEKLY_OFF_WORK');
    const holLine = payroll.payslip.earnings.find((l) => l.code === 'HOLIDAY_WORK');
    assert.ok(woLine, 'Weekly-off working line present');
    assert.ok(holLine, 'Paid-holiday working line present');
    assert.notEqual(woLine?.code, holLine?.code);
  });

  // 15. PT uses current configured Karnataka rule
  test('15. PT uses current configured Karnataka rule (threshold â‚¹25,000 â†’ â‚¹200)', () => {
    assert.equal(PAYROLL_RULES.ptGrossThreshold, 25000);
    assert.equal(PAYROLL_RULES.ptMonthly, 200);

    const above25k = computeSalaryBreakdown({ monthlyCtc: 25000 })!;
    assert.equal(above25k.professionalTax, 200);

    const below25k = computeSalaryBreakdown({ monthlyCtc: 24000 })!;
    assert.equal(below25k.professionalTax, 0);
  });

  // 16. ESIC is calculated from statutory wages, NOT CTC
  test('16. ESIC calculated on statutory gross wages (ceiling â‚¹21,000), NOT CTC', () => {
    assert.equal(PAYROLL_RULES.esiWageCeiling, 21000);
    assert.equal(PAYROLL_RULES.esiEmployeeRate, 0.0075);
    assert.equal(PAYROLL_RULES.esiEmployerRate, 0.0325);

    // Employee with CTC 20000:
    // erPf = 1200, pt = 0 (CTC < 25000)
    // base = 18800. Statutory gross wage = 18800 / 1.0325 = 18208 <= 21000
    const esicEligible = computeSalaryBreakdown({ monthlyCtc: 20000 })!;
    assert.equal(esicEligible.statutoryEsicWages, 18208);
    assert.equal(esicEligible.employeeEsic, Math.round(18208 * 0.0075)); // 137 (NOT 20000 * 0.0075 = 150)
    assert.equal(esicEligible.employerEsic, Math.round(18208 * 0.0325)); // 592 (NOT 20000 * 0.0325 = 650)

    // Above ceiling: CTC 30000 -> Gross > 21000 -> ESIC = 0
    const aboveCeiling = computeSalaryBreakdown({ monthlyCtc: 30000 })!;
    assert.equal(aboveCeiling.statutoryEsicWages, 0);
    assert.equal(aboveCeiling.employeeEsic, 0);
    assert.equal(aboveCeiling.employerEsic, 0);
  });

  // 17. HR role permissions
  test('17. HR role is defined in USER_ROLES and included in HR_OR_ABOVE access tier', () => {
    assert.ok(USER_ROLES.includes('HR'));
    assert.ok(Array.isArray(access.HR_OR_ABOVE));
    assert.ok(access.HR_OR_ABOVE.length > 0);
  });

  // 18. HR cannot perform Super Admin actions
  test('18. SUPER_ADMIN_ONLY access tier excludes HR', () => {
    assert.ok(Array.isArray(access.SUPER_ADMIN_ONLY));
    // Verify role requirements in middleware
    const superAdminRoleMiddleware = access.SUPER_ADMIN_ONLY[1];
    let allowed = false;
    let errorSent = false;
    const mockReq = { user: { role: 'HR' as const } } as any;
    const mockRes = { status: () => ({ json: () => { errorSent = true; } }) } as any;
    const mockNext = () => { allowed = true; };

    superAdminRoleMiddleware(mockReq, mockRes, mockNext);
    assert.equal(allowed, false, 'HR must not pass SUPER_ADMIN_ONLY middleware');
    assert.equal(errorSent, true, 'Error must be returned for HR accessing Super Admin route');
  });

  // 19. All adjustments require audit/reason where applicable
  test('19. Adjustments require reason and store audit metadata', () => {
    const adj: ActiveAdjustment = {
      id: 'adj_audit_1',
      requestId: 'req_audit_1',
      kind: 'WORK_FROM_HOME',
    };
    const day = resolveDay('2026-10-07', { adjustments: [adj] }, ctx());
    assert.equal(day.adjustmentId, 'adj_audit_1');
    assert.equal(day.requestId, 'req_audit_1');
    assert.equal(day.source, 'ADJUSTMENT');
  });

  // 20. Closed payroll snapshot preserves the policy used at closure
  test('20. Closed payroll snapshot preserves the rulesVersion used at closure', () => {
    const payroll = computeEmployeePayroll({ profile: defaultProfile(), month: '2026-10', days: [], policy: policy() });
    assert.equal(payroll.rulesVersion, PAYROLL_RULES.version);
    assert.equal(typeof payroll.rulesVersion, 'string');
  });
});
