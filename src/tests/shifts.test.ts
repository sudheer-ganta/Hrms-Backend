import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDay } from '../modules/attendance/attendanceResolver.js';
import { DEFAULT_SETTINGS, validatePolicyUpdate } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings, ShiftConfig } from '../modules/settings/policy.types.js';

// A Monday. Nothing here is built into the app: the times below are what HR types in Settings.
const DATE = '2026-09-14';
const TODAY = '2026-10-01';

const shift = (over: Partial<ShiftConfig>): ShiftConfig => ({ ...DEFAULT_SETTINGS.shift, minCheckoutForFullDay: '', ...over });
const policy: HRMSPolicySettings = {
  ...DEFAULT_SETTINGS,
  // The default shift: 9-5:30. Overtime is 5:30-6:30 PM, then the 6:30-7 break (not overtime), then 7 PM onward with no upper limit that day.
  shift: shift({ shiftName: 'General Shift', startTime: '09:00', endTime: '17:30', otWindows: [{ start: '17:30', end: '18:30' }, { start: '19:00', end: '23:59' }] }),
  // A second shift with its own overtime hours.
  shifts: [shift({ shiftName: 'Late Shift', startTime: '12:00', endTime: '20:00', otWindows: [{ start: '21:30', end: '23:59' }] })],
};

const run = (firstIn: string, lastOut: string, o: { shiftName?: string; otEligible?: boolean; p?: HRMSPolicySettings } = {}) =>
  resolveDay(DATE, { firstIn, lastOut, punchCount: 2 }, { policy: o.p ?? policy, today: TODAY, shiftName: o.shiftName, otEligible: o.otEligible });

describe('overtime = punched time inside the overtime hours', () => {
  test('leaving at the shift end is not overtime', () => {
    assert.equal(run('09:00', '17:30').overtimeMinutes, 0);
    assert.equal(run('09:00', '16:00').overtimeMinutes, 0);
  });

  test('staying until 6:30 PM is one hour of overtime', () => {
    assert.equal(run('09:00', '18:30').overtimeMinutes, 60);
    assert.equal(run('09:00', '18:00').overtimeMinutes, 30);
  });

  test('the 6:30-7:00 break adds nothing: leaving in it is still just the first hour', () => {
    assert.equal(run('09:00', '18:45').overtimeMinutes, 60);
    assert.equal(run('09:00', '19:00').overtimeMinutes, 60);
  });

  test('after the break overtime runs from 7 PM to the punch out, including after 9 PM', () => {
    assert.equal(run('09:00', '19:30').overtimeMinutes, 90);  // 1h before the break + 30m after
    assert.equal(run('09:00', '21:00').overtimeMinutes, 180); // 1h + 2h
    assert.equal(run('09:00', '22:15').overtimeMinutes, 255); // 1h + 3h15m
  });

  test('the second shift has its own overtime hours', () => {
    assert.equal(run('12:00', '20:00', { shiftName: 'Late Shift' }).overtimeMinutes, 0);
    assert.equal(run('12:00', '23:00', { shiftName: 'Late Shift' }).overtimeMinutes, 90);
  });

  test('shift names match ignoring case and spaces; an unknown name falls back to the default shift', () => {
    assert.equal(run('12:00', '23:00', { shiftName: '  late shift ' }).overtimeMinutes, 90);
    assert.equal(run('09:00', '21:00', { shiftName: 'No Such Shift' }).overtimeMinutes, 180);
  });

  test('OT switched off for the employee, or for the company, means no overtime at all', () => {
    assert.equal(run('09:00', '21:00', { otEligible: false }).overtimeMinutes, 0);
    assert.equal(run('09:00', '21:00', { otEligible: true }).overtimeMinutes, 180);
    assert.equal(run('09:00', '21:00', { p: { ...policy, overtime: { ...policy.overtime, enabled: false } } }).overtimeMinutes, 0);
  });

  test('a shift with no overtime hours earns none, and a missing punch out means none', () => {
    const none: HRMSPolicySettings = { ...policy, shift: { ...policy.shift, otWindows: [] } };
    assert.equal(run('09:00', '21:00', { p: none }).overtimeMinutes, 0);
    assert.equal(resolveDay(DATE, { firstIn: '09:00', punchCount: 1 }, { policy, today: TODAY }).overtimeMinutes, 0);
  });

  test('late is judged against the employee shift', () => {
    assert.equal(run('12:30', '20:00', { shiftName: 'Late Shift' }).isLate, false); // 60 min grace
    assert.equal(run('13:30', '20:00', { shiftName: 'Late Shift' }).isLate, true);
    assert.equal(run('12:30', '20:00').isLate, true);
  });
});

describe('shift settings validation', () => {
  test('accepts named shifts with overtime hours and fills missing fields from defaults', () => {
    const out: any = validatePolicyUpdate({ shifts: [{ shiftName: 'Late', startTime: '12:00', endTime: '20:00' }, { shiftName: 'Day', startTime: '09:00', endTime: '17:30', otWindows: [{ start: '19:00', end: '23:59' }] }] });
    assert.equal(out.shifts.length, 2);
    assert.deepEqual(out.shifts[1].otWindows, [{ start: '19:00', end: '23:59' }]);
    assert.deepEqual(out.shifts[0].otWindows, []);
    assert.equal(out.shifts[0].fullDayThresholdMinutes, DEFAULT_SETTINGS.shift.fullDayThresholdMinutes);
  });

  test('rejects duplicate names, backwards windows and bad times', () => {
    assert.throws(() => validatePolicyUpdate({ shifts: [{ shiftName: 'A' }, { shiftName: 'a' }] }));
    assert.throws(() => validatePolicyUpdate({ shifts: [{ shiftName: 'A', otWindows: [{ start: '21:00', end: '19:00' }] }] }));
    assert.throws(() => validatePolicyUpdate({ shifts: [{ shiftName: 'A', otWindows: [{ start: '7pm', end: '9pm' }] }] }));
    assert.throws(() => validatePolicyUpdate({ shifts: [{ shiftName: '' }] }));
  });

  test('the default shift can carry overtime hours too', () => {
    const out: any = validatePolicyUpdate({ shift: { otWindows: [{ start: '19:00', end: '23:59' }] } });
    assert.deepEqual(out.shift.otWindows, [{ start: '19:00', end: '23:59' }]);
  });
});
