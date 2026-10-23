process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDay, applyAbsenceBeforeWeeklyOff, DayFacts, ResolvedDay } from '../modules/attendance/attendanceResolver.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';
import { datesBetween, daysInMonth } from '../utils/istTime.js';
import { startHarness, mongodAvailable, Harness } from './helpers.js';

// November 2026: Sunday the 1st, 8th, 15th... (Fri 30 Oct, Sat 31 Oct, Fri 6 Nov, Sat 7 Nov)
const TODAY = '2026-11-30';
const AUTO: HRMSPolicySettings = { ...DEFAULT_SETTINGS, offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' }, paidHoliday: { recognition: 'MANUAL' } } };
const WORKED: DayFacts = { firstIn: '09:00', lastOut: '17:30', workMinutes: 510 };

const resolveAll = (from: string, to: string, facts: Record<string, DayFacts>, policy = AUTO): ResolvedDay[] =>
  datesBetween(from, to).map((d) => resolveDay(d, facts[d], { policy, today: TODAY }));
const sunday = (days: ResolvedDay[], date: string) => days.find((d) => d.businessDate === date)!;

describe('weekly off worked after two absent days is a normal day, not weekly-off pay', () => {
  test('absent Fri + Sat, then works Sunday: no weekly-off credit, flagged as a normal day', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-08': WORKED }));
    const sun = sunday(days, '2026-11-08');
    assert.equal(sunday(days, '2026-11-06').status, 'ABSENT');
    assert.equal(sunday(days, '2026-11-07').status, 'ABSENT');
    assert.equal(sun.status, 'WEEKLY_OFF', 'it stays a weekly off in the calendar');
    assert.equal(sun.offDayWorkFraction, 0);
    assert.equal(sun.offDayWorkAsNormalDay, true);
  });

  test('only one absent day before: the normal weekly-off credit stands', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-07': WORKED, '2026-11-08': WORKED }));
    const sun = sunday(days, '2026-11-08');
    assert.equal(sun.offDayWorkFraction, 1);
    assert.equal(sun.offDayWorkAsNormalDay, false);
  });

  test('absent Friday only (Saturday worked): the credit stands', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-07': WORKED, '2026-11-08': WORKED }));
    assert.equal(sunday(days, '2026-11-08').offDayWorkFraction, 1);
  });

  test('a Sunday nobody worked is untouched', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED }));
    const sun = sunday(days, '2026-11-08');
    assert.equal(sun.offDayWorkFraction, 0);
    assert.equal(sun.offDayWorkAsNormalDay, false);
  });

  test('paid leave before the Sunday is not an absence', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', {
      '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-08': WORKED,
      '2026-11-06': { adjustments: [{ id: 'a1', requestId: 'r1', kind: 'LEAVE', paid: true, fraction: 1 }] },
    }));
    assert.equal(sunday(days, '2026-11-06').status, 'LEAVE_PAID');
    assert.equal(sunday(days, '2026-11-08').offDayWorkFraction, 1);
  });

  test('a half-day worked on the Sunday after two absences is also just a normal day', () => {
    const half: DayFacts = { firstIn: '09:00', lastOut: '12:30', workMinutes: 210 };
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-08': half }));
    assert.equal(sunday(days, '2026-11-08').offDayWorkFraction, 0);
    assert.equal(sunday(days, '2026-11-08').offDayWorkAsNormalDay, true);
  });

  test('the rule can be switched off (0 days) and the input is never modified', () => {
    const input = resolveAll('2026-11-04', '2026-11-08', { '2026-11-04': WORKED, '2026-11-05': WORKED, '2026-11-08': WORKED });
    const snapshot = JSON.stringify(input);
    assert.equal(sunday(applyAbsenceBeforeWeeklyOff(input, 0), '2026-11-08').offDayWorkFraction, 1);
    applyAbsenceBeforeWeeklyOff(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  test('a Sunday too close to the start of the data to judge is left alone', () => {
    const days = applyAbsenceBeforeWeeklyOff(resolveAll('2026-11-07', '2026-11-08', { '2026-11-08': WORKED }));
    assert.equal(sunday(days, '2026-11-08').offDayWorkFraction, 1);
  });
});

describe('payroll: the same Sunday pays nothing extra after two absences', () => {
  const profile: EmployeeProfile = { empCode: 'EMP001', name: 'Test', otEligible: true, status: 'active', monthlyCtc: 30000 } as EmployeeProfile;
  const month = (facts: Record<string, DayFacts>) => {
    const dates = daysInMonth('2026-11');
    // everyone works the weekdays they are given; any other weekday is absent
    return applyAbsenceBeforeWeeklyOff(dates.map((d) => resolveDay(d, facts[d], { policy: AUTO, today: TODAY })));
  };
  const weekdays = datesBetween('2026-11-02', '2026-11-05').reduce<Record<string, DayFacts>>((m, d) => ({ ...m, [d]: WORKED }), {});

  test('after two absences: no weekly-off working pay; with Saturday worked: the 2x day is paid', () => {
    const afterAbsence = computeEmployeePayroll({ profile, month: '2026-11', days: month({ ...weekdays, '2026-11-08': WORKED }), policy: AUTO });
    const saturdayWorked = computeEmployeePayroll({ profile, month: '2026-11', days: month({ ...weekdays, '2026-11-07': WORKED, '2026-11-08': WORKED }), policy: AUTO });
    assert.equal(afterAbsence.weeklyOffWorkAutoDays, 0);
    assert.equal(afterAbsence.weeklyOffWorkEarnings, 0);
    assert.equal(saturdayWorked.weeklyOffWorkAutoDays, 1);
    assert.ok(saturdayWorked.weeklyOffWorkEarnings > 0);
  });
});

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('month boundary: the two absent days sit in the previous month', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  test('Sunday 1 March 2026 worked after absent Fri 27 / Sat 28 Feb is a normal day', async () => {
    const put = await h.call('PUT', '/settings', { token: h.tokens.superAdmin, body: { offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' } } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await h.models.AttendanceDayModel.create({ employeeCode: 'E001', businessDate: '2026-03-01', firstIn: '09:00', lastOut: '17:30', workMinutes: 510, punchCount: 2, origins: ['DEVICE'] });
    const cal = (await h.call('GET', '/attendance/calendar?month=2026-03&employeeCode=E001', { token: h.tokens.founder })).body.data;
    const row = (cal.days ?? cal).find((d: any) => d.businessDate === '2026-03-01');
    assert.equal(row.status, 'WEEKLY_OFF');
    assert.equal(row.offDayWorkFraction, 0);
    assert.equal(row.offDayWorkAsNormalDay, true);
    assert.equal((cal.days ?? cal).length, 31, 'only the requested month comes back, not the lookback days');

    // Every other view of the same day gives the same answer.
    const listed = (await h.call('GET', '/attendance/days?fromDate=2026-03-01&toDate=2026-03-01&employeeCode=E001', { token: h.tokens.founder })).body.data[0];
    const sheet = (await h.call('GET', '/attendance/timesheet?fromDate=2026-03-01&toDate=2026-03-01', { token: h.tokens.founder })).body.data.find((r: any) => r.employeeCode === 'E001').days['2026-03-01'];
    for (const view of [listed, sheet]) {
      assert.equal(view.offDayWorkFraction, 0);
      assert.equal(view.offDayWorkAsNormalDay, true);
    }
  });
});
