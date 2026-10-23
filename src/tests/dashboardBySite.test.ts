process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { istToday } from '../utils/istTime.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('dashboard: the all-locations answer carries every location', { skip: SKIP }, () => {
  let h: Harness;
  let siteIds: string[];
  let otherSite: string;
  const today = istToday();

  const punch = (siteId: string, code: string, time: string, n: number) => ({
    sourceId: siteId, sourceName: siteId, siteId, employeeCode: code, employeeName: code,
    punchDateTime: new Date(`${today}T${time}:00+05:30`), entryDate: today, entryTime: `${time}:00`, machineId: '1',
    vendorRecordHash: `${siteId}-${code}-${time}-${n}`,
  });

  before(async () => {
    h = await startHarness();
    siteIds = (await h.call('GET', '/sources/sites', { token: h.tokens.founder })).body.data.map((s: any) => s.siteId);
        // The harness puts E001 and E002 at "budigere"; put two more people at two OTHER locations and punch everyone in.
    const [a, b] = siteIds.filter((s) => s !== 'budigere');
    assert.ok(a && b, 'the test needs two locations besides budigere');
    otherSite = b;
    await h.models.EmployeeModel.create({ empCode: 'E101', name: 'Other Site One', otEligible: true, status: 'active', location: a, updatedAt: new Date().toISOString() });
    await h.models.EmployeeModel.create({ empCode: 'E102', name: 'Other Site Two', otEligible: true, status: 'active', location: b, updatedAt: new Date().toISOString() });
    await h.models.AttendanceModel.insertMany([
      punch(a, 'E101', '09:05', 1), punch(a, 'E101', '18:00', 2),
      punch(b, 'E102', '10:30', 3),
      punch('budigere', 'E001', '09:00', 4), punch('budigere', 'E001', '18:10', 5),
    ]);
  });
  after(async () => { await h?.stop(); });

  const stats = async (query = '') => (await h.call('GET', `/attendance/stats${query}`, { token: h.tokens.founder })).body.data;
  const withoutBySite = ({ bySite: _ignored, ...rest }: any) => rest;
  const normalise = (v: any) => JSON.parse(JSON.stringify(v));

  test('each location inside the all-locations answer equals a request for that location alone', async () => {
    const all = await stats();
    assert.ok(all.bySite, 'the all-locations answer has bySite');
    for (const site of siteIds) {
      assert.ok(all.bySite[site], `bySite has ${site}`);
      const alone = await stats(`?siteId=${site}`);
      assert.equal(alone.bySite, undefined, 'a single-location answer has no bySite');
      assert.deepEqual(normalise(all.bySite[site]), normalise(withoutBySite(alone)), `location ${site} matches`);
    }
  });

  test('the locations add up to the all-locations totals', async () => {
    const all = await stats();
    const sum = (k: string) => Object.values<any>(all.bySite).reduce((n, s) => n + s[k], 0);
    assert.equal(sum('totalWorkforce'), all.totalWorkforce);
    assert.equal(sum('presentCount'), all.presentCount);
    assert.equal(sum('absentCount'), all.absentCount);
    assert.equal(sum('todayPunches'), all.todayPunches);
    assert.equal(all.todayPunches, 5);
    assert.equal(all.recentPunches.length, 5);
  });

  test('a location only sees its own punches', async () => {
    const b = otherSite;
    const all = await stats();
    assert.equal(all.bySite[b].todayPunches, 1);
    assert.deepEqual(all.bySite[b].recentPunches.map((p: any) => p.employeeCode), ['E102']);
    assert.equal(all.bySite[b].hourlyDistribution.reduce((n: number, s: any) => n + s.punches, 0), 1);
  });

  test('a location with no one in it answers with zeros, not an error', async () => {
    const all = await stats();
    for (const site of siteIds) assert.equal(typeof all.bySite[site].totalWorkforce, 'number');
    const unknown = await stats('?siteId=nowhere');
    assert.equal(unknown.totalWorkforce, 0);
    assert.equal(unknown.todayPunches, 0);
  });
});
