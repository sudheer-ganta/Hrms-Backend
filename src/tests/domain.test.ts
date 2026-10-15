process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmpCode, isValidEmpCode } from '../utils/empCode.js';
import {
  businessDateFromInstant, istToday, istMonth, instantFromIst, durationMinutes, dayNameOf, monthsInRange, daysInMonth, isValidBusinessDate,
} from '../utils/istTime.js';
import { parseVendorPunchDate, convertDateStringToISO } from '../utils/dateUtils.js';
import { createRawPunchHash } from '../utils/hashUtils.js';
import { resolveDay, DayFacts } from '../modules/attendance/attendanceResolver.js';
import { DEFAULT_SETTINGS, validatePolicyUpdate, validateHolidayInput, getShiftStandardHours } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { PAYROLL_RULES } from '../modules/payroll/payroll.config.js';
import { leaveDaysFor, leaveWorkingDates } from '../modules/requests/leaveDays.js';
import { matchSiteByGeo } from '../modules/sites/site.service.js';
import { escapeRegex } from '../utils/validate.js';
import { assertStrongPassword } from '../utils/password.js';
import { toApiError, ApiError } from '../utils/apiError.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';

const policy = (over: Partial<HRMSPolicySettings> = {}): HRMSPolicySettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
  overtime: { ...DEFAULT_SETTINGS.overtime, recognition: 'AUTOMATIC', ...(over.overtime || {}) },
});
// 2026-09-02 is a Wednesday; 2026-09-06 is a Sunday.
const TODAY = '2026-10-08';
const ctx = (p = policy()) => ({ policy: p, today: TODAY });

describe('identity', () => {
  test('abc001 == ABC001 == " ABC001 "', () => {
    assert.equal(normalizeEmpCode('abc001'), 'ABC001');
    assert.equal(normalizeEmpCode(' ABC001 '), 'ABC001');
    assert.equal(normalizeEmpCode('abc001'), normalizeEmpCode(' ABC001 '));
  });
  test('validation', () => {
    assert.ok(isValidEmpCode('00132'));
    assert.ok(isValidEmpCode('a-132'));
    assert.ok(!isValidEmpCode(''));
    assert.ok(!isValidEmpCode('has space'));
    assert.ok(!isValidEmpCode('$where'));
  });
});

describe('IST time contract', () => {
  test('instant → IST business date crosses midnight correctly', () => {
    // 2026-10-07T20:00Z is 01:30 IST on the 8th
    assert.equal(businessDateFromInstant(new Date('2026-10-07T20:00:00Z')), '2026-10-08');
    assert.equal(businessDateFromInstant(new Date('2026-10-07T18:29:00Z')), '2026-10-07');
    assert.equal(istMonth(new Date('2026-09-30T19:00:00Z')), '2026-10'); // 00:30 IST on 1 Oct
  });
  test('instantFromIst round-trips', () => {
    const i = instantFromIst('2026-10-08', '09:15:30');
    assert.equal(i.toISOString(), '2026-10-08T03:45:30.000Z');
    assert.equal(businessDateFromInstant(i), '2026-10-08');
  });
  test('overnight 22:00 → 06:00 is 8 hours, not 0', () => {
    assert.equal(durationMinutes('22:00', '06:00'), 480);
    assert.equal(durationMinutes('09:00', '17:30'), 510);
    assert.equal(durationMinutes('09:00', null), 0);
  });
  test('day names / months / ranges are timezone independent', () => {
    assert.equal(dayNameOf('2026-09-06'), 'SUNDAY');
    assert.equal(dayNameOf('2026-09-02'), 'WEDNESDAY');
    assert.deepEqual(monthsInRange('2026-11-20', '2027-01-05'), ['2026-11', '2026-12', '2027-01']);
    assert.equal(daysInMonth('2026-02').length, 28);
    assert.ok(!isValidBusinessDate('2026-02-30'));
  });
  test('vendor punch date is parsed as IST wall clock, independent of server timezone', () => {
    const p = parseVendorPunchDate('08/10/2026 09:05:07');
    assert.equal(p.entryDate, '2026-10-08');
    assert.equal(p.entryTime, '09:05:07');
    assert.equal(p.punchDateTime.toISOString(), '2026-10-08T03:35:07.000Z');
    assert.equal(convertDateStringToISO('08/10/2026'), '2026-10-08');
    assert.throws(() => parseVendorPunchDate('garbage'));
  });
  test('raw punch hash is deterministic and case/whitespace stable', () => {
    const a = createRawPunchHash({ origin: 'DEVICE', sourceId: 'Budigere', employeeCode: ' abc1 ', entryDate: '2026-10-08', entryTime: '09:00:00', machineId: '3' });
    const b = createRawPunchHash({ origin: 'device', sourceId: 'budigere', employeeCode: 'ABC1', entryDate: '2026-10-08', entryTime: '09:00:00', machineId: '3' });
    assert.equal(a, b);
  });
});

