import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage } from '../modules/payroll/attendanceCoverage.js';
import { backfillRanges } from '../modules/sync/syncScheduler.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { daysInMonth } from '../utils/istTime.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';

const policy = (over: Partial<HRMSPolicySettings> = {}): HRMSPolicySettings => ({ ...DEFAULT_SETTINGS, ...over });
const SEPT = '2026-09';
const SEPT_DAYS = daysInMonth(SEPT);
const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];
const WORKING = SEPT_DAYS.filter((d) => !SUNDAYS.includes(d));

describe('attendance coverage before locking payroll', () => {
  test('a month whose punches never arrived is reported day by day (the "everyone on LOP" case)', () => {
    const c = computeCoverage(SEPT, SEPT_DAYS, new Set(), policy(), '2026-10-15');
    assert.equal(c.workingDays, 26);
    assert.equal(c.daysWithData, 0);
    assert.equal(c.missingDates.length, 26);
  });

  test('fully synced month has nothing missing; weekly offs never count as missing', () => {
    const c = computeCoverage(SEPT, SEPT_DAYS, new Set(WORKING), policy(), '2026-10-15');
    assert.deepEqual(c.missingDates, []);
    assert.equal(c.daysWithData, c.workingDays);
  });

  test('a single gap is named, and paid holidays are excluded from the working days', () => {
    const p = policy({ holidays: [{ id: 'h', date: '2026-09-10', name: 'Fest', type: 'NATIONAL', paid: true }] });
    const have = new Set(WORKING.filter((d) => d !== '2026-09-10' && d !== '2026-09-22'));
    const c = computeCoverage(SEPT, SEPT_DAYS, have, p, '2026-10-15');
    assert.deepEqual(c.missingDates, ['2026-09-22']);
    assert.equal(c.workingDays, 25);
  });

  test('days after today are not expected to have data yet', () => {
    const c = computeCoverage('2026-10', daysInMonth('2026-10'), new Set(['2026-10-01', '2026-10-02']), policy(), '2026-10-02');
    assert.deepEqual(c.missingDates, []);
  });
});

describe('scheduler backfill windows', () => {
  test('mid-month: the month so far', () => {
    assert.deepEqual(backfillRanges('2026-10-15'), [{ fromDate: '2026-10-01', toDate: '2026-10-15' }]);
  });
  test('first week: the whole previous month as well, each window inside one month (vendor limit is 31 days)', () => {
    assert.deepEqual(backfillRanges('2026-10-03'), [
      { fromDate: '2026-09-01', toDate: '2026-09-30' },
      { fromDate: '2026-10-01', toDate: '2026-10-03' },
    ]);
    assert.deepEqual(backfillRanges('2027-01-02')[0], { fromDate: '2026-12-01', toDate: '2026-12-31' });
  });
});
