import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FROM_THE_BEGINNING, latestValues, pickSalary, revisionFor, salaryAsOf, withRevision } from '../modules/employees/salaryRevisions.js';
import { computeSalaryBreakdown } from '../modules/employees/salary.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { resolveDay } from '../modules/attendance/attendanceResolver.js';
import { daysInMonth } from '../utils/istTime.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';

const NOW = '2026-10-15T00:00:00.000Z';
const vals = (ctc: number) => pickSalary(computeSalaryBreakdown({ monthlyCtc: ctc })!);
const base = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({ empCode: 'E1', name: 'T', otEligible: true, status: 'active', ...over });

describe('month-correct salary (revisions)', () => {
  test('a never-revised profile uses its stored salary for every month (legacy behaviour)', () => {
    const p = base({ monthlyCtc: 30000 });
    assert.equal(salaryAsOf(p, '2025-01').monthlyCtc, 30000);
    assert.equal(salaryAsOf(p, '2026-12').monthlyCtc, 30000);
  });

  test('a raise from October keeps September at the old salary; the old salary is kept as the baseline', () => {
    const p0 = base({ ...vals(30000) });
    const { revisions, effectiveFrom } = withRevision(p0, vals(40000), '2026-10', 'HR', NOW);
    assert.equal(effectiveFrom, '2026-10');
    assert.deepEqual(revisions.map((r) => r.effectiveFrom), [FROM_THE_BEGINNING, '2026-10']);
    const p1 = base({ ...latestValues(revisions), salaryRevisions: revisions });
    assert.equal(p1.monthlyCtc, 40000, 'the top-level fields mirror the latest revision');
    assert.equal(salaryAsOf(p1, '2026-09').monthlyCtc, 30000);
    assert.equal(salaryAsOf(p1, '2026-10').monthlyCtc, 40000);
    assert.equal(salaryAsOf(p1, '2027-03').monthlyCtc, 40000);
  });

  test('a first-ever salary applies from the beginning, so months that are still open can be priced', () => {
    const { revisions, effectiveFrom } = withRevision(base(), vals(25000), '2026-10', 'HR', NOW);
    assert.equal(effectiveFrom, FROM_THE_BEGINNING);
    assert.equal(salaryAsOf(base({ salaryRevisions: revisions }), '2026-09').monthlyCtc, 25000);
  });

  test('saving again for the same month corrects that revision instead of stacking another', () => {
    const p0 = base({ ...vals(30000) });
    const r1 = withRevision(p0, vals(40000), '2026-10', 'HR', NOW).revisions;
    const r2 = withRevision(base({ ...vals(40000), salaryRevisions: r1 }), vals(42000), '2026-10', 'HR', NOW).revisions;
    assert.equal(r2.length, 2);
    assert.equal(revisionFor(r2, '2026-10')!.values.monthlyCtc, 42000);
  });

  test('an earlier-dated revision saved after a later one does not become "current"', () => {
    const p0 = base({ ...vals(30000) });
    const r1 = withRevision(p0, vals(40000), '2026-10', 'HR', NOW).revisions;
    const r2 = withRevision(base({ ...vals(40000), salaryRevisions: r1 }), vals(35000), '2026-08', 'HR', NOW).revisions;
    assert.equal(latestValues(r2).monthlyCtc, 40000);
    assert.equal(salaryAsOf(base({ salaryRevisions: r2 }), '2026-09').monthlyCtc, 35000);
    assert.equal(salaryAsOf(base({ salaryRevisions: r2 }), '2026-07').monthlyCtc, 30000);
  });

  test('payroll prices each month with that month\'s salary', () => {
    const p0 = base({ ...vals(30000) });
    const revisions = withRevision(p0, vals(60000), '2026-10', 'HR', NOW).revisions;
    const profile = base({ ...latestValues(revisions), salaryRevisions: revisions });
    const run = (month: string) => {
      const days = daysInMonth(month).map((d) => resolveDay(d, { firstIn: '09:00', lastOut: '18:00', workMinutes: 540, punchCount: 2 }, { policy: DEFAULT_SETTINGS, today: '2026-11-30' }));
      return computeEmployeePayroll({ profile, month, days, policy: DEFAULT_SETTINGS });
    };
    const sept = run('2026-09');
    const oct = run('2026-10');
    assert.equal(sept.monthlyCtc, 30000);
    assert.equal(oct.monthlyCtc, 60000);
    assert.ok(oct.netPayable > sept.netPayable);
  });
});
