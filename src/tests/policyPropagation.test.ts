import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { addDays, dayNameOf, instantFromIst, istToday } from '../utils/istTime.js';

/**
 * "Configure once, apply everywhere": these tests change ONLY Settings (never code) and assert that
 * every consumer (attendance grid, timesheet, dashboard, employee portal, payroll) follows.
 */

describe('no module hard-codes a configurable policy value', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const allowed = new Set(['policy.service.ts', 'policy.model.ts']); // the defaults live here and only here
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? (e.name === 'tests' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : [];
    });

  test('default shift times / thresholds appear as literals only in the policy defaults', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (allowed.has(path.basename(file))) continue;
      const text = fs.readFileSync(file, 'utf-8');
      const hits = text.match(/'(09:00|17:30|16:00)'|(?:full|half)Day\w*\s*[:=]\s*\d{2,}|grace\w*\s*[:=]\s*\d{2,}/gi);
      if (hits) offenders.push(`${path.relative(SRC, file)}: ${hits.join(', ')}`);
    }
    assert.deepEqual(offenders, []);
  });
});

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('policy propagation (real Express + MongoDB)', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const ok = (r: { status: number; body: any }, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));
  const t = () => h.tokens;

  // A fully elapsed month, so nothing depends on "today".
  const prev = addDays(`${istToday().slice(0, 7)}-01`, -1);
  const MONTH = prev.slice(0, 7);
  const monthDates = Array.from({ length: Number(prev.slice(8)) }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
  const WEEKDAY = monthDates.find((d) => dayNameOf(d) === 'WEDNESDAY')!;
  const TUESDAY = monthDates.find((d) => dayNameOf(d) === 'TUESDAY')!;
  const SUNDAY = monthDates.find((d) => dayNameOf(d) === 'SUNDAY')!;
  const HOLIDAY = monthDates.find((d) => dayNameOf(d) === 'THURSDAY')!;

  const punch = async (empCode: string, date: string, inT: string, outT: string) => {
    const { punchService } = await import('../modules/attendance/punch.service.js');
    const actor = { id: 'admin', role: 'SUPER_ADMIN' as const, name: 'Root Admin' };
    await punchService.recordPunch({ empCode, punchType: 'IN' }, actor, instantFromIst(date, `${inT}:00`));
    await punchService.recordPunch({ empCode, punchType: 'OUT' }, actor, instantFromIst(date, `${outT}:00`));
  };
  const dayOf = async (code: string, date: string, token = t().founder) =>
    (await h.call('GET', `/attendance/days?fromDate=${date}&toDate=${date}&employeeCode=${code}`, { token })).body;
  const payroll = async (code: string) =>
    (await h.call('GET', `/payroll/all?month=${MONTH}`, { token: t().founder })).body.data.find((p: any) => p.empCode === code);

  test('§17: changing ONLY Settings re-evaluates attendance, timesheet, dashboard, portal and payroll', async () => {
    ok(await h.call('PUT', '/settings', { token: t().founder, body: {
      weeklyOffDays: ['SUNDAY'], ess: { geofenceMode: 'OFF' },
      shift: { startTime: '09:00', endTime: '17:30', gracePeriodMinutes: 60, minCheckoutForFullDay: '16:00', halfDayThresholdMinutes: 180, fullDayThresholdMinutes: 360 },
    } }));
    ok(await h.call('PUT', '/employees/E001', { token: t().founder, body: { monthlyCtc: 30000 } }));
    ok(await h.call('PUT', '/employees/E002', { token: t().founder, body: { monthlyCtc: 30000 } }));
    await punch('E001', WEEKDAY, '10:20', '14:30'); // 250 min, late under the old policy
    await punch('E002', WEEKDAY, '09:30', '16:00'); // 390 min
    await punch('E001', TUESDAY, '10:00', '13:50'); // 230 min

    // ---- policy v1 ----
    const a1 = (await dayOf('E001', WEEKDAY)).data[0];
    const a2 = (await dayOf('E002', WEEKDAY)).data[0];
    assert.equal(a1.status, 'HALF_DAY');
    assert.equal(a1.isLate, true);
    assert.equal(a1.lateMinutes, 80);
    assert.equal(a1.earlyCheckoutMinutes, 180); // 17:30 - 14:30
    assert.equal((await dayOf('E001', TUESDAY)).data[0].status, 'HALF_DAY');
    assert.equal(a2.status, 'PRESENT');
    const v1 = a1.policyVersion;
    const list1 = (await h.call('GET', `/attendance/days?fromDate=${WEEKDAY}&toDate=${WEEKDAY}`, { token: t().founder })).body;
    assert.deepEqual([list1.summary.presentCount, list1.summary.halfDayCount, list1.summary.absentCount], [1, 1, 0]);
    const stats1 = (await h.call('GET', `/attendance/stats?date=${WEEKDAY}`, { token: t().founder })).body.data;
    const pay1 = await payroll('E001');
    assert.equal(pay1.halfDays, 2);
    assert.equal(pay1.lateArrivals, 1);

    // ---- change ONLY Settings ----
    ok(await h.call('PUT', '/settings', { token: t().founder, body: {
      shift: { startTime: '10:00', endTime: '18:00', gracePeriodMinutes: 30, minCheckoutForFullDay: '17:00', halfDayThresholdMinutes: 240, fullDayThresholdMinutes: 480 },
    } }));
    const settings = (await h.call('GET', '/settings', { token: t().employee1 })).body.data;
    assert.equal(settings.shift.startTime, '10:00');
    assert.equal(settings.derived.lateAfter, '10:30');

    // ---- policy v2: every consumer follows, no recompute call, no code change ----
    const b1 = (await dayOf('E001', WEEKDAY)).data[0];
    const b2 = (await dayOf('E002', WEEKDAY)).data[0];
    assert.equal(b1.status, 'HALF_DAY', '250 min still >= the new 240 half-day threshold');
    assert.equal(b1.isLate, false, '10:20 is inside the new 10:00 + 30 grace window');
    assert.equal(b1.lateMinutes, 20);
    assert.equal(b1.earlyCheckoutMinutes, 210); // 18:00 - 14:30
    assert.equal((await dayOf('E001', TUESDAY)).data[0].status, 'ABSENT', '230 min < the new 240 half-day threshold')
    assert.equal(b2.status, 'HALF_DAY', '390 min < the new 480 full-day threshold and 16:00 < the new 17:00 cutoff');
    assert.ok(b1.policyVersion > v1 && b1.policyVersion === settings.version);

    const list2 = (await h.call('GET', `/attendance/days?fromDate=${WEEKDAY}&toDate=${WEEKDAY}`, { token: t().founder })).body;
    assert.deepEqual([list2.summary.presentCount, list2.summary.halfDayCount, list2.summary.absentCount], [0, 2, 0]);
    const stats2 = (await h.call('GET', `/attendance/stats?date=${WEEKDAY}`, { token: t().founder })).body.data;
    assert.equal(stats1.presentCount, 1);
    assert.equal(stats2.presentCount, 0, 'dashboard follows the new thresholds');

    const sheet = (await h.call('GET', `/attendance/timesheet?fromDate=${WEEKDAY}&toDate=${WEEKDAY}`, { token: t().founder })).body.data;
    const row = (code: string) => sheet.find((r: any) => r.employeeCode === code);
    assert.equal(row('E001').days[WEEKDAY].status, 'HALF_DAY');
    assert.equal(row('E002').days[WEEKDAY].status, 'HALF_DAY');

    const portal = (await dayOf('E001', WEEKDAY, t().employee1)).data[0];
    assert.deepEqual(portal, b1, 'the employee portal row equals the admin row');

    const pay2 = await payroll('E001');
    assert.equal(pay2.halfDays, 1);
    assert.equal(pay2.absentDays, pay1.absentDays + 1, 'payroll counts the day as absent under the new policy');
    assert.equal(pay2.lateArrivals, 0);
    assert.ok(pay2.netPayable < pay1.netPayable, 'the extra LOP day lowers pay');
  });

  test('§18: weekly-off and paid-holiday work are separate policy rules; all modules agree in all four cases', async () => {
    ok(await h.call('PUT', '/settings', { token: t().founder, body: {
      shift: { startTime: '09:00', endTime: '17:30', gracePeriodMinutes: 60, minCheckoutForFullDay: '16:00', halfDayThresholdMinutes: 180, fullDayThresholdMinutes: 360 },
      offDayWork: { weeklyOff: { recognition: 'MANUAL' }, paidHoliday: { recognition: 'MANUAL' } },
    } }));
    ok(await h.call('POST', '/settings/holidays', { token: t().founder, body: { date: HOLIDAY, name: 'Founders Day', type: 'NATIONAL' } }), 201);
    // E001: works the Sunday, does NOT work the holiday.  E002: works the holiday, does NOT work the Sunday.
    await punch('E001', SUNDAY, '09:00', '17:30');
    await punch('E002', HOLIDAY, '09:00', '17:30');
    const base1 = await payroll('E001');
    const base2 = await payroll('E002');

    // The stored-days list holds only days that have facts; the timesheet and the portal calendar cover every date.
    // All of them must give the same verdict for the same employee-day.
    const view = async (code: string, date: string) => {
      const sheet = (await h.call('GET', `/attendance/timesheet?fromDate=${date}&toDate=${date}`, { token: t().founder })).body.data.find((r: any) => r.employeeCode === code).days[date];
      const cal = (await h.call('GET', `/attendance/calendar?month=${date.slice(0, 7)}&employeeCode=${code}`, { token: code === 'E001' ? t().employee1 : t().employee2 })).body.data.days.find((d: any) => d.businessDate === date);
      for (const k of ['status', 'isWeeklyOff', 'isHoliday', 'isPaidHoliday', 'offDayWorkFraction', 'workMinutes']) {
        assert.equal(cal[k], sheet[k], `portal calendar ${k} == timesheet for ${code} ${date}`);
      }
      const listed = (await dayOf(code, date)).data[0];
      if (listed) assert.deepEqual(listed, sheet, `stored-day row == timesheet cell for ${code} ${date}`);
      return sheet;
    };

    // ---- both rules MANUAL (previous behavior): off days stay off days, nothing derived ----
    for (const [code, date, status] of [['E001', SUNDAY, 'WEEKLY_OFF'], ['E002', HOLIDAY, 'HOLIDAY'], ['E002', SUNDAY, 'WEEKLY_OFF'], ['E001', HOLIDAY, 'HOLIDAY']] as const) {
      const d = await view(code, date);
      assert.equal(d.status, status);
      assert.equal(d.offDayWorkFraction, 0);
    }
    assert.equal(base1.weeklyOffWorkDays + base1.holidayWorkDays + base2.weeklyOffWorkDays + base2.holidayWorkDays, 0);

    // ---- change ONLY the weekly-off rule ----
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' } } } }));
    const sunWork = await view('E001', SUNDAY);
    assert.equal(sunWork.status, 'WEEKLY_OFF', 'still a weekly off');
    assert.equal(sunWork.isWeeklyOff, true);
    assert.equal(sunWork.offDayWorkFraction, 1);
    assert.equal(sunWork.workMinutes, 510);
    const sunNoWork = await view('E002', SUNDAY);
    assert.equal(sunNoWork.status, 'WEEKLY_OFF');
    assert.equal(sunNoWork.offDayWorkFraction, 0, 'no punches, nothing recognized');
    assert.equal((await view('E002', HOLIDAY)).offDayWorkFraction, 0, 'the holiday rule did not change');
    let p1 = await payroll('E001');
    let p2 = await payroll('E002');
    assert.equal(p1.weeklyOffWorkDays, 1);
    assert.equal(p1.holidayWorkDays, 0);
    assert.ok(p1.weeklyOffWorkEarnings > 0 && p1.holidayWorkEarnings === 0 && p1.netPayable > base1.netPayable);
    assert.equal(p2.weeklyOffWorkDays + p2.holidayWorkDays, 0, 'E002 worked only the holiday, whose rule is still MANUAL');
    assert.equal(p2.netPayable, base2.netPayable);
    assert.equal(p1.payableDays, base1.payableDays, 'working an off day does not change payable days');
    assert.ok(p1.payslip.earnings.some((l: any) => l.code === 'WEEKLY_OFF_WORK') && !p1.payslip.earnings.some((l: any) => l.code === 'HOLIDAY_WORK'));

    // ---- change ONLY the paid-holiday rule ----
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { paidHoliday: { recognition: 'AUTOMATIC' } } } }));
    const holWork = await view('E002', HOLIDAY);
    assert.equal(holWork.status, 'HOLIDAY');
    assert.equal(holWork.isPaidHoliday, true);
    assert.equal(holWork.holidayName, 'Founders Day');
    assert.equal(holWork.offDayWorkFraction, 1);
    const holNoWork = await view('E001', HOLIDAY);
    assert.equal(holNoWork.status, 'HOLIDAY');
    assert.equal(holNoWork.offDayWorkFraction, 0);
    p1 = await payroll('E001');
    p2 = await payroll('E002');
    assert.equal(p2.holidayWorkDays, 1);
    assert.equal(p2.weeklyOffWorkDays, 0);
    assert.ok(p2.holidayWorkEarnings > 0 && p2.netPayable > base2.netPayable);
    assert.ok(p2.payslip.earnings.some((l: any) => l.code === 'HOLIDAY_WORK'));
    assert.equal(p1.holidayWorkDays, 0);
    const sum = (ls: any[]) => ls.reduce((a, l) => a + l.amount, 0);
    for (const p of [p1, p2]) assert.ok(Math.abs(sum(p.payslip.earnings) - sum(p.payslip.deductions) - p.netPayable) < 0.011, `${p.empCode} payslip foots`);

    // ---- HR override: explicit, reasoned, attributed, stored apart from the resolver result, reversible ----
    const noReason = await h.call('POST', `/payroll/adjustments/${MONTH}`, { token: t().founder, body: { adjustments: { E001: { weeklyOffWorkDays: 0 } } } });
    assert.equal(noReason.status, 400, 'an off-day override without a reason is refused');
    ok(await h.call('POST', `/payroll/adjustments/${MONTH}`, { token: t().founder, body: { reason: 'Employee was on approved comp-off', adjustments: { E001: { weeklyOffWorkDays: 0 } } } }));
    const ov = await payroll('E001');
    assert.equal(ov.weeklyOffWorkDays, 0, 'effective days follow the override');
    assert.equal(ov.weeklyOffWorkAutoDays, 1, 'the resolver result is preserved next to it');
    assert.equal(ov.offDayWorkOverridden, true);
    assert.equal((await view('E001', SUNDAY)).offDayWorkFraction, 1, 'attendance itself is untouched by the override');
    const history = (await h.call('GET', `/payroll/adjustments/${MONTH}/history`, { token: t().founder })).body.data;
    assert.equal(history[0].reason, 'Employee was on approved comp-off');
    assert.equal(history[0].action, 'SAVE');
    assert.ok(history[0].performedBy, 'attributed to the acting user');
    ok(await h.call('POST', `/payroll/adjustments/${MONTH}`, { token: t().founder, body: { reason: 'Override withdrawn after review', adjustments: {} } }));
    const back = await payroll('E001');
    assert.equal(back.weeklyOffWorkDays, 1, 'removing the override restores the resolver result');
    assert.equal(back.offDayWorkOverridden, false);
    assert.equal((await h.call('GET', `/payroll/adjustments/${MONTH}/history`, { token: t().founder })).body.data.length, 2);

    // ---- and back: both rules flow in both directions with no other change ----
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { weeklyOff: { recognition: 'MANUAL' }, paidHoliday: { recognition: 'MANUAL' } } } }));
    assert.equal((await view('E001', SUNDAY)).offDayWorkFraction, 0);
    assert.equal((await view('E002', HOLIDAY)).offDayWorkFraction, 0);
    assert.equal((await payroll('E002')).netPayable, base2.netPayable);
  });

  test('exports: the frontend CSV carries the backend rows verbatim and changes when ONLY Settings change', async (ctx) => {
    const exporter = path.resolve(import.meta.dirname, '../../../Hrms-Frontend-/src/lib/payrollExport.ts');
    if (!fs.existsSync(exporter)) return ctx.skip('frontend checkout not next to the backend');
    const { buildPayrollTimesheetCsv } = await import(pathToFileURL(exporter).href);

    // Minimal RFC-4180 reader for the CSV the frontend produces.
    const parseCsv = (csv: string) => csv.split('\r\n').filter(Boolean).map((line) => {
      const cells: string[] = [];
      let cur = '', quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
        else if (c === '"') quoted = true;
        else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
      }
      cells.push(cur);
      return cells;
    });

    const lastDay = `${MONTH}-${String(monthDates.length).padStart(2, '0')}`;
    const exportFor = async (code: string) => {
      const sheet = (await h.call('GET', `/attendance/timesheet?fromDate=${MONTH}-01&toDate=${lastDay}`, { token: t().founder })).body.data;
      const payRows = (await h.call('GET', `/payroll/all?month=${MONTH}`, { token: t().founder })).body.data;
      const summaries = Object.fromEntries(payRows.map((r: any) => [r.empCode, r]));
      const csv: string = buildPayrollTimesheetCsv(sheet, monthDates, MONTH, summaries, 'fixed');
      const table = parseCsv(csv);
      const header = table.find((r) => r[0] === 'Emp Code')!;
      const row = table.find((r) => r[0] === code)!;
      const cell = (name: string) => row[header.indexOf(name)];
      return { cell, pay: summaries[code], sheet: sheet.find((r: any) => r.employeeCode === code), dayCell: (d: string) => cell(`Day ${d.slice(8)}`) };
    };
    const num = (v: string) => Number(v);

    ok(await h.call('PUT', '/settings', { token: t().founder, body: {
      shift: { startTime: '09:00', endTime: '17:30', gracePeriodMinutes: 60, minCheckoutForFullDay: '16:00', halfDayThresholdMinutes: 180, fullDayThresholdMinutes: 360 },
      offDayWork: { weeklyOff: { recognition: 'MANUAL' }, paidHoliday: { recognition: 'MANUAL' } },
    } }));
    const a = await exportFor('E001');
    assert.equal(num(a.cell('Half Days')), a.pay.halfDays);
    assert.equal(num(a.cell('Absent Days')), a.pay.absentDays);
    assert.equal(num(a.cell('Net Pay')), a.pay.netPayable);
    assert.equal(num(a.cell('Weekly-off Work Days')), 0);
    assert.equal(a.dayCell(TUESDAY), a.sheet.days[TUESDAY].statusLabel, 'a day cell is the backend status label');

    // Change ONLY the thresholds.
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { shift: { halfDayThresholdMinutes: 240, fullDayThresholdMinutes: 480 } } }));
    const b = await exportFor('E001');
    assert.equal(num(b.cell('Absent Days')), b.pay.absentDays);
    assert.equal(num(b.cell('Net Pay')), b.pay.netPayable);
    assert.equal(num(b.cell('Absent Days')), num(a.cell('Absent Days')) + 1, 'the CSV followed the new threshold (230 min is now absent)');
    assert.equal(b.dayCell(TUESDAY), 'Absent');
    assert.ok(num(b.cell('Net Pay')) < num(a.cell('Net Pay')));
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { shift: { halfDayThresholdMinutes: 180, fullDayThresholdMinutes: 360 } } }));

    // Change ONLY the weekly-off rule.
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' } } } }));
    const c = await exportFor('E001');
    assert.equal(num(c.cell('Weekly-off Work Days')), 1);
    assert.equal(num(c.cell('Weekly-off Work Days')), c.pay.weeklyOffWorkDays);
    assert.equal(num(c.cell('Weekly-off Work Pay')), c.pay.weeklyOffWorkEarnings);
    assert.equal(num(c.cell('Net Pay')), c.pay.netPayable);
    assert.ok(num(c.cell('Net Pay')) > num(a.cell('Net Pay')));
    assert.equal(c.dayCell(SUNDAY), 'Weekly Off', 'the day stays a weekly off in the grid');
    ok(await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { weeklyOff: { recognition: 'MANUAL' } } } }));
  });

  test('settings validation: unknown off-day-work mode is rejected', async () => {
    const r = await h.call('PUT', '/settings', { token: t().founder, body: { offDayWork: { weeklyOff: { recognition: 'WHENEVER' } } } });
    assert.equal(r.status, 400);
  });
});
