process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { pickSalary } from '../modules/employees/salaryRevisions.js';
import { DEFAULT_SETTINGS, validatePolicyUpdate, pfSalaryTerms } from '../modules/settings/policy.service.js';
import { resolveDay, DayFacts } from '../modules/attendance/attendanceResolver.js';
import { daysInMonth } from '../utils/istTime.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';

const OCT = '2026-10';
const full: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2 };
const days = () => daysInMonth(OCT).map((d) => resolveDay(d, full, { policy: DEFAULT_SETTINGS, today: '2026-11-30' }));

// Gross 8,551 with no HRA: the PF wages are the whole gross (Kenneti Devi's row on the PF page).
const profile = (): EmployeeProfile => ({
  empCode: '0045', name: 'Kenneti Devi', otEligible: false, status: 'active',
  ...pickSalary(computeSalaryBreakdown({
    monthlyCtc: 8551 + 1026, basicSalary: 8551, da: 0, hra: 0, specialAllowance: 0, otherAllowance: 0,
    employerPf: 1026, employerEsic: 0, professionalTax: 0, minimumBonus: 0,
  })!),
});

const withPf = (pf: Partial<HRMSPolicySettings['statutory']['pf']>): HRMSPolicySettings => ({
  ...DEFAULT_SETTINGS,
  statutory: { pf: { ...DEFAULT_SETTINGS.statutory.pf, ...pf } },
});

describe('PF rules come from the policy', () => {
  test('default policy gives the figures on the PF page (12%, 8.33% pension, 0.5% admin and EDLI)', () => {
    const r = computeEmployeePayroll({ profile: profile(), month: OCT, days: days(), policy: DEFAULT_SETTINGS });
    assert.equal(r.pfWages, 8551);
    assert.equal(r.pfDeduction, 1026);
    assert.equal(r.employerEps, 712);
    assert.equal(r.employerEpf, 314);
    assert.equal(r.employerPfAdmin, 43);
    assert.equal(r.employerEdli, 43);
  });

  test('changing the rates in the policy changes the result', () => {
    const r = computeEmployeePayroll({
      profile: profile(), month: OCT, days: days(),
      policy: withPf({ employeeRatePct: 10, epsRatePct: 8.33, adminRatePct: 1, edliRatePct: 0.25 }),
    });
    assert.equal(r.pfDeduction, 855); // 10% of 8,551
    assert.equal(r.employerPf, 855);
    assert.equal(r.employerEps, 712);
    assert.equal(r.employerEpf, 143);
    assert.equal(r.employerPfAdmin, 86); // 1% of 8,551
    assert.equal(r.employerEdli, 21); // 0.25% of 8,551
  });

  test('a lower ceiling in the policy caps the PF wages', () => {
    const r = computeEmployeePayroll({
      profile: profile(), month: OCT, days: days(),
      policy: withPf({ ceilings: [{ from: '1900-01-01', ceiling: 6000 }] }),
    });
    assert.equal(r.pfWages, 6000);
    assert.equal(r.pfDeduction, 720);
  });

  test('a policy saved before this setting existed falls back to the defaults', () => {
    const { statutory: _drop, ...old } = DEFAULT_SETTINGS;
    const r = computeEmployeePayroll({ profile: profile(), month: OCT, days: days(), policy: old as HRMSPolicySettings });
    assert.equal(r.pfDeduction, 1026);
  });
});

describe('PF settings validation', () => {
  test('accepts rates and a ceiling history; sorts it and pins the first row to the beginning', () => {
    const out = validatePolicyUpdate({
      statutory: { pf: { employeeRatePct: 12, epsRatePct: 8.33, adminRatePct: 0.5, edliRatePct: 0.5, ceilings: [
        { from: '2027-04-01', ceiling: 30000 }, { from: '2026-01-01', ceiling: 15000 },
      ] } },
    }) as any;
    assert.deepEqual(out.statutory.pf.ceilings, [{ from: '1900-01-01', ceiling: 15000 }, { from: '2027-04-01', ceiling: 30000 }]);
  });

  test('rejects a pension share above the PF rate, a zero ceiling, a bad date and two ceilings on one day', () => {
    assert.throws(() => validatePolicyUpdate({ statutory: { pf: { employeeRatePct: 10, epsRatePct: 11 } } }));
    assert.throws(() => validatePolicyUpdate({ statutory: { pf: { ceilings: [{ from: '2026-01-01', ceiling: 0 }] } } }));
    assert.throws(() => validatePolicyUpdate({ statutory: { pf: { ceilings: [{ from: 'soon', ceiling: 15000 }] } } }));
    assert.throws(() => validatePolicyUpdate({ statutory: { pf: { ceilings: [{ from: '2026-01-01', ceiling: 15000 }, { from: '2026-01-01', ceiling: 25000 }] } } }));
    assert.throws(() => validatePolicyUpdate({ statutory: { pf: { ceilings: [] } } }));
  });
});

describe('employer PF carved out of CTC follows the Settings rate and ceiling', () => {
  const ctc = { monthlyCtc: 60000, basicSalary: 30000 };

  test('before 17 Sep 2026 the cap is 12% of 15,000 = 1,800; from then it is 12% of 25,000 = 3,000', () => {
    assert.equal(computeSalaryBreakdown(ctc, pfSalaryTerms(DEFAULT_SETTINGS, '2026-08-31'))!.employerPf, 1800);
    assert.equal(computeSalaryBreakdown(ctc, pfSalaryTerms(DEFAULT_SETTINGS, '2026-10-31'))!.employerPf, 3000);
  });

  test('a lower basic is not capped, and a new rate or ceiling in the policy is used', () => {
    assert.equal(computeSalaryBreakdown({ monthlyCtc: 30000, basicSalary: 10000 }, pfSalaryTerms(DEFAULT_SETTINGS, '2026-10-31'))!.employerPf, 1200);
    const p = withPf({ employeeRatePct: 10, ceilings: [{ from: '1900-01-01', ceiling: 20000 }] });
    assert.equal(computeSalaryBreakdown(ctc, pfSalaryTerms(p, '2026-10-31'))!.employerPf, 2000);
  });

  test('gross is CTC minus that employer PF, and an explicit employer PF still wins', () => {
    const sal = computeSalaryBreakdown({ ...ctc, professionalTax: 0 }, pfSalaryTerms(DEFAULT_SETTINGS, '2026-10-31'))!;
    assert.equal(sal.grossSalary, 60000 - 3000);
    assert.equal(computeSalaryBreakdown({ ...ctc, employerPf: 1800 }, pfSalaryTerms(DEFAULT_SETTINGS, '2026-10-31'))!.employerPf, 1800);
  });

  test('callers that pass no terms keep the legacy 1,800 cap', () => {
    assert.equal(computeSalaryBreakdown(ctc)!.employerPf, 1800);
  });
});
