import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { addDays, instantFromIst, istToday } from '../utils/istTime.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('operations: overnight ESS, repeated checkout, sync overlap, scheduler lease, fail-closed', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const ok = (r: { status: number; body: any }, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));

  test('overnight shift: IN 22:05 and OUT 06:10 next morning are ONE business day of ~8h', async () => {
    ok(await h.call('PUT', '/settings', { token: h.tokens.founder, body: { weeklyOffDays: [], shift: { startTime: '22:00', endTime: '06:00', minCheckoutForFullDay: '', gracePeriodMinutes: 60 }, ess: { geofenceMode: 'OFF' } } }));
    const day = addDays(istToday(), -10);
    const next = addDays(day, 1);
    const actor = { id: 'x', role: 'EMPLOYEE' as const, empCode: 'E001', name: 'Asha One' };
    const inn = await (await import('../modules/attendance/punch.service.js')).punchService.recordPunch({ punchType: 'IN' }, actor, instantFromIst(day, '22:05:00'));
    assert.equal(inn.businessDate, day);
    const out = await (await import('../modules/attendance/punch.service.js')).punchService.recordPunch({ punchType: 'AUTO' }, actor, instantFromIst(next, '06:10:00'));
    assert.equal(out.action, 'CHECKED_OUT');
    assert.equal(out.businessDate, day, 'the next-morning OUT belongs to the shift that started the evening before');
    assert.equal(out.workMinutes, 8 * 60 + 5);
    assert.equal(out.status, 'PRESENT');
    assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E001' }), 1);
    assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E001', businessDate: next }), 0);
  });

  test('repeated checkout: a quick double-tap is rejected; a later checkout updates the last-out and never adds a day', async () => {
    ok(await h.call('PUT', '/settings', { token: h.tokens.founder, body: { shift: { startTime: '09:00', endTime: '17:30', minCheckoutForFullDay: '16:00' } } }));
    const { punchService } = await import('../modules/attendance/punch.service.js');
    const actor = { id: 'y', role: 'EMPLOYEE' as const, empCode: 'E002', name: 'Ravi Two' };
    const day = addDays(istToday(), -8);
    await punchService.recordPunch({ punchType: 'IN' }, actor, instantFromIst(day, '09:00:00'));
    await punchService.recordPunch({ punchType: 'OUT' }, actor, instantFromIst(day, '17:30:00'));
    await assert.rejects(punchService.recordPunch({ punchType: 'OUT' }, actor, instantFromIst(day, '17:30:20')), /wait a minute/);
    const later = await punchService.recordPunch({ punchType: 'OUT' }, actor, instantFromIst(day, '18:45:00'));
    assert.equal(later.lastOut, '18:45');
    assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E002', businessDate: day }), 1);
    assert.equal(await h.models.AttendanceModel.countDocuments({ employeeCode: 'E002', entryDate: day }), 3);
    await assert.rejects(punchService.recordPunch({ punchType: 'IN' }, actor, instantFromIst(day, '19:00:00')), /Already checked in/);
  });

  test('admin punching for an employee records the EMPLOYEE\'s name, not the admin\'s', async () => {
    const { punchService } = await import('../modules/attendance/punch.service.js');
    const day = addDays(istToday(), -6);
    await punchService.recordPunch({ empCode: 'e001', punchType: 'IN' }, { id: 'a', role: 'SUPER_ADMIN', name: 'Root Admin' }, instantFromIst(day, '09:00:00'));
    const p: any = await h.models.AttendanceModel.findOne({ employeeCode: 'E001', entryDate: day }).lean();
    assert.equal(p.employeeName, 'Asha One');
    assert.equal(p.meta.punchedByName, 'Root Admin');
  });

  test('two syncs of the same source cannot overlap', async () => {
    let release: () => void = () => undefined;
    h.services.etimeofficeClient.fetchPunchDataMCID = () => new Promise((resolve) => { release = () => resolve({ success: true, records: [] }); });
    const day = addDays(istToday(), -2);
    const first = h.services.syncService.syncRaw('office', { fromDate: day, toDate: day });
    await new Promise((r) => setTimeout(r, 150));
    await assert.rejects(h.services.syncService.syncRaw('office', { fromDate: day, toDate: day }), /already running/);
    release();
    const res = await first;
    assert.equal(res.success, true);
  });

  test('scheduler: only one instance can hold the cluster lease', async () => {
    const { SyncScheduler } = await import('../modules/sync/syncScheduler.js');
    const a = new SyncScheduler();
    const b = new SyncScheduler();
    assert.equal(await a.acquireLease(), true);
    assert.equal(await b.acquireLease(), false, 'second instance must not run the cycle');
    assert.equal(await a.acquireLease(), true, 'the holder renews its own lease');
  });

  test('policy cache converges across instances (periodic refresh reads MongoDB)', async () => {
    const { PolicyModel } = await import('../modules/settings/policy.model.js');
    await PolicyModel.updateOne({ key: 'global_hrms_policy' }, { $set: { 'overtime.hoursPerDay': 7 } });
    await h.services.policyService.refreshFromDb();
    assert.equal(h.services.policyService.getSettings().overtime.hoursPerDay, 7);
  });

  test('FAIL CLOSED: with the database down, payroll and attendance answer 503 (never stale/local data)', async () => {
    const { default: mongoose } = await import('mongoose');
    const token = h.tokens.founder;
    await mongoose.connection.close();
    for (const p of ['/payroll/all?month=2026-09', '/attendance/days', '/employees', '/requests', '/attendance/stats']) {
      const r = await h.call('GET', p, { token });
      assert.equal(r.status, 503, `${p} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'SERVICE_UNAVAILABLE');
    }
    const health = await h.call('GET', '/health');
    assert.equal(health.status, 503);
    assert.ok(!JSON.stringify(health.body).includes('mongodb'));
  });
});