describe('attendance resolver (the single authority)', () => {
  const day = (date: string, facts?: DayFacts, p = policy()) => resolveDay(date, facts, ctx(p));

  test('08:55 → 17:30 (510 min) = PRESENT', () => {
    const r = day('2026-10-07', { firstIn: '08:55', lastOut: '17:30', workMinutes: 515, punchCount: 2 });
    assert.equal(r.status, 'PRESENT');
    assert.equal(r.isLate, false);
  });
  test('full-day and half-day thresholds', () => {
    assert.equal(day('2026-10-07', { firstIn: '09:00', lastOut: '15:00', workMinutes: 360 }).status, 'PRESENT'); // = full threshold
    assert.equal(day('2026-10-07', { firstIn: '09:00', lastOut: '14:59', workMinutes: 359 }).status, 'HALF_DAY');
    assert.equal(day('2026-10-07', { firstIn: '09:00', lastOut: '12:00', workMinutes: 180 }).status, 'HALF_DAY');
    assert.equal(day('2026-10-07', { firstIn: '09:00', lastOut: '11:59', workMinutes: 179 }).status, 'ABSENT');
  });
  test('late checkout rule: out at/after 16:00 with >= half-day minutes counts as PRESENT', () => {
    assert.equal(day('2026-10-07', { firstIn: '12:30', lastOut: '16:05', workMinutes: 215 }).status, 'PRESENT');
  });
  test('single swipe is a paid MISSED_PUNCH (not absent), credited a standard day', () => {
    const r = day('2026-10-07', { firstIn: '09:10', lastOut: null, workMinutes: 0, punchCount: 1 });
    assert.equal(r.status, 'MISSED_PUNCH');
    assert.equal(r.creditedWorkMinutes, 510);
  });
  test('no data on a working day = ABSENT; future day has no status', () => {
    assert.equal(day('2026-10-07').status, 'ABSENT');
    const f = day('2026-10-09');
    assert.equal(f.status, null);
    assert.equal(f.isFuture, true);
  });
  test('weekly off (Sunday) and holiday beat everything, driven by policy not hard-coding', () => {
    assert.equal(day('2026-10-04', { firstIn: '09:00', lastOut: '18:00', workMinutes: 540 }).status, 'WEEKLY_OFF'); // Sunday
    const p = policy({ weeklyOffDays: ['SUNDAY', 'SATURDAY'] });
    assert.equal(day('2026-10-03', undefined, p).status, 'WEEKLY_OFF'); // Saturday now off
    assert.equal(day('2026-10-03', undefined, policy()).status, 'ABSENT'); // Saturday is a working day by default
    const h = policy({ holidays: [{ id: 'h1', date: '2026-10-07', name: 'Fest', type: 'FESTIVAL', paid: true }] });
    assert.equal(day('2026-10-07', undefined, h).status, 'HOLIDAY');
  });
  test('OPTIONAL holiday is NOT a company day-off unless explicitly paid', () => {
    const notPaid = policy({ holidays: [{ id: 'h', date: '2026-10-07', name: 'Opt', type: 'OPTIONAL', paid: false }] });
    assert.equal(day('2026-10-07', undefined, notPaid).status, 'ABSENT');
    const paid = policy({ holidays: [{ id: 'h', date: '2026-10-07', name: 'Opt', type: 'OPTIONAL', paid: true }] });
    assert.equal(day('2026-10-07', undefined, paid).status, 'HOLIDAY');
    assert.equal(validateHolidayInput({ date: '2026-10-07', name: 'x', type: 'OPTIONAL' }).paid, false);
    assert.equal(validateHolidayInput({ date: '2026-10-07', name: 'x', type: 'FESTIVAL' }).paid, true);
  });
  test('paid leave is LEAVE_PAID (never absent); unpaid leave costs pay', () => {
    const paid = day('2026-10-07', { adjustments: [{ id: 'a', requestId: 'r', kind: 'LEAVE', paid: true }] });
    assert.equal(paid.status, 'LEAVE_PAID');
    const unpaid = day('2026-10-07', { adjustments: [{ id: 'a', requestId: 'r', kind: 'LEAVE', paid: false }] });
    assert.equal(unpaid.status, 'LEAVE_UNPAID');
  });
  test('WFH and On-Duty are their own statuses; regularization yields PRESENT with the approved times', () => {
    assert.equal(day('2026-10-07', { adjustments: [{ id: 'a', requestId: 'r', kind: 'WORK_FROM_HOME' }] }).status, 'WORK_FROM_HOME');
    assert.equal(day('2026-10-07', { adjustments: [{ id: 'a', requestId: 'r', kind: 'ON_DUTY' }] }).status, 'ON_DUTY');
    const reg = day('2026-10-07', { firstIn: '09:10', adjustments: [{ id: 'a', requestId: 'r', kind: 'MISSED_PUNCH', inTime: '09:00', outTime: '18:00' }] });
    assert.equal(reg.status, 'PRESENT');
    assert.equal(reg.workMinutes, 540);
    assert.equal(reg.lastOut, '18:00');
  });
  test('vendor verdicts are stored as vendorStatus but the canonical status is returned', () => {
    const r = day('2026-10-07', { firstIn: '09:00', lastOut: '13:00', workMinutes: 240, vendorStatus: 'P/2' });
    assert.equal(r.status, 'HALF_DAY');
    assert.equal(r.vendorStatus, 'P/2');
    // vendor "A" with enough hours is re-derived by OUR policy
    assert.equal(day('2026-10-07', { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, vendorStatus: 'A' }).status, 'PRESENT');
  });
  test('overnight shift 22:00-06:00 is a full day when policy is overnight', () => {
    const p = policy({ shift: { ...DEFAULT_SETTINGS.shift, startTime: '22:00', endTime: '06:00', minCheckoutForFullDay: '' } });
    assert.equal(getShiftStandardHours(p.shift), 8);
    const r = day('2026-10-07', { firstIn: '22:00', lastOut: '06:00', punchCount: 2 }, p);
    assert.equal(r.workMinutes, 480);
    assert.equal(r.status, 'PRESENT');
  });
  test('late follows policy (shift start + grace), not a hard-coded 09:30', () => {
    assert.equal(day('2026-10-07', { firstIn: '09:45', lastOut: '18:00', workMinutes: 500 }).isLate, false); // grace 60 → until 10:00
    assert.equal(day('2026-10-07', { firstIn: '10:05', lastOut: '18:00', workMinutes: 500 }).isLate, true);
  });
  test('overtime honors the policy switch', () => {
    const f: DayFacts = { firstIn: '09:00', lastOut: '19:00', workMinutes: 600 };
    assert.equal(day('2026-10-07', f).overtimeMinutes, 90); // 600 - 510
    const off = policy({ overtime: { enabled: false, hoursPerDay: 8 } });
    assert.equal(day('2026-10-07', f, off).overtimeMinutes, 0);
  });
});

