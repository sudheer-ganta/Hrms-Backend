import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { startMongoOnly, mongodAvailable } from './helpers.js';

const SKIP = !mongodAvailable() ? 'no local mongod available' : false;

/**
 * The migration must survive a crash: restart continues from the last good batch, never duplicates,
 * verifies source vs destination, and a dry run must not write ANYTHING (not even indexes).
 */
describe('migration: resumable, idempotent, self-verifying', { skip: SKIP }, () => {
  let m: Awaited<ReturnType<typeof startMongoOnly>>;
  const script = path.resolve(process.cwd(), 'src/scripts/migrate_canonical.ts');
  const run = (extraEnv: Record<string, string>, ...flags: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...flags], {
      env: { ...process.env, MIGRATE_MONGODB_URI: m.uri, JWT_SECRET: 'x'.repeat(48), NODE_ENV: 'test', MIGRATE_DAY_BATCH: '50', ...extraEnv },
      encoding: 'utf-8',
      timeout: 180_000,
    });

  const EMPLOYEES = 12;
  const DAYS = 20; // 240 employee-days => 5 batches of 50
  const state = async () => m.db.collection('migration_state').findOne({ _id: 'canonical-attendance-days' as any });
  const dayCount = () => m.db.collection('attendance_days').countDocuments();
  const dupes = async () => (await m.db.collection('attendance_days').aggregate([{ $group: { _id: { e: '$employeeCode', d: '$businessDate' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray()).length;

  before(async () => {
    m = await startMongoOnly();
    const now = new Date();
    await m.db.collection('policies').insertOne({ key: 'global_hrms_policy', weeklyOffDays: ['Sunday'], holidays: [], shift: { startTime: '09:00', endTime: '17:30' } });
    const rows: any[] = [];
    for (let e = 0; e < EMPLOYEES; e++) {
      for (let d = 1; d <= DAYS; d++) {
        const code = `E${100 + e}`;
        const date = `2026-09-${String(d).padStart(2, '0')}`;
        rows.push({ sourceId: 'office', sourceName: 'ColorMyles', employeeCode: code, employeeName: `Emp ${e}`, date, inTime: '09:05', outTime: '17:40', workTime: '08:35', workMinutes: 515, status: 'P', recordKey: `office_${code}_${date}`, syncedAt: now });
      }
    }
    await m.db.collection('in_out_records').insertMany(rows);
    await m.db.collection('employees').insertMany(Array.from({ length: EMPLOYEES }, (_, e) => ({ empCode: `E${100 + e}`, name: `Emp ${e}`, location: 'office', status: 'active' })));
  });
  after(async () => { await m?.stop(); });

  test('a dry run writes nothing: no collections, no indexes, no checkpoint', async () => {
    const snapshot = async () => ({
      collections: (await m.db.listCollections().toArray()).map((c) => c.name).sort(),
      indexes: Object.fromEntries(await Promise.all((await m.db.listCollections().toArray()).map(async (c) => [c.name, (await m.db.collection(c.name).indexes()).map((i) => i.name).sort()]))),
    });
    const before = await snapshot();
    const r = run({});
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Dry run only/);
    assert.match(r.stdout, /Source counts: raw punches 0, daily rows \(in_out\) 240/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await state(), null);
  });

  test('a crash mid-way leaves a checkpoint; the next run resumes from the last good batch', async () => {
    const crashed = run({ MIGRATE_FAIL_AFTER_BATCHES: '2' }, '--apply', '--backup-confirmed');
    assert.notEqual(crashed.status, 0, 'the simulated crash must fail the run');
    assert.match(crashed.stdout, /batch 2\/5/);
    const st: any = await state();
    assert.equal(st.status, 'RUNNING');
    assert.equal(st.nextBatch, 2, 'two batches were completed and recorded');
    assert.equal(await dayCount(), 100, '2 batches x 50 employee-days are already in the database');

    const resumed = run({}, '--apply', '--backup-confirmed');
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.match(resumed.stdout, /Checkpoint found: status RUNNING, batch 2\/5, will resume/);
    assert.match(resumed.stdout, /Resuming at batch 3\/5: 100 employee-days already done are skipped/);
    assert.doesNotMatch(resumed.stdout, /attendance_days batch [12]\/5/, 'finished batches are not redone');
    assert.match(resumed.stdout, /\[VERIFY\] PASS  employee-days: every source day has exactly one attendance_day: expected 240, destination 240, missing 0, duplicates 0/);
    assert.match(resumed.stdout, /\[VERIFY\] PASS  daily rows: source - archived = destination: 240 - 0 = 240, destination 240/);
    assert.doesNotMatch(resumed.stdout, /\[VERIFY\] FAIL/);
    assert.match(resumed.stdout, /migrated this run 140 employee-days, skipped \(already done, resumed\) 2 batch/);
    assert.equal(await dayCount(), EMPLOYEES * DAYS);
    assert.equal(await dupes(), 0);
    assert.equal((await state() as any).status, 'COMPLETE');
  });

  test('re-running a completed migration changes nothing, and --restart rebuilds without duplicates', async () => {
    const again = run({}, '--apply', '--backup-confirmed');
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /migrated this run 0 employee-days/);
    assert.equal(await dayCount(), EMPLOYEES * DAYS);

    const restart = run({}, '--apply', '--backup-confirmed', '--restart');
    assert.equal(restart.status, 0, restart.stderr + restart.stdout);
    assert.match(restart.stdout, /migrated this run 240 employee-days/);
    assert.equal(await dayCount(), EMPLOYEES * DAYS);
    assert.equal(await dupes(), 0);
    assert.match(restart.stdout, /Applied and verified/);
  });

  test('verification catches a bad row and fails the run (exit code 3)', async () => {
    await m.db.collection('attendance_days').insertOne({ employeeCode: 'E100', businessDate: '2026-09-31', firstIn: '99:99', workMinutes: -5 });
    const r = run({}, '--apply', '--backup-confirmed');
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /\[VERIFY\] FAIL  no orphan attendance_days/);
    assert.match(r.stdout, /\[VERIFY\] FAIL  no invalid attendance_days/);
    assert.match(r.stdout, /verification check\(s\) FAILED\. Do not deploy/);
  });
});
