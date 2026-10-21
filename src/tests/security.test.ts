import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { startHarness, mongodAvailable, Harness } from './helpers.js';

/**
 * Security regression suite: role boundaries (incl. HR), IDOR, token abuse, injection, mass assignment,
 * response hygiene, CORS and headers. Real Express app + real (in-memory) MongoDB.
 */
const SKIP = !mongodAvailable() && 'no local mongod binary (set MONGOMS_SYSTEM_BINARY)';

describe('security regressions (real app + MongoDB)', { skip: SKIP }, () => {
  let h: Harness;
  let hr = '';
  const SEPT = '2026-09';

  before(async () => {
    h = await startHarness();
    const hash = await bcrypt.hash('Test-pass-12345', 4);
    await h.models.UserModel.create({ email: 'hr@test.local', passwordHash: hash, name: 'The HR', role: 'HR', status: 'active' });
    hr = (await h.call('POST', '/auth/login', { body: { identifier: 'hr@test.local', password: 'Test-pass-12345' } })).body.data.token;
  });
  after(async () => { await h?.stop(); });

  const status = async (m: string, p: string, token?: string, body?: unknown) => (await h.call(m, p, { token, body })).status;

  describe('HR role boundary (server-side)', () => {
    test('HR can run day-to-day operations', async () => {
      for (const p of ['/employees', '/attendance/timesheet', '/payroll/all?month=2026-09', `/payroll/runs/${SEPT}/coverage`, '/payroll/runs']) {
        assert.equal(await status('GET', p, hr), 200, p);
      }
    });
    test('HR cannot reach Founder / Super Admin only operations', async () => {
      assert.equal(await status('GET', '/auth/users', hr), 403);
      assert.equal(await status('POST', '/auth/users', hr, { email: 'x@test.local', role: 'FOUNDER', password: 'Test-pass-98765' }), 403);
      assert.equal(await status('PUT', '/settings', hr, { shift: { gracePeriodMinutes: 99 } }), 403);
      assert.equal(await status('POST', '/settings/holidays', hr, { date: '2026-12-25', name: 'x' }), 403);
      assert.equal(await status('POST', '/sync/all', hr, {}), 403);
      assert.equal(await status('GET', '/sync/logs', hr), 403);
      assert.equal(await status('POST', `/payroll/runs/${SEPT}/reopen`, hr, { reason: 'because I can' }), 403);
    });
    test('HR cannot punch for another employee or override the geofence (regression)', async () => {
      const before = await h.models.AttendanceModel.countDocuments({ employeeCode: 'E002' });
      const r = await h.call('POST', '/attendance/punch', { token: hr, body: { empCode: 'E002', punchType: 'IN', override: true } });
      assert.ok(r.status >= 400 && r.status < 500, `expected a refusal, got ${r.status}`);
      assert.equal(await h.models.AttendanceModel.countDocuments({ employeeCode: 'E002' }), before, 'no punch was written for E002');
    });
  });

  describe('employee isolation (IDOR)', () => {
    test("an employee cannot read another employee's profile, payroll, attendance or requests", async () => {
      const e1 = h.tokens.employee1;
      assert.equal(await status('GET', '/employees/E002', e1), 403);
      assert.equal(await status('GET', '/payroll/employee/E002?month=2026-09', e1), 403);
      assert.equal(await status('GET', '/attendance/days?employeeCode=E002&fromDate=2026-09-01&toDate=2026-09-02', e1), 403);
      assert.equal(await status('GET', '/attendance/calendar?month=2026-09&employeeCode=E002', e1), 403);
      assert.equal(await status('GET', '/requests?empCode=E002', e1), 403);
      assert.equal(await status('GET', '/requests/balance/E002', e1), 403);
    });
    test('the roster an employee receives contains only their own record, and never salary of others', async () => {
      const r = await h.call('GET', '/employees', { token: h.tokens.employee1 });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.map((p: any) => p.empCode), ['E001']);
    });
    test('an employee cannot cancel or approve someone else\'s request', async () => {
      const created = await h.call('POST', '/requests', { token: h.tokens.employee2, body: { requestType: 'LEAVE', leaveType: 'CASUAL_LEAVE', date: '2026-11-03', reason: 'IDOR check' } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.id;
      assert.ok([403, 404].includes(await status('POST', `/requests/${id}/cancel`, h.tokens.employee1)));
      assert.equal(await status('PATCH', `/requests/${id}/status`, h.tokens.employee1, { status: 'APPROVED' }), 403);
      assert.equal(await status('PATCH', `/requests/${id}/status`, h.tokens.employee2, { status: 'APPROVED' }), 403, 'not even the requester can approve their own request');
    });
  });

  describe('token and session abuse', () => {
    const secret = 'integration-test-secret-integration-test-secret';
    test('missing, malformed, tampered, expired and unsigned (alg=none) tokens are all 401', async () => {
      assert.equal(await status('GET', '/auth/me'), 401);
      assert.equal(await status('GET', '/auth/me', 'not-a-jwt'), 401);
      const good = h.tokens.founder;
      assert.equal(await status('GET', '/auth/me', good.slice(0, -2) + 'xx'), 401);
      const id = (jwt.decode(good) as any).id;
      assert.equal(await status('GET', '/auth/me', jwt.sign({ id, tv: 0 }, secret, { expiresIn: -10 })), 401, 'expired');
      assert.equal(await status('GET', '/auth/me', jwt.sign({ id, tv: 0 }, 'a-different-secret-a-different-secret!!')), 401, 'wrong secret');
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id, tv: 0 })).toString('base64url')}.`;
      assert.equal(await status('GET', '/auth/me', none), 401, 'alg=none');
    });
    test('a role claim inside the token is ignored: the database decides', async () => {
      const id = (jwt.decode(h.tokens.employee1) as any).id;
      const forged = jwt.sign({ id, tv: 0, role: 'SUPER_ADMIN' }, secret);
      assert.equal(await status('GET', '/auth/users', forged), 403);
    });
    test('responses never contain password hashes or token versions', async () => {
      const users = await h.call('GET', '/auth/users', { token: h.tokens.superAdmin });
      const me = await h.call('GET', '/auth/me', { token: h.tokens.superAdmin });
      const blob = JSON.stringify([users.body, me.body]);
      assert.ok(!/passwordHash|tokenVersion|\$2[aby]\$/.test(blob));
    });
  });

  describe('injection and mass assignment', () => {
    test('NoSQL operators in login fields are rejected, never evaluated', async () => {
      for (const body of [{ identifier: { $ne: '' }, password: 'x' }, { identifier: 'root@test.local', password: { $ne: '' } }, { email: { $gt: '' }, password: 'x' }]) {
        const r = await h.call('POST', '/auth/login', { body });
        assert.ok([400, 401].includes(r.status), `got ${r.status}`);
        assert.ok(!r.body?.data?.token);
      }
    });
    test('operator objects in query strings do not crash or widen the result', async () => {
      for (const p of ['/attendance/days?employeeCode[$ne]=E001', '/requests?empCode[$ne]=E001', '/requests?status[$ne]=PENDING', '/employees/%7B%22$ne%22:%22%22%7D']) {
        const r = await h.call('GET', p, { token: h.tokens.employee1 });
        assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
      }
    });
    test('privileged / unknown fields cannot be smuggled into profiles or accounts', async () => {
      assert.equal(await status('PUT', '/employees/E001', h.tokens.founder, { role: 'SUPER_ADMIN' }), 400);
      assert.equal(await status('PUT', '/employees/E001', h.tokens.founder, { $set: { status: 'x' } }), 400);
      assert.equal(await status('POST', '/auth/users', h.tokens.superAdmin, { email: 'evil@test.local', role: 'SUPER_ADMIN', password: 'Test-pass-98765' }), 400, 'a Super Admin cannot be minted through the API');
    });
    test('malformed JSON and oversized bodies get clean 4xx errors', async () => {
      const bad = await fetch(h.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"identifier":' });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as any).error.code, 'VALIDATION_ERROR');
      const huge = await fetch(h.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'a'.repeat(400_000), password: 'x' }) });
      assert.equal(huge.status, 400);
    });
  });

  describe('brute force, headers and CORS', () => {
    test('repeated failed logins for one account are throttled (429) without locking other accounts', async () => {
      let last = 0;
      for (let i = 0; i < 12; i++) last = await status('POST', '/auth/login', undefined, { identifier: 'brute@test.local', password: `wrong-${i}` });
      assert.equal(last, 429);
      assert.equal(await status('POST', '/auth/login', undefined, { identifier: 'founder@test.local', password: 'Test-pass-12345' }), 200);
    });
    test('security headers are set and nothing advertises the stack', async () => {
      const res = await fetch(h.base + '/health');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-powered-by'), null);
      const body = JSON.stringify(await res.json());
      assert.ok(!/mongodb(\+srv)?:\/\//.test(body), 'health must not leak connection strings');
    });
    test('an unlisted browser origin gets no CORS grant, including on preflight', async () => {
      const pre = await fetch(h.base + '/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      assert.equal(pre.headers.get('access-control-allow-origin'), null);
      const simple = await fetch(h.base + '/health', { headers: { Origin: 'https://evil.example' } });
      assert.equal(simple.headers.get('access-control-allow-origin'), null);
    });
    test('unknown API routes return the canonical JSON 404, and errors never include stack traces', async () => {
      const r = await h.call('GET', '/definitely-not-a-route', { token: h.tokens.founder });
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'NOT_FOUND');
      assert.ok(!JSON.stringify(r.body).includes(' at '));
    });
  });
});