describe('salary: one formula', () => {
  test('CTC 30000 → Annexure K breakdown (Karnataka PT threshold >= 25000)', () => {
    const s = computeSalaryBreakdown({ monthlyCtc: 30000 })!;
    assert.equal(s.basicSalary, 15000);
    assert.equal(s.hra, 6000);
    assert.equal(s.employerPf, 1800); // min(1800, 12% of 15000)
    assert.equal(s.employeePf, 1800);
    assert.equal(s.professionalTax, 200); // CTC >= 25000
    assert.equal(s.employerEsic, 0); // Gross > ESIC ceiling 21000
    assert.equal(s.statutoryEsicWages, 0);
    assert.equal(s.grossSalary, 30000 - 1800 - 0 - 200);
    assert.equal(s.specialAllowance, s.grossSalary - 15000 - 6000);
    assert.equal(s.totalNetSalary, s.grossSalary - 1800);
  });
  test('ESIC applies on statutory gross wages (<= 21000 wage ceiling), NOT CTC', () => {
    const s = computeSalaryBreakdown({ monthlyCtc: 20000 })!;
    assert.equal(s.professionalTax, 0); // CTC < 25000
    const expectedWages = Math.round((20000 - 1200) / (1 + 0.0325)); // 18208
    assert.equal(s.statutoryEsicWages, expectedWages);
    assert.equal(s.employeeEsic, Math.round(expectedWages * 0.0075));
    assert.equal(s.employerEsic, Math.round(expectedWages * 0.0325));
    assert.equal(s.grossSalary, 20000 - 1200 - s.employerEsic);
  });
  test('explicit overrides win, and CTC 0 yields no breakdown', () => {
    assert.equal(computeSalaryBreakdown({ monthlyCtc: 30000, professionalTax: 0 })!.professionalTax, 0);
    assert.equal(computeSalaryBreakdown({ monthlyCtc: 0 }), null);
  });
});

