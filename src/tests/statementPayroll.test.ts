process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { pickSalary } from '../modules/employees/salaryRevisions.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { resolveDay, DayFacts } from '../modules/attendance/attendanceResolver.js';
import { daysInMonth } from '../utils/istTime.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';

/**
 * The company's own August 2026 salary statement (CM_Sal_Payrollstatement Aug) is the reference:
 * the figures below are copied from it, row for row. The profile is entered the way HR enters it:
 * fixed gross = CTC - employer PF - employer ESIC, with the components typed in.
 */
const AUG = '2026-08';
const policy: HRMSPolicySettings = {
  ...DEFAULT_SETTINGS,
  shift: { ...DEFAULT_SETTINGS.shift, otWindows: [{ start: '17:30', end: '18:30' }, { start: '19:00', end: '23:59' }] },
};
const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };

const profile = (empCode: string, c: { gross: number; basic: number; da: number; hra: number; special: number; other: number }): EmployeeProfile => ({
  empCode, name: empCode, otEligible: true, status: 'active',
  ...pickSalary(computeSalaryBreakdown({
    monthlyCtc: c.gross + 1800, // employer PF is typed explicitly below; CTC only needs to be > 0 and consistent
    basicSalary: c.basic, da: c.da, hra: c.hra, specialAllowance: c.special, otherAllowance: c.other,
    employerPf: 1800, employerEsic: 0, professionalTax: 0, minimumBonus: 0,
  })!),
});

/** August 2026: every day worked except the listed ones. 2026-08-02/09/16/23/30 are Sundays (weekly off). */
const monthDays = (absent: string[] = [], half: string[] = []) =>
  daysInMonth(AUG).map((d) => {
    const facts: DayFacts | undefined = absent.includes(d) ? undefined : half.includes(d) ? ({ firstIn: '09:00', lastOut: '12:30', workMinutes: 210 } as DayFacts) : full;
    return resolveDay(d, facts, { policy, today: '2026-09-30' });
  });

describe('payroll matches the company statement (Aug 2026)', () => {
  test('Zakir Ahmed: gross 25,124 reaches the PT line, no ESI above 21,000, PF capped at 1,800 -> net 23,124', () => {
    const p = profile('024', { gross: 23051, basic: 11550, da: 2826, hra: 0, special: 1994, other: 6681 });
    const r = computeEmployeePayroll({ profile: p, month: AUG, days: monthDays(), policy, adjustment: { otHours: 15 } });
    assert.equal(r.grossSalary, 23051);
    assert.equal(r.otEarnings, 2073.46); // 15h x (11550 + 2826)/26/8 x 2
    assert.equal(r.pfDeduction, 1800);
    assert.equal(r.esiDeduction, 0);
    assert.equal(r.ptDeduction, 200);
    assert.equal(r.netPayable, 23124);
  });

  test('Kenneti Devi: ESI wages leave out HRA and round UP (100), PF 1,590, 2 Sundays + 1h OT -> net 16,677', () => {
    const p = profile('045', { gross: 16200, basic: 10427.91, da: 2826, hra: 2946.09, special: 0, other: 0 });
    const r = computeEmployeePayroll({ profile: p, month: AUG, days: monthDays(), policy, adjustment: { otHours: 1, weeklyOffWorkDays: 2 } });
    assert.equal(r.weeklyOffWorkEarnings, 2039.06);
    assert.equal(r.otEarnings, 127.44);
    assert.equal(r.esiWages, 13253.91);
    assert.equal(r.esiDeduction, 100);
    assert.equal(r.pfDeduction, 1590);
    assert.equal(r.ptDeduction, 0);
    assert.equal(r.netPayable, 16677);
  });

  test('Afroj Ansari: 2.5 LOP days prorate PF and ESI; a 5,000 advance is recovered -> net 12,949', () => {
    const p = profile('074', { gross: 18759, basic: 10963, da: 2826, hra: 4970, special: 0, other: 0 });
    // two absences and one half day = 2.5 LOP days
    const days = monthDays(['2026-08-04', '2026-08-05'], ['2026-08-06']);
    const r = computeEmployeePayroll({ profile: p, month: AUG, days, policy, adjustment: { otHours: 17.5, salaryAdvance: 5000 } });
    assert.equal(r.lopDays, 2.5);
    assert.equal(r.payableDays, 28.5);
    assert.equal(r.pfDeduction, 1521);
    assert.equal(r.esiDeduction, 96);
    assert.equal(r.salaryAdvance, 5000);
    assert.equal(r.netPayable, 12949);
    assert.ok(r.payslip.deductions.some((l) => l.code === 'ADVANCE' && l.amount === 5000));
    const sum = (ls: { amount: number }[]) => ls.reduce((a, l) => a + l.amount, 0);
    assert.ok(Math.abs(sum(r.payslip.earnings) - sum(r.payslip.deductions) - r.netPayable) < 0.011, 'the payslip foots');
  });

  test('bonus and increments are added after the statutory lines and are not PF / ESI / PT wages', () => {
    const p = profile('074', { gross: 18759, basic: 10963, da: 2826, hra: 4970, special: 0, other: 0 });
    const base = computeEmployeePayroll({ profile: p, month: AUG, days: monthDays(), policy });
    const r = computeEmployeePayroll({ profile: p, month: AUG, days: monthDays(), policy, adjustment: { attendanceBonus: 500, increment: 250, otherDeduction: 100, lwf: 20 } });
    assert.equal(r.pfDeduction, base.pfDeduction);
    assert.equal(r.esiDeduction, base.esiDeduction);
    assert.equal(r.ptDeduction, base.ptDeduction);
    assert.equal(r.netPayable, base.netPayable + 500 + 250 - 100 - 20);
    assert.equal(r.totalDeductions, base.totalDeductions + 100 + 20);
    assert.ok(r.payslip.earnings.some((l) => l.code === 'ATTN_BONUS') && r.payslip.earnings.some((l) => l.code === 'INCREMENT'));
    assert.ok(r.payslip.deductions.some((l) => l.code === 'OTHER_DEDUCTION') && r.payslip.deductions.some((l) => l.code === 'LWF'));
  });

  test('employer side: admin charge and EDLI are each 0.5% of the PF wages (75 at the cap)', () => {
    const p = profile('024', { gross: 23051, basic: 11550, da: 2826, hra: 0, special: 1994, other: 6681 });
    const r = computeEmployeePayroll({ profile: p, month: AUG, days: monthDays(), policy });
    assert.equal(r.employerPf, 1800);
    assert.equal(r.employerPfAdmin, 75);
    assert.equal(r.employerEdli, 75);
  });
});
