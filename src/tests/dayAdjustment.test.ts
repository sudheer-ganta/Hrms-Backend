import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, Harness } from './helpers.js';
import { AttendanceDayModel } from '../modules/attendance/attendanceDay.model.js';
import { AttendanceAdjustmentModel } from '../modules/attendance/attendanceAdjustment.model.js';
import { attendanceDayService } from '../modules/attendance/attendanceDay.service.js';
import { resolveDay } from '../modules/attendance/attendanceResolver.js';
import { policyService } from '../modules/settings/policy.service.js';
import { computeEmployeePayroll } from '../modules/payroll/payroll.service.js';

describe('Day Adjustment: Absent to WFH override', () => {
  let h: Harness;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h.stop();
  });

  test('adjusting an absent day to WORK_FROM_HOME makes it 1.0 payable and updates resolver & payroll', async () => {
    const policy = policyService.getSettings();
    const today = '2026-10-08';
    const testDate = '2026-10-03';
    const empCode = 'TEST_ADJ_001';

    // Clean up test data
    await AttendanceDayModel.deleteMany({ employeeCode: empCode });
    await AttendanceAdjustmentModel.deleteMany({ employeeCode: empCode });

    // 1. Without adjustment, Oct 3 (Saturday, past working day, 0 punches) resolves to ABSENT
    const unadjusted = resolveDay(testDate, undefined, { policy, today });
    assert.equal(unadjusted.status, 'ABSENT');

    // 2. Apply WFH adjustment via API / direct model
    const adj = await AttendanceAdjustmentModel.create({
      employeeCode: empCode,
      businessDate: testDate,
      kind: 'WORK_FROM_HOME',
      requestId: `req_test_${Date.now()}`,
      status: 'ACTIVE',
      reason: 'Approved Work From Home',
      approvedBy: 'Admin',
      approvedAt: new Date(),
    });

    // Recompute day
    await attendanceDayService.recompute(empCode, testDate);

    // 3. Resolve day with adjustment
    const { day } = await attendanceDayService.resolveOne(empCode, testDate);
    assert.equal(day.status, 'WORK_FROM_HOME');
    assert.equal(day.statusLabel, 'Work From Home');
    assert.equal(day.source, 'ADJUSTMENT');
    assert.equal(day.adjustmentId, String(adj._id));

    // 4. Test calendar and timesheet retrieval
    const cal = await attendanceDayService.calendar(empCode, '2026-10-01', '2026-10-08');
    const oct3Cal = cal.find((d) => d.businessDate === testDate);
    assert.ok(oct3Cal);
    assert.equal(oct3Cal.status, 'WORK_FROM_HOME');
    assert.equal(oct3Cal.manualOverride, true);

    // 5. Test payroll calculation credits 1.0 day for WFH
    const resolvedMap = await attendanceDayService.resolveMonth([empCode], '2026-10', policy, today);
    const resolvedDays = resolvedMap.get(empCode) || [];
    const payroll = computeEmployeePayroll({
      profile: {
        empCode,
        name: 'Test Employee',
        monthlyCtc: 50000,
        status: 'active',
      } as any,
      month: '2026-10',
      days: resolvedDays,
      policy,
    });

    // Oct 3 is now payable as WFH (1.0 payable day, 0 LOP for Oct 3)
    const oct3PayrollDay = resolvedDays.find((d) => d.businessDate === testDate);
    assert.equal(oct3PayrollDay?.status, 'WORK_FROM_HOME');
    assert.equal(payroll.wfhDays, 1);

    // 6. Test HTTP endpoint POST /attendance/adjust
    const res = await h.call('POST', '/attendance/adjust', {
      token: h.tokens.superAdmin,
      body: {
        employeeCode: empCode,
        businessDate: '2026-10-03',
        kind: 'WORK_FROM_HOME',
        reason: 'Adjusted to WFH via HR portal',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'WORK_FROM_HOME');

    // 7. Test revoking the adjustment returns back to ABSENT
    const revokeRes = await h.call('POST', '/attendance/adjust/revoke', {
      token: h.tokens.superAdmin,
      body: { employeeCode: empCode, businessDate: '2026-10-03', reason: 'Revoked by HR' },
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.body.data.status, 'ABSENT');

    // Clean up
    await AttendanceDayModel.deleteMany({ employeeCode: empCode });
    await AttendanceAdjustmentModel.deleteMany({ employeeCode: empCode });
  });
});