describe('payroll engine', () => {
  const profile = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
    empCode: 'E1', name: 'Test', otEligible: true, status: 'active', monthlyCtc: 30000, ...over,
  });
  /** Builds the resolved days of September 2026 (30 days; Sundays 6/13/20/27 are off). */
  const month = (status: Record<string, DayFacts | undefined>, p = policy()) =>
    daysInMonth('2026-09').map((d) => resolveDay(d, status[d], { policy: p, today: '2026-10-05' }));
  const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };
  const allWorking = (): Record<string, DayFacts | undefined> => Object.fromEntries(daysInMonth('2026-09').map((d) => [d, full]));

  test('perfect month: no LOP, net = gross - PF, payslip foots exactly', () => {
    const r = computeEmployeePayroll({ profile: profile(), month: '2026-09', days: month(allWorking()), policy: policy() });
    assert.equal(r.lopDays, 0);
    assert.equal(r.elapsedDays, 30);
    assert.equal(r.weeklyOffs, 4);
    const sal = computeSalaryBreakdown({ monthlyCtc: 30000 })!;
    assert.equal(r.netPayable, Math.round(sal.grossSalary - sal.employeePf));
    assert.equal(r.payslip.totalEarnings - r.payslip.totalDeductions, r.payslip.netPay);
    assert.equal(r.payslip.netPay, r.netPayable);
  });

  test('payslip foots to net pay with LOP, OT, Sunday and partial month', () => {
    const w = allWorking();
    w['2026-09-02'] = undefined; // absent
    w['2026-09-03'] = { firstIn: '09:00', lastOut: '19:00', workMinutes: 600, vendorOvertimeMinutes: 90 } as DayFacts; // OT 1.5h
    const days = daysInMonth('2026-09').map((d) => resolveDay(d, w[d], { policy: policy(), today: '2026-09-20' })); // mid-month
    const r = computeEmployeePayroll({ profile: profile(), month: '2026-09', days, policy: policy(), adjustment: { weeklyOffWorkDays: 1 } });
    assert.equal(r.isProvisional, true);
    assert.ok(r.elapsedDays < r.monthDays);
    assert.ok(r.lopDays === 1);
    assert.ok(r.otEarnings > 0 && r.weeklyOffWorkEarnings > 0);
    const sum = (ls: { amount: number }[]) => ls.reduce((a, l) => a + l.amount, 0);
    assert.ok(Math.abs(sum(r.payslip.earnings) - sum(r.payslip.deductions) - r.netPayable) < 0.01, 'earnings - deductions == net');
  });

  test('OT = (Basic+DA)/26/8 x multiplier x hours', () => {
    const w = allWorking();
    w['2026-09-03'] = { firstIn: '09:00', lastOut: '19:00', workMinutes: 600, vendorOvertimeMinutes: 120 } as DayFacts;
    const r = computeEmployeePayroll({ profile: profile({ da: 0 }), month: '2026-09', days: month(w), policy: policy() });
    const hourly = 15000 / 26 / 8;
    assert.equal(r.totalOtHours, 2);
    assert.ok(Math.abs(r.otEarnings - Math.round(2 * hourly * 2 * 100) / 100) < 0.011);
  });

  test('half-day = 0.5 payable day (0.5 LOP day deduction)', () => {
    assert.equal(PAYROLL_RULES.halfDayLopFraction, 0.5);
    const w = allWorking();
    w['2026-09-02'] = { firstIn: '09:00', lastOut: '12:30', workMinutes: 210 } as DayFacts; // half day
    const r = computeEmployeePayroll({ profile: profile(), month: '2026-09', days: month(w), policy: policy() });
    assert.equal(r.halfDays, 1);
    assert.equal(r.lopDays, 0.5);
    assert.equal(r.payableDays, 29.5);
  });

  test('PT: shown as employer-borne information, never as a phantom deduction', () => {
    const r = computeEmployeePayroll({ profile: profile(), month: '2026-09', days: month(allWorking()), policy: policy() });
    assert.equal(r.ptDeduction, 200);
    assert.equal(r.ptDeductedFromNet, false);
    assert.ok(!r.payslip.deductions.some((l) => l.code === 'PT'));
    assert.ok(r.payslip.employerBorne.some((l) => l.code === 'PT'));
  });

  test('paid leave is not LOP (1.0 payable); unpaid leave is 1.0 LOP', () => {
    const w: Record<string, DayFacts | undefined> = allWorking();
    w['2026-09-02'] = { adjustments: [{ id: 'a', requestId: 'r', kind: 'LEAVE', paid: true }] };
    w['2026-09-03'] = { adjustments: [{ id: 'b', requestId: 'r2', kind: 'LEAVE', paid: false }] };
    const r = computeEmployeePayroll({ profile: profile(), month: '2026-09', days: month(w), policy: policy() });
    assert.equal(r.leaveDays, 1);
    assert.equal(r.unpaidLeaveDays, 1);
    assert.equal(r.lopDays, 1);
    assert.equal(r.payableDays, 29);
  });

  test('legacy otRatePerHour overload still honored; explicit otMultiplier wins', () => {
    const w = allWorking();
    w['2026-09-03'] = { firstIn: '09:00', lastOut: '19:00', workMinutes: 600, vendorOvertimeMinutes: 60 } as DayFacts;
    const legacy = computeEmployeePayroll({ profile: profile({ otRatePerHour: 1.5 }), month: '2026-09', days: month(w), policy: policy() });
    assert.equal(legacy.otMultiplier, 1.5);
    const explicit = computeEmployeePayroll({ profile: profile({ otMultiplier: 3 }), month: '2026-09', days: month(w), policy: policy() });
    assert.equal(explicit.otMultiplier, 3);
    const absolute = computeEmployeePayroll({ profile: profile({ otRatePerHour: 200 }), month: '2026-09', days: month(w), policy: policy() });
    assert.equal(absolute.otRatePerHour, 200);
  });

  test('no salary configured → zero pay, clearly labelled', () => {
    const r = computeEmployeePayroll({ profile: profile({ monthlyCtc: undefined }), month: '2026-09', days: month(allWorking()), policy: policy() });
    assert.equal(r.netPayable, 0);
    assert.equal(r.netPayableWords, 'Salary Not Configured');
  });
});


