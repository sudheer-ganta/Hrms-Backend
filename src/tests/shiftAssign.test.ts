import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('shifts: settings persistence (real app, real MongoDB)', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const ok = (r: { status: number; body: any }) => assert.equal(r.status, 200, JSON.stringify(r.body));

  test('overtime hours on the default shift and on extra shifts survive a save and reload', async () => {
    ok(await h.call('PUT', '/settings', {
      token: h.tokens.founder,
      body: {
        shift: { otWindows: [{ start: '19:00', end: '23:59' }] },
        shifts: [{ shiftName: 'Late Shift', startTime: '12:00', endTime: '20:00', otWindows: [{ start: '21:30', end: '23:59' }] }],
      },
    }));
    const got = await h.call('GET', '/settings', { token: h.tokens.founder });
    ok(got);
    assert.deepEqual(got.body.data.shift.otWindows, [{ start: '19:00', end: '23:59' }]);
    assert.deepEqual(got.body.data.shifts[0].otWindows, [{ start: '21:30', end: '23:59' }]);
  });

  test('a person can be moved onto a shift (and back) from their profile', async () => {
    const t = h.tokens.founder;
    ok(await h.call('PUT', '/employees/E001', { token: t, body: { shiftName: 'Late Shift' } }));
    assert.equal((await h.call('GET', '/employees/E001', { token: t })).body.data.shiftName, 'Late Shift');
    ok(await h.call('PUT', '/employees/E001', { token: t, body: { shiftName: '' } }));
    assert.equal((await h.call('GET', '/employees/E001', { token: t })).body.data.shiftName, undefined);
  });

  test('employees cannot change shifts or settings', async () => {
    assert.equal((await h.call('PUT', '/employees/E001', { token: h.tokens.employee1, body: { shiftName: 'Late Shift' } })).status, 403);
    assert.equal((await h.call('PUT', '/settings', { token: h.tokens.employee1, body: { shifts: [] } })).status, 403);
  });
});
