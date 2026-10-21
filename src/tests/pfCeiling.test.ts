process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { pfCeilingOn, pfWagesForMonth } from '../modules/payroll/pfRule.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { pickSalary } from '../modules/employees/salaryRevisions.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { resolveDay, DayFacts } from '../modules/attendance/attendanceResolver.js';
import { daysInMonth } from '../utils/istTime.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';

/**
 * EPF wage ceiling: 15,000 until 16 Sep 2026, 25,000 from 17 Sep 2026 (S.O. 5109(E)).
 * September is split 16/30 + 14/30; the figures are the company's September 2026 statement.
 */
const policy: HRMSPolicySettings = { ...DEFAULT_SETTINGS };
const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };

const profile = (empCode: string, c: { gross: number; basic: number; da: number; hra: number; special: number; other: number }): EmployeeProfile => ({
  empCode, name: empCode, otEligible: true, status: 'active',
  ...pickSalary(computeSalaryBreakdown({
    monthlyCtc: c.gross + 1800,
    basicSalary: c.basic, da: c.da, hra: c.hra, specialAllowance: c.special, otherAllowance: c.other,
    employerPf: 1800, employerEsic: 0, professionalTax: 0, minimumBonus: 0,
  })!),
});

const fullMonth = (month: string) => daysInMonth(month).map((d) => resolveDay(d, full, { policy, today: '2026-11-30' }));
const run = (p: EmployeeProfile, month: string) => computeEmployeePayroll({ profile: p, month, days: fullMonth(month), policy });

describe('PF wage ceiling by date', () => {
  test('the ceiling in force on a date', () => {
    assert.equal(pfCeilingOn('2026-08-31'), 15000);
    assert.equal(pfCeilingOn('2026-09-16'), 15000);
    assert.equal(pfCeilingOn('2026-09-17'), 25000);
    assert.equal(pfCeilingOn('2026-10-01'), 25000);
  });

  test('a month with one ceiling is just min(ceiling, earned wages)', () => {
    assert.equal(pfWagesForMonth('2026-08', 31, 23051).wages, 15000);
    assert.equal(pfWagesForMonth('2026-10', 31, 23051).wages, 23051);
    assert.equal(pfWagesForMonth('2026-10', 31, 40000).wages, 25000);
    assert.equal(pfWagesForMonth('2026-08', 31, 13254).segments.length, 1);
  });

  test('September is split 16 days at 15,000 and 14 days at 25,000 (the EPFO worked example)', () => {
    const r = pfWagesForMonth('2026-09', 30, 20000);
    assert.deepEqual(r.segments.map((s) => [s.fromDay, s.toDay, s.days, s.ceiling]), [[1, 16, 16, 15000], [17, 30, 14, 25000]]);
    assert.equal(r.segments[0].wages, 8000);
    assert.equal(r.segments[1].wages, 9334, 'the part after the change is rounded UP to the rupee, as in the statement (9,333.33 -> 9,334)');
    assert.equal(r.wages, 17334);
    assert.equal(Math.round(r.wages * 0.12), 2080);
  });

  test('only later parts are rounded up: the first part and a single-ceiling month stay exact', () => {
    assert.equal(pfWagesForMonth('2026-09', 30, 13254).segments[0].wages, 7068.8);
    assert.equal(pfWagesForMonth('2026-09', 30, 13254).segments[1].wages, 6186); // 6,185.20 -> 6,186
    assert.equal(pfWagesForMonth('2026-09', 30, 13254).wages, 13254.8);
    assert.equal(pfWagesForMonth('2026-08', 31, 13254).wages, 13254);
    assert.equal(pfWagesForMonth('2026-09', 30, 15000).segments[1].wages, 7000, 'a whole-rupee part is not pushed up');
  });
});

describe('September 2026 payroll (company statement)', () => {
  const SEP = '2026-09';

  test('Zakir Ahmed: PF on the blended wages = 2,251 and the employer pays the same', () => {
    const r = run(profile('024', { gross: 23051, basic: 11550, da: 2826, hra: 0, special: 1994, other: 6681 }), SEP);
    assert.equal(r.pfWages, 18758); // 15,000 x 16/30 + ROUNDUP(23,051 x 14/30 = 10,757.13) = 8,000 + 10,758
    assert.equal(r.pfDeduction, 2251);
    assert.equal(r.employerPf, 2251);
    assert.equal(r.employerEps! + r.employerEpf!, 2251);
    assert.equal(r.employerEps, 1563); // 8.33% of the PF wages (18,758 x 0.0833 = 1,562.5)
    assert.equal(r.employerEpf, 688);
    assert.equal(r.employerPfAdmin, 94);
    assert.equal(r.employerEdli, 94);
    assert.equal(r.pfSegments!.length, 2);
    const pfLine = r.payslip.deductions.find((l) => l.code === 'PF')!;
    assert.equal(pfLine.amount, 2251);
    assert.match(pfLine.note!, /12% of ₹18,758 PF wages/);
  });

  test('Kenneti Devi (wages under 15,000): PF is 1,591 as on the corrected statement, because the part after 17 Sep is rounded up', () => {
    const r = run(profile('045', { gross: 16200, basic: 10427.91, da: 2826, hra: 2946.09, special: 0, other: 0 }), SEP);
    assert.equal(r.pfWages, 13254.8); // 13,254 x 16/30 = 7,068.80, plus ROUNDUP(13,254 x 14/30 = 6,185.20) = 6,186
    assert.equal(r.pfDeduction, 1591);
    assert.equal(r.employerPf, 1591);
    assert.equal(r.employerPfAdmin, 66);
    assert.equal(r.employerEdli, 66);
  });

  test('Afroj Ansari: 13,789 wages give 1,655 for both employee and employer', () => {
    const r = run(profile('074', { gross: 18759, basic: 10963, da: 2826, hra: 4970, special: 0, other: 0 }), SEP);
    assert.equal(r.pfDeduction, 1655);
    assert.equal(r.employerPf, 1655);
  });

  test('October onwards uses the 25,000 ceiling: the cap is 3,000', () => {
    const r = run(profile('024', { gross: 31000, basic: 20000, da: 2826, hra: 0, special: 8174, other: 0 }), '2026-10');
    assert.equal(r.pfWages, 25000);
    assert.equal(r.pfDeduction, 3000);
    assert.equal(r.employerPf, 3000);
    assert.equal(r.pfSegments!.length, 1);
  });

  test('August is unchanged: the cap is still 1,800', () => {
    const r = run(profile('024', { gross: 23051, basic: 11550, da: 2826, hra: 0, special: 1994, other: 6681 }), '2026-08');
    assert.equal(r.pfDeduction, 1800);
    assert.equal(r.employerPfAdmin, 75);
  });
});
