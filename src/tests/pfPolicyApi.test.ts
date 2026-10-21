import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { addDays, istToday } from '../utils/istTime.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

/** The PF rules are edited in Settings only: save them over the API and payroll must follow, with no code change. */
describe('PF rules in Settings (real Express + MongoDB)', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const MONTH = addDays(`${istToday().slice(0, 7)}-01`, -1).slice(0, 7); // a fully elapsed month
  const payroll = async (code: string) =>
    (await h.call('GET', `/payroll/all?month=${MONTH}`, { token: h.tokens.founder })).body.data.find((p: any) => p.empCode === code);
  const save = (pf: unknown, token = h.tokens.founder) => h.call('PUT', '/settings', { token, body: { statutory: { pf } } });

  test('a policy that never had the setting returns the standard PF rules', async () => {
    const r = await h.call('GET', '/settings', { token: h.tokens.founder });
    assert.equal(r.status, 200);
    const pf = r.body.data.statutory.pf;
    assert.deepEqual([pf.employeeRatePct, pf.epsRatePct, pf.adminRatePct, pf.edliRatePct], [12, 8.33, 0.5, 0.5]);
    assert.deepEqual(pf.ceilings, [{ from: '1900-01-01', ceiling: 15000 }, { from: '2026-09-17', ceiling: 25000 }]);
  });

  test('saved rates and ceilings persist and payroll follows them', async () => {
    assert.equal((await h.call('PUT', '/employees/E001', { token: h.tokens.founder, body: { monthlyCtc: 40000 } })).status, 200);
    const before = await payroll('E001');
    assert.ok(before.pfWages > 0, 'the employee has PF wages this month');
    assert.equal(before.pfDeduction, Math.round(before.pfWages * 0.12));

    const saved = await save({ employeeRatePct: 10, epsRatePct: 8.33, adminRatePct: 1, edliRatePct: 0.25, ceilings: [{ from: '1900-01-01', ceiling: 3000 }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await h.call('GET', '/settings', { token: h.tokens.founder })).body.data.statutory.pf.employeeRatePct, 10);

    const after = await payroll('E001');
    assert.equal(after.pfWages, Math.min(3000, before.pfWages)); // the new ceiling caps the wages
    assert.equal(after.pfDeduction, Math.round(after.pfWages * 0.10));
    assert.equal(after.employerPfAdmin, Math.round(after.pfWages * 0.01));
    assert.equal(after.employerEdli, Math.round(after.pfWages * 0.0025));
    assert.equal(after.employerEps + after.employerEpf, after.employerPf);
  });

  test('bad values are rejected and change nothing', async () => {
    const bad = await save({ epsRatePct: 99, employeeRatePct: 12 });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const noCeiling = await save({ ceilings: [{ from: '2026-01-01', ceiling: 0 }] });
    assert.equal(noCeiling.status, 400);
    assert.equal((await h.call('GET', '/settings', { token: h.tokens.founder })).body.data.statutory.pf.employeeRatePct, 10);
  });

  test('only a founder or super admin can change them', async () => {
    assert.equal((await save({ employeeRatePct: 5 }, h.tokens.employee1)).status, 403);
    assert.equal((await h.call('GET', '/settings', { token: h.tokens.employee1 })).status, 200); // everyone can read
    assert.equal((await save({ employeeRatePct: 12, epsRatePct: 8.33, adminRatePct: 0.5, edliRatePct: 0.5, ceilings: [{ from: '1900-01-01', ceiling: 15000 }, { from: '2026-09-17', ceiling: 25000 }] }, h.tokens.superAdmin)).status, 200);
  });
});
