process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, businessDateFromInstant, instantFromIst, addDays } from '../utils/istTime.js';
import { resolveDay, DayFacts, ResolvedDay } from '../modules/attendance/attendanceResolver.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { PAYROLL_RULES as R } from '../modules/payroll/payroll.config.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';

/**
 * Payroll edge-case matrix. Every case runs the REAL resolver and the REAL payroll formula.
 * September 2026: 30 days, Sundays 6/13/20/27 are weekly offs. Default policy unless stated.
 */
const policy = (over: Partial<HRMSPolicySettings> = {}): HRMSPolicySettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
  overtime: { ...DEFAULT_SETTINGS.overtime, recognition: 'AUTOMATIC', ...(over.overtime || {}) },
});
const profile = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({ empCode: 'E1', name: 'Edge', otEligible: true, status: 'active', monthlyCtc: 30000, ...over });
const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };
const SEPT = '2026-09';
const sal = computeSalaryBreakdown({ monthlyCtc: 30000 })!;

const run = (over: Record<string, DayFacts | undefined> = {}, p = policy(), today = '2026-10-05', month = SEPT, adjustment?: any) => {
  const days: ResolvedDay[] = daysInMonth(month).map((d) => resolveDay(d, d in over ? over[d] : full, { policy: p, today }));
  const pay = computeEmployeePayroll({ profile: profile(), month, days, policy: p, adjustment });
  return { days, pay, day: (d: string) => days.find((x) => x.businessDate === d)! };
};
const base = run().pay;
const dailyWage = sal.grossSalary / 30;

