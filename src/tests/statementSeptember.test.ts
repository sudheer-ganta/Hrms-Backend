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
 * The company's corrected SEPTEMBER 2026 salary statement (CM_Sal_Payrollstatement SEPT_Sample - corrected.xlsx),
 * all ten rows, pinned column by column. September is the month the PF wage ceiling changed (15,000 until 16 Sep,
 * 25,000 from 17 Sep), so this also pins the split-month PF rule. Each row feeds the engine only what HR types
 * (salary components, loss-of-pay days, Sunday days, OT hours, advance, bonus...) and compares what the engine works out.
 */
const MONTH = '2026-09';
const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];
const policy: HRMSPolicySettings = {
  ...DEFAULT_SETTINGS,
  shift: { ...DEFAULT_SETTINGS.shift, otWindows: [{ start: '17:30', end: '18:30' }, { start: '19:00', end: '23:59' }] },
};
const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };

interface Row {
  code: string; name: string;
  gross: number; basic: number; da: number; hra: number; special: number; other: number;
  lop: number; sundayDays: number; otHours: number; advance: number; otherDeduction: number; lwf: number; bonus: number; increment: number;
  esiWages: number; pfWages: number; pf: number; esi: number; pt: number; totalDeduction: number; net: number; erPf: number; admin: number; edli: number;
}

const STATEMENT: Row[] = [
  { code: "24", name: "Zakir Ahmed", gross: 23051, basic: 11550, da: 2826, hra: 0, special: 1994, other: 6681, lop: 0, sundayDays: 3, otHours: 39, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 0, pfWages: 18758, pf: 2251, esi: 0, pt: 200, totalDeduction: 2451, net: 29309, erPf: 2251, admin: 94, edli: 94 },
  { code: "45", name: "Kenneti Devi", gross: 16200, basic: 10427.91, da: 2826, hra: 2946.09, special: 0, other: 0, lop: 0, sundayDays: 0.5, otHours: 10, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13253.91, pfWages: 13254.8, pf: 1591, esi: 100, pt: 0, totalDeduction: 1691, net: 16293, erPf: 1591, admin: 66, edli: 66 },
  { code: "74", name: "Afroj Ansari", gross: 18759, basic: 10963, da: 2826, hra: 4970, special: 0, other: 0, lop: 0, sundayDays: 3, otHours: 24, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13789, pfWages: 13789.133333, pf: 1655, esi: 104, pt: 200, totalDeduction: 1959, net: 23164, erPf: 1655, admin: 69, edli: 69 },
  { code: "198", name: "Aash Mohammed", gross: 17789, basic: 10963, da: 2826, hra: 4000, special: 0, other: 0, lop: 0, sundayDays: 4, otHours: 52, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13789, pfWages: 13789.133333, pf: 1655, esi: 104, pt: 200, totalDeduction: 1959, net: 26967, erPf: 1655, admin: 69, edli: 69 },
  { code: "271", name: "Leelavathi K", gross: 16301, basic: 11296.38, da: 2826, hra: 2178.62, special: 0, other: 0, lop: 0, sundayDays: 3, otHours: 14, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 14122.38, pfWages: 14122.733333, pf: 1695, esi: 106, pt: 0, totalDeduction: 1801, net: 19660, erPf: 1695, admin: 71, edli: 71 },
  { code: "344", name: "S Mary", gross: 16259, basic: 10963, da: 2826, hra: 2470, special: 0, other: 0, lop: 0, sundayDays: 0, otHours: 20, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13789, pfWages: 13789.133333, pf: 1655, esi: 104, pt: 0, totalDeduction: 1759, net: 17152, erPf: 1655, admin: 69, edli: 69 },
  { code: "515", name: "MD Rezabul Mirzan", gross: 16781, basic: 10963, da: 2826, hra: 2992, special: 0, other: 0, lop: 0, sundayDays: 0, otHours: 34, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13789, pfWages: 13789.133333, pf: 1655, esi: 104, pt: 0, totalDeduction: 1759, net: 19530, erPf: 1655, admin: 69, edli: 69 },
  { code: "687", name: "Ranajit Sahoo", gross: 15890, basic: 10428, da: 2826, hra: 2636, special: 0, other: 0, lop: 20, sundayDays: 0, otHours: 5, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 1300, esiWages: 4418, pfWages: 4418.266667, pf: 530, esi: 34, pt: 0, totalDeduction: 564, net: 6670, erPf: 530, admin: 22, edli: 22 },
  { code: "904", name: "Sunita Bayen", gross: 13254, basic: 10428, da: 2826, hra: 0, special: 0, other: 0, lop: 0, sundayDays: 3.5, otHours: 16, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13254, pfWages: 13254.8, pf: 1591, esi: 100, pt: 0, totalDeduction: 1691, net: 17170, erPf: 1591, admin: 66, edli: 66 },
  { code: "1023", name: "Parboti Soren", gross: 14390, basic: 10428, da: 2826, hra: 1136, special: 0, other: 0, lop: 0, sundayDays: 3, otHours: 16, advance: 0, otherDeduction: 0, lwf: 0, bonus: 0, increment: 0, esiWages: 13254, pfWages: 13254.8, pf: 1591, esi: 100, pt: 0, totalDeduction: 1691, net: 17797, erPf: 1591, admin: 66, edli: 66 },
];

