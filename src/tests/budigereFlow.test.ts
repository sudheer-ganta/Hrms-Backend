import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { attendanceDayService } from '../modules/attendance/attendanceDay.service.js';
import { addDays, istToday, instantFromIst, monthOf } from '../utils/istTime.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

/**
 * The whole OT flow as the business described it, through the real app and real MongoDB:
 * type the overtime hours once in Settings, switch OT on for the people who get it, punch, read attendance and payroll.
 * Nobody is selected or assigned to anything.
 */
describe('overtime flow end to end: OT tick + punch out', { skip: SKIP }, () => {
  let h: Harness;
  const DAY = addDays(istToday(), -3);
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const ok = (r: { status: number; body: any }) => assert.equal(r.status, 200, JSON.stringify(r.body));
  const punch = async (code: string, time: string) =>
    h.models.AttendanceModel.create({
      sourceId: 'budigere', sourceName: 'Budigere', siteId: 'budigere', employeeCode: code, employeeName: code,
      punchDateTime: instantFromIst(DAY, `${time}:00`), entryDate: DAY, entryTime: `${time}:00`,
      machineId: '1', origin: 'DEVICE', vendorRecordHash: `${code}-${DAY}-${time}`,
    });
  const day = async (code: string) => (await h.call('GET', `/attendance/days?fromDate=${DAY}&toDate=${DAY}&employeeCode=${code}`, { token: h.tokens.founder })).body.data[0];

  test('only people with OT switched on earn it, from the punch out alone', async () => {
    const t = h.tokens.founder;
    ok(await h.call('PUT', '/settings', { token: t, body: { weeklyOffDays: [], shift: { otWindows: [{ start: '17:30', end: '18:30' }, { start: '19:00', end: '23:59' }] } } }));
    ok(await h.call('PUT', '/employees/E001', { token: t, body: { monthlyCtc: 30000, otEligible: true } }));
    ok(await h.call('PUT', '/employees/E002', { token: t, body: { monthlyCtc: 30000, otEligible: false } }));

    // Both stay until 9:15 PM.
    for (const code of ['E001', 'E002']) { await punch(code, '09:00'); await punch(code, '21:15'); }
    await attendanceDayService.recomputeMany([{ employeeCode: 'E001', businessDate: DAY }, { employeeCode: 'E002', businessDate: DAY }]);

    assert.equal((await day('E001')).overtimeMinutes, 195, '5:30-6:30 PM plus 7:00-9:15 PM');
    assert.equal((await day('E002')).overtimeMinutes, 0, 'OT is switched off for this person');

    const pay = await h.call('GET', `/payroll/all?month=${monthOf(DAY)}`, { token: t });
    ok(pay);
    const row = (code: string) => pay.body.data.find((p: any) => p.empCode === code);
    assert.equal(row('E001').totalOtHours, 3.3, 'shown to one decimal');
    const exact = Math.round(3.25 * (15000 / 26 / 8) * 2 * 100) / 100; // 195 minutes, priced exactly
    assert.ok(Math.abs(row('E001').otEarnings - exact) < 0.011, 'pay uses the exact minutes, not the rounded hours');
    assert.ok(row('E001').otEarnings > 0, 'OT is paid without anyone typing hours');
    assert.equal(row('E002').totalOtHours, 0);
    assert.equal(row('E002').otEarnings, 0);
  });

  test('switching OT off on the profile removes it straight away; switching it on brings it back', async () => {
    const t = h.tokens.founder;
    ok(await h.call('PUT', '/employees/E001', { token: t, body: { otEligible: false } }));
    assert.equal((await day('E001')).overtimeMinutes, 0);
    ok(await h.call('PUT', '/employees/E001', { token: t, body: { otEligible: true } }));
    assert.equal((await day('E001')).overtimeMinutes, 195);
  });

  test('HR can still type different OT hours for a person for the month', async () => {
    const t = h.tokens.founder;
    ok(await h.call('POST', `/payroll/adjustments/${monthOf(DAY)}`, { token: t, body: { adjustments: { E001: { otHours: 1 } } } }));
    const pay = await h.call('GET', `/payroll/all?month=${monthOf(DAY)}`, { token: t });
    assert.equal(pay.body.data.find((p: any) => p.empCode === 'E001').totalOtHours, 1);
  });
});