describe('payroll edge cases (real resolver + real payroll formula)', () => {
  test('full day: PRESENT, no loss of pay', () => {
    const { day, pay } = run({ '2026-09-02': { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 } });
    assert.equal(day('2026-09-02').status, 'PRESENT');
    assert.equal(pay.lopDays, 0);
    assert.equal(pay.netPayable, base.netPayable);
  });

  test('half day: HALF_DAY; pay follows PAYROLL_RULES.halfDayLopFraction (BUSINESS DECISION: 0.5 payable credit / 0.5 LOP)', () => {
    const { day, pay } = run({ '2026-09-02': { firstIn: '09:00', lastOut: '12:30', workMinutes: 210 } });
    assert.equal(day('2026-09-02').status, 'HALF_DAY');
    assert.equal(pay.halfDays, 1);
    assert.equal(pay.lopDays, R.halfDayLopFraction * 1);
    assert.equal(R.halfDayLopFraction, 0.5, 'final business decision: HALF DAY = 0.5 PAYABLE DAY');
    assert.equal(pay.lopDeduction, Math.round(R.halfDayLopFraction * dailyWage));
  });

  test('absent: ABSENT, one day of loss of pay = gross / calendar days', () => {
    const { day, pay } = run({ '2026-09-02': undefined });
    assert.equal(day('2026-09-02').status, 'ABSENT');
    assert.equal(pay.absentDays, 1);
    assert.equal(pay.lopDays, 1);
    assert.equal(pay.lopDeduction, Math.round(dailyWage));
    assert.ok(pay.netPayable < base.netPayable);
  });

  test('leave: paid leave is not LOP, unpaid leave is, half-day paid leave is a half day with leaveFraction 0.5', () => {
    const leave = (paid: boolean, fraction = 1): DayFacts => ({ adjustments: [{ id: 'a', requestId: 'r', kind: 'LEAVE', paid, fraction }] });
    const paid = run({ '2026-09-02': leave(true) });
    assert.equal(paid.day('2026-09-02').status, 'LEAVE_PAID');
    assert.equal(paid.pay.leaveDays, 1);
    assert.equal(paid.pay.lopDays, 0);
    const unpaid = run({ '2026-09-02': leave(false) });
    assert.equal(unpaid.day('2026-09-02').status, 'LEAVE_UNPAID');
    assert.equal(unpaid.pay.unpaidLeaveDays, 1);
    assert.equal(unpaid.pay.lopDays, 1);
    const half = run({ '2026-09-02': leave(true, 0.5) });
    assert.equal(half.day('2026-09-02').status, 'HALF_DAY');
    assert.equal(half.day('2026-09-02').leaveFraction, 0.5);
  });

  test('late: flagged against shift start + grace, still PRESENT, counted in payroll (no late penalty rule exists)', () => {
    const { day, pay } = run({ '2026-09-02': { firstIn: '10:30', lastOut: '18:30', workMinutes: 480 } });
    const d = day('2026-09-02');
    assert.equal(d.status, 'PRESENT');
    assert.equal(d.isLate, true);
    assert.equal(d.lateMinutes, 90);
    assert.equal(run({ '2026-09-03': { firstIn: '10:00', lastOut: '18:00', workMinutes: 480 } }).day('2026-09-03').isLate, false, 'exactly on the grace boundary is not late');
    assert.equal(pay.lateArrivals, 1);
    assert.equal(pay.lopDays, 0);
  });

  test('early checkout: minutes before shift end are reported; the verdict follows the full-day threshold and checkout cutoff', () => {
    const at = (out: string, work: number) => run({ '2026-09-02': { firstIn: '09:00', lastOut: out, workMinutes: work } }).day('2026-09-02');
    assert.equal(at('15:00', 360).status, 'PRESENT');
    assert.equal(at('15:00', 360).earlyCheckoutMinutes, 150);
    assert.equal(at('14:59', 359).status, 'HALF_DAY');
    assert.equal(at('17:30', 510).earlyCheckoutMinutes, 0);
    assert.equal(at('16:00', 250).status, 'PRESENT', 'out at/after the 16:00 cutoff with >= half-day minutes counts as a full day');
  });

  test('missed punch: a single swipe is MISSED_PUNCH and paid; an approved regularization makes it PRESENT', () => {
    const single = run({ '2026-09-02': { firstIn: '09:05', punchCount: 1, workMinutes: 0 } });
    assert.equal(single.day('2026-09-02').status, 'MISSED_PUNCH');
    assert.equal(single.pay.missedPunchDays, 1);
    assert.equal(single.pay.lopDays, 0);
    const fixed = run({ '2026-09-02': { firstIn: '09:05', punchCount: 1, workMinutes: 0, adjustments: [{ id: 'a', requestId: 'r', kind: 'MISSED_PUNCH', inTime: '09:00', outTime: '18:00' }] } });
    assert.equal(fixed.day('2026-09-02').status, 'PRESENT');
    assert.equal(fixed.day('2026-09-02').workMinutes, 540);
    assert.equal(fixed.day('2026-09-02').source, 'ADJUSTMENT');
  });

  test('overtime: minutes beyond the standard day; paid at (basic+da)/26/hours x multiplier; off when OT is disabled', () => {
    const facts = { '2026-09-03': { firstIn: '09:00', lastOut: '19:00', workMinutes: 600 } as DayFacts };
    const on = run(facts);
    assert.equal(on.day('2026-09-03').overtimeMinutes, 90);
    assert.equal(on.pay.totalOtHours, 1.5);
    const expected = Math.round(1.5 * ((sal.basicSalary + (sal.da ?? 0)) / R.otWageDivisorDays / 8) * R.defaultOtMultiplier * 100) / 100;
    assert.equal(on.pay.otEarnings, expected);
    const off = run(facts, policy({ overtime: { enabled: false, hoursPerDay: 8 } }));
    assert.equal(off.day('2026-09-03').overtimeMinutes, 0);
    assert.equal(off.pay.otEarnings, 0);
    assert.equal(run(facts, policy(), '2026-10-05', SEPT, { otHours: 0 }).pay.otEarnings, 0, 'an explicit HR OT adjustment replaces the derived hours');
  });

  test('overnight shift 22:00-06:00: one 8h day, not late at 22:05, no early-checkout arithmetic across midnight', () => {
    const night = policy({ shift: { ...DEFAULT_SETTINGS.shift, startTime: '22:00', endTime: '06:00', gracePeriodMinutes: 60, minCheckoutForFullDay: '' } as any, weeklyOffDays: [] });
    const { day, pay } = run({ '2026-09-02': { firstIn: '22:05', lastOut: '06:10', workMinutes: 485 } }, night);
    const d = day('2026-09-02');
    assert.equal(d.status, 'PRESENT');
    assert.equal(d.isLate, false);
    assert.equal(d.earlyCheckoutMinutes, 0);
    assert.equal(d.overtimeMinutes, 5);
    assert.equal(pay.weeklyOffs, 0, 'the overnight policy here has no weekly off');
    const late = run({ '2026-09-02': { firstIn: '23:30', lastOut: '07:30', workMinutes: 480 } }, night).day('2026-09-02');
    assert.equal(late.isLate, true);
  });

  test('month boundary: IST midnight splits the business day; month lengths prorate the daily wage', () => {
    assert.equal(businessDateFromInstant(new Date('2026-09-30T18:29:59Z')), '2026-09-30'); // 23:59:59 IST
    assert.equal(businessDateFromInstant(new Date('2026-09-30T18:30:00Z')), '2026-10-01'); // 00:00:00 IST
    assert.equal(instantFromIst('2026-10-01', '00:00:00').toISOString(), '2026-09-30T18:30:00.000Z');
    const feb = run({ '2028-02-10': undefined }, policy(), '2028-03-05', '2028-02');
    assert.equal(feb.pay.monthDays, 29, 'leap February');
    assert.equal(feb.pay.lopDeduction, Math.round(sal.grossSalary / 29));
    const oct = run({ '2026-10-08': undefined }, policy(), '2026-11-02', '2026-10');
    assert.equal(oct.pay.monthDays, 31);
    assert.equal(oct.pay.lopDeduction, Math.round(sal.grossSalary / 31));
    // a month still in progress: future days earn nothing and cost nothing
    const mid = run({}, policy(), '2026-09-15');
    assert.equal(mid.pay.elapsedDays, 15);
    assert.equal(mid.pay.lopDays, 0);
    assert.ok(mid.pay.isProvisional);
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  });

  describe('weekly-off and paid-holiday work (separate rules)', () => {
    const SUN = '2026-09-06';
    const HOL = '2026-09-10'; // Thursday
    const hol = { id: 'h', date: HOL, name: 'Fest', type: 'NATIONAL' as const, paid: true };
    const worked: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 };
    // every Sunday and the holiday idle, so only the day under test can be recognized
    const idle: Record<string, DayFacts | undefined> = Object.fromEntries(['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', HOL].map((d) => [d, undefined]));
    const mk = (weeklyOff: 'MANUAL' | 'AUTOMATIC', paidHoliday: 'MANUAL' | 'AUTOMATIC') =>
      policy({ holidays: [hol], offDayWork: { weeklyOff: { recognition: weeklyOff }, paidHoliday: { recognition: paidHoliday } } });
    const perDay = (sal.basicSalary + (sal.da ?? 0)) / R.otWageDivisorDays;
    const r2 = (n: number) => Math.round(n * 100) / 100;

    test('weekly off WITHOUT work: off day, nothing recognized or paid, in either mode', () => {
      for (const mode of ['MANUAL', 'AUTOMATIC'] as const) {
        const r = run(idle, mk(mode, mode));
        assert.equal(r.day(SUN).status, 'WEEKLY_OFF');
        assert.equal(r.day(SUN).offDayWorkFraction, 0);
        assert.equal(r.pay.weeklyOffWorkDays, 0);
        assert.equal(r.pay.netPayable, base.netPayable - 0, 'an unworked weekly off is already inside the monthly salary');
      }
    });

    test('weekly off WITH work: MANUAL recognizes nothing; AUTOMATIC recognizes 1 day (0.5 for a half day) and prices it', () => {
      const manual = run({ ...idle, [SUN]: worked }, mk('MANUAL', 'MANUAL'));
      assert.equal(manual.day(SUN).status, 'WEEKLY_OFF');
      assert.equal(manual.pay.weeklyOffWorkDays, 0);
      const auto = run({ ...idle, [SUN]: worked }, mk('AUTOMATIC', 'MANUAL'));
      assert.equal(auto.day(SUN).status, 'WEEKLY_OFF', 'still a weekly off');
      assert.equal(auto.day(SUN).offDayWorkFraction, 1);
      assert.equal(auto.pay.weeklyOffWorkDays, 1);
      assert.equal(auto.pay.holidayWorkDays, 0);
      assert.equal(auto.pay.weeklyOffWorkEarnings, r2(perDay * R.weeklyOffWorkMultiplier * 1));
      assert.equal(auto.pay.payableDays, base.payableDays, 'payable days unchanged');
      const half = run({ ...idle, [SUN]: { firstIn: '09:00', lastOut: '12:30', workMinutes: 210 } }, mk('AUTOMATIC', 'MANUAL'));
      assert.equal(half.pay.weeklyOffWorkDays, 0.5);
      assert.equal(half.pay.weeklyOffWorkEarnings, r2(perDay * R.weeklyOffWorkMultiplier * 0.5));
    });

    test('paid holiday WITHOUT work: HOLIDAY, paid, no LOP, nothing extra', () => {
      for (const mode of ['MANUAL', 'AUTOMATIC'] as const) {
        const r = run({ [HOL]: undefined }, mk(mode, mode));
        assert.equal(r.day(HOL).status, 'HOLIDAY');
        assert.equal(r.day(HOL).isPaidHoliday, true);
        assert.equal(r.pay.holidays, 1);
        assert.equal(r.pay.lopDays, 0);
        assert.equal(r.pay.holidayWorkDays, 0);
      }
    });

    test('paid holiday WITH work: priced only when the PAID-HOLIDAY rule is AUTOMATIC, independent of the weekly-off rule', () => {
      const weeklyOnly = run({ [HOL]: worked }, mk('AUTOMATIC', 'MANUAL'));
      assert.equal(weeklyOnly.pay.holidayWorkDays, 0, 'the weekly-off rule must not leak into holidays');
      const auto = run({ [HOL]: worked }, mk('MANUAL', 'AUTOMATIC'));
      assert.equal(auto.day(HOL).status, 'HOLIDAY');
      assert.equal(auto.day(HOL).offDayWorkFraction, 1);
      assert.equal(auto.pay.holidayWorkDays, 1);
      assert.equal(auto.pay.weeklyOffWorkDays, 0);
      assert.equal(auto.pay.holidayWorkEarnings, r2(perDay * R.holidayWorkMultiplier * 1));
      assert.ok(auto.pay.payslip.earnings.some((l) => l.code === 'HOLIDAY_WORK'));
      const sum = (ls: { amount: number }[]) => ls.reduce((a, l) => a + l.amount, 0);
      assert.ok(Math.abs(sum(auto.pay.payslip.earnings) - sum(auto.pay.payslip.deductions) - auto.pay.netPayable) < 0.011);
    });

    test('an HR override replaces the effective days but never the resolver result', () => {
      const r = run({ ...idle, [SUN]: worked }, mk('AUTOMATIC', 'MANUAL'), '2026-10-05', SEPT, { weeklyOffWorkDays: 0 });
      assert.equal(r.pay.weeklyOffWorkDays, 0);
      assert.equal(r.pay.weeklyOffWorkAutoDays, 1);
      assert.equal(r.pay.offDayWorkOverridden, true);
      assert.equal(r.day(SUN).offDayWorkFraction, 1, 'attendance is untouched');
    });
  });
});