const priced = (r: Row) => {
  const profile: EmployeeProfile = {
    empCode: r.code, name: r.name, otEligible: true, status: 'active',
    ...pickSalary(computeSalaryBreakdown({
      monthlyCtc: r.gross + 1800, basicSalary: r.basic, da: r.da, hra: r.hra, specialAllowance: r.special, otherAllowance: r.other,
      employerPf: 1800, employerEsic: 0, professionalTax: 0, minimumBonus: 0,
    })!),
  };
  // Loss-of-pay days are working days with no punch; Sundays are idle (their pay is the typed Sunday days).
  const absent = new Set(daysInMonth(MONTH).filter((d) => !SUNDAYS.includes(d)).slice(0, r.lop));
  const days = daysInMonth(MONTH).map((d) => resolveDay(d, absent.has(d) ? undefined : full, { policy, today: '2026-10-05' }));
  return computeEmployeePayroll({
    profile, month: MONTH, days, policy,
    adjustment: {
      otHours: r.otHours, weeklyOffWorkDays: r.sundayDays, salaryAdvance: r.advance, otherDeduction: r.otherDeduction,
      lwf: r.lwf, attendanceBonus: r.bonus, increment: r.increment,
    },
  });
};

describe('payroll matches the company statement (September 2026, all ten rows)', () => {
  for (const r of STATEMENT) {
    test(`${r.name}: PF wages, PF, ESI, PT, deductions, net pay and employer PF / admin / EDLI`, () => {
      const p = priced(r);
      assert.equal(p.lopDays, r.lop, 'loss-of-pay days');
      assert.equal(p.esiWages, r.esiWages, 'ESI wages');
      assert.ok(Math.abs((p.pfWages ?? 0) - r.pfWages) < 0.01, `PF wages ${p.pfWages} vs ${r.pfWages}`);
      assert.equal(p.pfDeduction, r.pf, 'employee PF');
      assert.equal(p.esiDeduction, r.esi, 'employee ESI');
      assert.equal(p.ptDeduction, r.pt, 'professional tax');
      const statementDeductions = p.pfDeduction + p.esiDeduction + (p.ptDeductedFromNet ? p.ptDeduction : 0) + (p.salaryAdvance ?? 0) + (p.otherDeduction ?? 0) + (p.lwfDeduction ?? 0);
      assert.equal(statementDeductions, r.totalDeduction, 'total deduction');
      assert.equal(p.netPayable, r.net, 'net payable');
      assert.equal(p.employerPf, r.erPf, 'employer PF');
      assert.equal(p.employerPfAdmin, r.admin, 'employer admin charge');
      assert.equal(p.employerEdli, r.edli, 'employer EDLI');
      const sum = (ls: { amount: number }[]) => ls.reduce((a, l) => a + l.amount, 0);
      assert.ok(Math.abs(sum(p.payslip.earnings) - sum(p.payslip.deductions) - p.netPayable) < 0.011, 'the payslip foots to the net pay');
    });
  }
});