describe('leave day counting', () => {
  test('weekly offs and paid holidays do not consume leave', () => {
    const p = policy({ holidays: [{ id: 'h', date: '2026-10-07', name: 'x', type: 'FESTIVAL', paid: true }] });
    // Mon 5 .. Sun 11 Oct 2026: holiday on Wed 7, Sunday 11 off
    assert.deepEqual(leaveWorkingDates('2026-10-05', '2026-10-11', p), ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10']);
    assert.equal(leaveDaysFor('2026-10-05', '2026-10-05', p, true), 0.5);
    assert.equal(leaveDaysFor('2026-10-11', '2026-10-11', p), 0); // Sunday
  });
});

describe('validation, safety and contracts', () => {
  test('policy update is whitelisted and range-checked', () => {
    assert.throws(() => validatePolicyUpdate({ shift: { startTime: '25:99' } }));
    assert.throws(() => validatePolicyUpdate({ weeklyOffDays: ['FUNDAY'] }));
    assert.throws(() => validatePolicyUpdate({ shift: { halfDayThresholdMinutes: 400, fullDayThresholdMinutes: 300 } }));
    const ok = validatePolicyUpdate({ weeklyOffDays: ['sunday', 'saturday'], holidays: [{ evil: true }], $where: 'x' });
    assert.deepEqual(ok.weeklyOffDays, ['SUNDAY', 'SATURDAY']);
    assert.equal((ok as any).holidays, undefined);
    assert.equal((ok as any).$where, undefined);
  });
  test('regex search input is escaped', () => {
    const rx = new RegExp(escapeRegex('(a+)+$'), 'i');
    assert.ok(rx.test('(a+)+$'));
    assert.ok(!rx.test('aaaa'));
  });
  test('password policy', () => {
    assert.throws(() => assertStrongPassword('short1'));
    assert.throws(() => assertStrongPassword('onlyletterslongenough'));
    assert.throws(() => assertStrongPassword('a@b.com', 'a@b.com'));
    assert.equal(assertStrongPassword('Good-pass-2026'), 'Good-pass-2026');
  });
  test('errors map to canonical codes and never leak internals', () => {
    assert.equal(toApiError(new ApiError('CONFLICT', 'x')).statusCode, 409);
    assert.equal(ApiError.rule('r').statusCode, 422);
    const mongo = toApiError({ name: 'MongoServerError', code: 11000, message: 'E11000 dup key {secret}' });
    assert.equal(mongo.code, 'CONFLICT');
    assert.ok(!mongo.message.includes('secret'));
    const unknown = toApiError(new Error('Cannot read property x of undefined'));
    assert.equal(unknown.code, 'INTERNAL');
    assert.equal(unknown.message, 'Internal server error.');
  });
  test('geofence: inside, outside, and unconfigured sites', () => {
    const sites = [{ siteId: 'a', name: 'A', displayName: 'A', active: true, geo: { lat: 13.0, lng: 77.0, radiusM: 200 } }, { siteId: 'b', name: 'B', displayName: 'B', active: true }];
    assert.equal(matchSiteByGeo(sites, 13.0005, 77.0, )?.site.siteId, 'a');
    assert.equal(matchSiteByGeo(sites, 13.01, 77.0), null);
  });
});
