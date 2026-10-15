import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { mongodAvailable } from './helpers.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

/**
 * REAL multi-instance integration test (two separate server processes, one shared MongoDB).
 * This is different from the in-process test in operations.test.ts, which only proves that
 * refreshFromDb() re-reads the database inside ONE process.
 *
 * Proven here: a Settings change saved through instance A is applied by instance B (a different OS
 * process with its own policy cache) within the refresh interval, with no restart and no call to B.
 * Test setting: POLICY_REFRESH_MS=1000; production default is 30 s, so in production the bound is ~30 s.
 */
describe('multi-instance policy convergence (two real server processes)', { skip: SKIP }, () => {
  const procs: ChildProcess[] = [];
  const logs: string[] = [];
  let mongod: any;
  let A = '';
  let B = '';
  const PASSWORD = 'Multi-instance-pass-1';
  const EMAIL = 'root@multi.local';

  const freePort = () => new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });

  const startInstance = async (name: string, port: number, uri: string) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), MONGODB_URI: uri,
      JWT_SECRET: 'multi-instance-secret-multi-instance-secret',
      SCHEDULER_ENABLED: 'false', POLICY_REFRESH_MS: '1000',
      SEED_SUPERADMIN_EMAIL: EMAIL, SEED_SUPERADMIN_PASSWORD: PASSWORD,
    };
    for (const s of ['OFFICE', 'BUDIGERE', 'BIDARAHALLI']) {
      env[`ETIMESOURCE_${s}_CORPORATE_ID`] = 'test'; env[`ETIMESOURCE_${s}_USERNAME`] = 'test'; env[`ETIMESOURCE_${s}_PASSWORD`] = 'test';
    }
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(process.cwd(), 'src/server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(`[${name}] ${d}`));
    child.stderr.on('data', (d) => logs.push(`[${name}!] ${d}`));
    procs.push(child);
    const base = `http://127.0.0.1:${port}/api`;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/health`)).status === 200) return base; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`instance ${name} did not become healthy:\n${logs.slice(-15).join('')}`);
  };

  const call = async (base: string, method: string, p: string, token?: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  before(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri('multi');
    // A boots first (creates the super admin and the default policy), then B joins the same database.
    A = await startInstance('A', await freePort(), uri);
    B = await startInstance('B', await freePort(), uri);
  });
  after(async () => {
    for (const p of procs) p.kill();
    await mongod?.stop();
  });

  test('a Settings change saved through instance A is applied by instance B, and by A, within the refresh interval', async () => {
    const login = async (base: string) => (await call(base, 'POST', '/auth/login', undefined, { identifier: EMAIL, password: PASSWORD })).body.data.token as string;
    const tokenA = await login(A);
    const tokenB = await login(B); // tokens are signed with the shared secret and verified against the shared database

    const read = async (base: string, token: string) => (await call(base, 'GET', '/settings', token)).body.data;
    const before = await read(B, tokenB);
    assert.equal(before.shift.fullDayThresholdMinutes, 360);
    assert.equal(before.offDayWork.weeklyOff.recognition, 'MANUAL');

    const saved = await call(A, 'PUT', '/settings', tokenA, {
      shift: { fullDayThresholdMinutes: 480, halfDayThresholdMinutes: 240 },
      offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await read(A, tokenA)).shift.fullDayThresholdMinutes, 480, 'the writer sees it immediately');

    // B was not told anything. Poll it until it converges, and record how long that took.
    const started = Date.now();
    let seen = before;
    while (Date.now() - started < 15_000) {
      seen = await read(B, tokenB);
      if (seen.shift.fullDayThresholdMinutes === 480) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const elapsed = Date.now() - started;
    assert.equal(seen.shift.fullDayThresholdMinutes, 480, `instance B still on the old policy after ${elapsed} ms`);
    assert.equal(seen.shift.halfDayThresholdMinutes, 240);
    assert.equal(seen.offDayWork.weeklyOff.recognition, 'AUTOMATIC');
    assert.equal(seen.version, saved.body.data.version, 'both instances run the same policy version');
    assert.ok(elapsed <= 3_000, `convergence took ${elapsed} ms with a 1 s refresh interval`);
    console.log(`[multi-instance] B converged ${elapsed} ms after the save through A (refresh interval 1000 ms)`);
  });
});
