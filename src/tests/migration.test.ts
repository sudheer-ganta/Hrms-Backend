import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { startMongoOnly, mongodAvailable } from './helpers.js';

const SKIP = !mongodAvailable() ? 'no local mongod available' : false;

describe('legacy → canonical data migration', { skip: SKIP }, () => {
  let m: Awaited<ReturnType<typeof startMongoOnly>>;
  const script = path.resolve(process.cwd(), 'src/scripts/migrate_canonical.ts');

  const run = (...flags: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...flags], {
      env: { ...process.env, MIGRATE_MONGODB_URI: m.uri, JWT_SECRET: 'x'.repeat(48), NODE_ENV: 'test' },
      encoding: 'utf-8',
      timeout: 120_000,
    });

  before(async () => {
    m = await startMongoOnly();
    const d = m.db;
    const now = new Date();
    await d.collection('policies').insertOne({ key: 'global_hrms_policy', weeklyOffDays: ['Sunday'], holidays: [{ id: 'h1', date: '2026-09-10', name: 'Fest', type: 'OPTIONAL' }], shift: { startTime: '09:00', endTime: '17:30' } });
    await d.collection('employees').insertMany([
      { empCode: 'E001', name: 'Asha', location: 'Budigere', joiningDate: '2024-01-01', bankAccountNumber: '123456789012', otRatePerHour: 2, monthlyCtc: 30000, status: 'active' },
      { empCode: 'E002', name: 'Ravi', location: 'ColorMyles', status: 'active' },
    ]);
    await d.collection('users').insertOne({ email: 'e1@x.local', passwordHash: 'x', name: 'Asha', role: 'EMPLOYEE', empCode: 'e001', status: 'active' });
    // legacy raw punches: biometric (hash from a server-local instant), plus ESS punch written as web-portal
    await d.collection('attendance_records').insertMany([
      { sourceId: 'budigere', sourceName: 'Budigere', employeeCode: 'E001', employeeName: 'Asha', punchDateTime: new Date('2026-09-02T09:02:11Z'), entryDate: '2026-09-02', entryTime: '09:02:11', machineId: '1', machineFlag: null, vendorRecordHash: 'legacy-hash-1', syncedAt: now },
      { sourceId: 'budigere', sourceName: 'Budigere', employeeCode: 'E001', employeeName: 'Asha', punchDateTime: new Date('2026-09-02T17:35:40Z'), entryDate: '2026-09-02', entryTime: '17:35:40', machineId: '1', machineFlag: null, vendorRecordHash: 'legacy-hash-2', syncedAt: now },
      // the same physical punch re-imported under a different legacy hash (different server timezone)
      { sourceId: 'budigere', sourceName: 'Budigere', employeeCode: 'E001', employeeName: 'Asha', punchDateTime: new Date('2026-09-02T03:32:11Z'), entryDate: '2026-09-02', entryTime: '09:02:11', machineId: '1', machineFlag: null, vendorRecordHash: 'legacy-hash-1b', syncedAt: now },
      { sourceId: 'web-portal', sourceName: 'Web / Mobile ESS', employeeCode: 'E002', employeeName: 'Ravi', punchDateTime: new Date('2026-09-03T04:00:00Z'), entryDate: '2026-09-03', entryTime: '09:30:00', machineId: 'ESS_GEO_PORTAL', machineFlag: 'IN', vendorRecordHash: 'E002_2026-09-03_09:30:00_CHECKED_IN', syncedAt: now },
    ]);
    // legacy daily rows: vendor row, ESS row for the same person/day, corrupted partial record, lowercase code, override row
    await d.collection('in_out_records').insertMany([
      { sourceId: 'budigere', sourceName: 'Budigere', employeeCode: 'E001', employeeName: 'Asha', date: '2026-09-02', inTime: '09:02', outTime: '17:35', workTime: '08:33', workMinutes: 513, overTime: '00:00', lateIn: '00:02', status: 'P', recordKey: 'budigere_E001_2026-09-02', syncedAt: now },
      { sourceId: 'web-portal', sourceName: 'Web / Mobile ESS', employeeCode: 'E001', employeeName: 'Asha', date: '2026-09-02', inTime: '09:10', outTime: '--:--', workMinutes: 0, status: 'P', recordKey: 'web-portal_E001_2026-09-02', syncedAt: now },
      { inTime: '09:00', outTime: '10:00', status: 'P', recordKey: 'partial-corrupt', workMinutes: 60, date: '2026-09-04', syncedAt: now },
      { sourceId: 'bidarahalli', sourceName: 'Bidarahalli', employeeCode: 'e002', employeeName: 'Ravi', date: '2026-09-05', inTime: '--:--', outTime: '--:--', workMinutes: 0, status: 'A', recordKey: 'bidarahalli_e002_2026-09-05', syncedAt: now },
      { sourceId: 'office', sourceName: 'ColorMyles', employeeCode: 'E001', employeeName: 'Asha', date: '2026-09-07', inTime: '--:--', outTime: '--:--', workMinutes: 0, status: 'L', remark: 'CASUAL_LEAVE', manualOverride: true, recordKey: 'office_E001_2026-09-07', syncedAt: now },
      { sourceId: 'budigere', sourceName: 'Budigere', employeeCode: 'E001', employeeName: 'Asha', date: '2026-09-07', inTime: '--:--', outTime: '--:--', workMinutes: 0, status: 'L', remark: 'CASUAL_LEAVE', manualOverride: true, recordKey: 'budigere_E001_2026-09-07', syncedAt: now },
    ]);
    await d.collection('requests').insertMany([
      { id: 'req_1', empCode: 'e001', empName: 'Asha', requestType: 'LEAVE', leaveType: 'CASUAL_LEAVE', date: '2026-09-07', reason: 'x', status: 'APPROVED', createdAt: now.toISOString(), reviewedBy: 'Founder', reviewedAt: now.toISOString() },
      { id: 'req_2', empCode: 'E002', empName: 'Ravi', requestType: 'MISSED_PUNCH', date: '2026-09-05', inTime: '09:00', outTime: '18:00', reason: 'y', status: 'PENDING', createdAt: now.toISOString() },
    ]);
    await d.collection('payroll_runs').insertOne({ month: '2026-08', status: 'CLOSED', snapshot: [{ empCode: 'E001', netPayable: 25000 }], employeeCount: 1, totalNetPaid: 25000, closedAt: now, closedBy: 'Founder', history: [] });
  });
  after(async () => { await m?.stop(); });

  const counts = async () => Object.fromEntries(await Promise.all(['attendance_records', 'in_out_records', 'requests', 'employees', 'users'].map(async (c) => [c, await m.db.collection(c).countDocuments()])));

  test('dry run reports the plan and changes nothing', async () => {
    const before = await counts();
    const r = run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Dry run only/);
    assert.match(r.stdout, /archived:in_out_records:corrupted-partial-record/);
    assert.deepEqual(await counts(), before);
    assert.equal(await m.db.collection('attendance_days').countDocuments(), 0);
  });

  test('refuses to write without --backup-confirmed', () => {
    const r = run('--apply');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /backup-confirmed/);
  });

  test('apply: identity, raw punches, staging, adjustments, snapshots and attendance days are canonical', async () => {
    const r = run('--apply', '--backup-confirmed');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const d = m.db;

    // identity
    assert.equal((await d.collection('users').findOne({ email: 'e1@x.local' }))!.empCode, 'E001');
    const e1 = (await d.collection('employees').findOne({ empCode: 'E001' }))!;
    assert.equal(e1.location, 'budigere');
    assert.equal(e1.doj, '2024-01-01');
    assert.equal(e1.bankAccount, '123456789012');
    assert.equal(e1.otMultiplier, 2, 'legacy overloaded otRatePerHour became an explicit multiplier');
    assert.equal(e1.otRatePerHour, undefined);
    assert.equal((await d.collection('employees').findOne({ empCode: 'E002' }))!.location, 'office');

    // policy
    const pol = (await d.collection('policies').findOne({ key: 'global_hrms_policy' }))!;
    assert.deepEqual(pol.weeklyOffDays, ['SUNDAY']);
    assert.equal(pol.holidays[0].paid, true, 'legacy holidays were all paid days off; behavior preserved');

    // raw punches: re-hashed on IST wall clock; the cross-timezone duplicate is archived, never lost
    const punches = await d.collection('attendance_records').find({ employeeCode: 'E001' }).toArray();
    assert.equal(punches.length, 2);
    assert.ok(punches.every((p) => p.origin === 'DEVICE' && p.vendorRecordHash.length === 64));
    assert.equal(await d.collection('attendance_records_archive').countDocuments({ _archiveReason: 'duplicate-punch' }), 1);
    const ess = (await d.collection('attendance_records').findOne({ employeeCode: 'E002' }))!;
    assert.equal(ess.origin, 'ESS_WEB');
    assert.notEqual(ess.sourceId, 'web-portal');
    assert.equal(ess.punchDateTime.toISOString(), '2026-09-03T04:00:00.000Z'); // 09:30 IST

    // staging: ESS row, corrupted row archived (not deleted); keys normalized; no override flags
    assert.equal(await d.collection('in_out_records').countDocuments({ sourceId: 'web-portal' }), 0);
    assert.equal(await d.collection('in_out_records_archive').countDocuments({ _archiveReason: 'corrupted-partial-record' }), 1);
    assert.equal(await d.collection('in_out_records_archive').countDocuments({ _archiveReason: 'ess-row-moved-to-raw-punches' }), 1);
    assert.equal(await d.collection('in_out_records_archive').countDocuments({ _archiveReason: 'approval-override-row' }), 1);
    assert.equal(await d.collection('in_out_records').countDocuments({ employeeCode: 'e002' }), 0);
    assert.equal(await d.collection('in_out_records').countDocuments({ manualOverride: { $exists: true } }), 0);

    // requests → adjustments
    const req1 = (await d.collection('requests').findOne({ id: 'req_1' }))!;
    assert.equal(req1.status, 'APPLIED');
    assert.equal(req1.empCode, 'E001');
    assert.equal(req1.days, 1);
    assert.equal(await d.collection('attendance_adjustments').countDocuments({ requestId: 'req_1', status: 'ACTIVE' }), 1);
    assert.equal((await d.collection('requests').findOne({ id: 'req_2' }))!.status, 'PENDING');

    // payroll snapshot versioning
    assert.equal((await d.collection('payroll_runs').findOne({ month: '2026-08' }))!.currentVersion, 1);
    assert.equal(await d.collection('payroll_snapshots').countDocuments({ month: '2026-08', version: 1 }), 1);

    // attendance days: exactly one per employee per date, built from the same code path as production
    const dup = await d.collection('attendance_days').aggregate([{ $group: { _id: { e: '$employeeCode', d: '$businessDate' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
    assert.equal(dup.length, 0);
    const day = (await d.collection('attendance_days').findOne({ employeeCode: 'E001', businessDate: '2026-09-02' }))!;
    assert.equal(day.firstIn, '09:02');
    assert.equal(day.lastOut, '17:35');
    const leave = (await d.collection('attendance_days').findOne({ employeeCode: 'E001', businessDate: '2026-09-07' }))!;
    assert.equal(leave.manualOverride, true);
  });

  test('re-running the migration is idempotent', async () => {
    const before = await counts();
    const days = await m.db.collection('attendance_days').countDocuments();
    const r = run('--apply', '--backup-confirmed');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /archived:/);
    assert.deepEqual(await counts(), before);
    assert.equal(await m.db.collection('attendance_days').countDocuments(), days);
  });
});
