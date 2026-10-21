process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRoster } from '../modules/attendance/attendance.service.js';
import { attendanceDayService } from '../modules/attendance/attendanceDay.service.js';
import { EmployeeProfile } from '../modules/employees/employeeMaster.types.js';

const emp = (empCode: string, over: Partial<EmployeeProfile> = {}): EmployeeProfile =>
  ({ empCode, name: empCode, otEligible: true, status: 'active', ...over }) as EmployeeProfile;

describe('dashboard roster', () => {
  const people = [
    emp('A'),
    emp('JOINER', { doj: '2026-10-15' }),
    emp('LEAVER', { lastWorkingDay: '2026-10-20' }),
    emp('GONE', { status: 'inactive' }),
    emp('BUDIGERE', { location: 'budigere' }),
  ];
  const codes = (date: string, site?: string) => dashboardRoster(people, date, site).map((p) => p.empCode);

  test('someone who has not joined yet, or has already left, is not counted (so they are never "absent")', () => {
    assert.deepEqual(codes('2026-10-10'), ['A', 'LEAVER', 'BUDIGERE']);
    assert.deepEqual(codes('2026-10-15'), ['A', 'JOINER', 'LEAVER', 'BUDIGERE'], 'the joining day counts');
    assert.deepEqual(codes('2026-10-20'), ['A', 'JOINER', 'LEAVER', 'BUDIGERE'], 'the last working day counts');
    assert.deepEqual(codes('2026-10-21'), ['A', 'JOINER', 'BUDIGERE']);
  });

  test('inactive employees stay out, and the location filter still applies', () => {
    assert.ok(!codes('2026-10-21').includes('GONE'));
    assert.deepEqual(codes('2026-10-21', 'budigere'), ['BUDIGERE']);
  });
});

describe('attendance summary', () => {
  const row = (status: string, workMinutes: number, extra: Record<string, unknown> = {}): any =>
    ({ status, workMinutes, overtimeMinutes: 0, isLate: false, ...extra });

  test('average working hours covers only worked days that have measured hours', () => {
    const s = attendanceDayService.summarize([
      row('PRESENT', 480),
      row('PRESENT', 540),
      row('HALF_DAY', 240),
      row('MISSED_PUNCH', 0),   // one swipe: paid, but there are no hours to average
      row('ABSENT', 120),       // stray punches on an absent day are not a working day
    ]);
    assert.equal(s.avgWorkMinutes, Math.round((480 + 540 + 240) / 3));
    assert.equal(s.presentCount, 3);
    assert.equal(s.halfDayCount, 1);
    assert.equal(s.absentCount, 1);
    assert.equal(s.missedPunchCount, 1);
    assert.equal(s.totalWorkMinutes, 480 + 540 + 240 + 120, 'the total still adds every recorded minute');
  });

  test('no measured day gives 0, not NaN', () => {
    assert.equal(attendanceDayService.summarize([row('MISSED_PUNCH', 0)]).avgWorkMinutes, 0);
    assert.equal(attendanceDayService.summarize([]).avgWorkMinutes, 0);
  });
});
