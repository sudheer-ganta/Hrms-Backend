import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { addDays, istToday, instantFromIst } from '../utils/istTime.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('HRMS end-to-end (real app, real MongoDB)', { skip: SKIP }, () => {
  let h: Harness;
  const D = addDays(istToday(), -3); // a recent past working day (weekly offs are cleared below)
  const D2 = addDays(istToday(), -4);
  const SEPT = '2026-09';

  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  const t = () => h.tokens;
  const ok = (r: { status: number; body: any }, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));
  const errCode = (r: { body: any }) => r.body?.error?.code;

  // ---------------------------------------------------------------- F: security
  describe('Journey F: security & authorization', () => {
    const adminGets = ['/payroll/all?month=2026-09', '/payroll/runs', '/attendance/raw-swipes', '/attendance/timesheet', '/attendance/stats', '/sync/logs', '/sync/scheduler/status', '/auth/users'];
    const protectedAll = [...adminGets, '/employees', '/employees/E001', '/settings', '/sources', '/requests', '/attendance/days', '/attendance/punch/today', '/payroll/employee/E001', '/auth/me'];

    test('anonymous → 401 on every protected endpoint, with the canonical error body', async () => {
      for (const p of protectedAll) {
        const r = await h.call('GET', p);
        assert.equal(r.status, 401, `${p} should be 401, got ${r.status}`);
        assert.equal(r.body.success, false);
        assert.equal(r.body.error.code, 'UNAUTHENTICATED');
        assert.equal(typeof r.body.error.message, 'string');
      }
      for (const [m, p] of [['POST', '/attendance/punch'], ['POST', '/requests'], ['PUT', '/employees/E001'], ['PUT', '/settings'], ['POST', '/sync/all'], ['POST', '/payroll/runs/2026-09/close'], ['PATCH', '/requests/x/status'], ['POST', '/auth/users']]) {
        assert.equal((await h.call(m, p, { body: {} })).status, 401, `${m} ${p}`);
      }
    });

    test('public endpoints: health is minimal (no connection string), login works', async () => {
      const r = await h.call('GET', '/health');
      ok(r);
      assert.ok(!JSON.stringify(r.body).includes('mongodb://'));
    });

    test('employee → 403 on every admin endpoint', async () => {
      for (const p of adminGets) assert.equal((await h.call('GET', p, { token: t().employee1 })).status, 403, p);
      for (const [m, p] of [['PUT', '/employees/E001'], ['PUT', '/settings'], ['POST', '/settings/holidays'], ['POST', '/sync/all'], ['POST', '/sync/in-out/all'], ['POST', '/payroll/runs/2026-09/close'], ['POST', '/payroll/adjustments/2026-09'], ['PATCH', '/requests/x/status'], ['POST', '/employees/salary-preview'], ['POST', '/attendance/recompute']]) {
        const r = await h.call(m, p, { token: t().employee1, body: {} });
        assert.equal(r.status, 403, `${m} ${p}`);
        assert.equal(errCode(r), 'FORBIDDEN');
      }
    });

    test('founder cannot do Super-Admin-only actions', async () => {
      assert.equal((await h.call('GET', '/auth/users', { token: t().founder })).status, 403);
      assert.equal((await h.call('POST', '/payroll/runs/2026-09/reopen', { token: t().founder, body: { reason: 'nope nope' } })).status, 403);
    });

    test('employee cannot read or write another employee\'s data', async () => {
      assert.equal((await h.call('GET', '/employees/E002', { token: t().employee1 })).status, 403);
      assert.equal((await h.call('GET', '/payroll/employee/E002', { token: t().employee1 })).status, 403);
      assert.equal((await h.call('GET', '/attendance/days?employeeCode=E002', { token: t().employee1 })).status, 403);
      assert.equal((await h.call('GET', '/requests?empCode=E002', { token: t().employee1 })).status, 403);
      assert.equal((await h.call('GET', '/requests/balance/E002', { token: t().employee1 })).status, 403);
      const list = await h.call('GET', '/employees', { token: t().employee1 });
      ok(list);
      assert.deepEqual(list.body.data.map((e: any) => e.empCode), ['E001']);
    });

    test('lowercase / padded employee code in the URL still resolves to the caller\'s own record', async () => {
      const r = await h.call('GET', '/employees/%20e001%20', { token: t().employee1 });
      ok(r);
      assert.equal(r.body.data.empCode, 'E001');
    });

    test('/auth/me returns the CURRENT database user', async () => {
      const r = await h.call('GET', '/auth/me', { token: t().employee1 });
      ok(r);
      assert.equal(r.body.data.status, 'active');
      assert.equal(r.body.data.role, 'EMPLOYEE');
      assert.equal(r.body.data.empCode, 'E001');
      assert.ok(!('passwordHash' in r.body.data));
    });

    test('deactivated user loses access immediately (existing token)', async () => {
      const created = await h.call('POST', '/auth/users', { token: t().superAdmin, body: { email: 'temp@test.local', role: 'FOUNDER', password: 'Temp-pass-98765', name: 'Temp' } });
      ok(created, 201);
      const login = await h.call('POST', '/auth/login', { body: { identifier: 'temp@test.local', password: 'Temp-pass-98765' } });
      const token = login.body.data.token;
      ok(await h.call('GET', '/auth/me', { token }));
      ok(await h.call('POST', `/auth/users/${created.body.data.id}/toggle-status`, { token: t().superAdmin }));
      assert.equal((await h.call('GET', '/auth/me', { token })).status, 401);
      assert.equal((await h.call('POST', '/auth/login', { body: { identifier: 'temp@test.local', password: 'Temp-pass-98765' } })).status, 403);
    });

    test('password change and logout revoke previously issued tokens; weak passwords rejected', async () => {
      assert.equal((await h.call('POST', '/auth/users', { token: t().superAdmin, body: { email: 'weak@test.local', role: 'FOUNDER', password: 'short' } })).status, 400);
      const created = await h.call('POST', '/auth/users', { token: t().superAdmin, body: { email: 'pw@test.local', role: 'FOUNDER', password: 'Orig-pass-11111', name: 'PW' } });
      ok(created, 201);
      const t1 = (await h.call('POST', '/auth/login', { body: { identifier: 'pw@test.local', password: 'Orig-pass-11111' } })).body.data.token;
      const change = await h.call('POST', '/auth/change-password', { token: t1, body: { currentPassword: 'Orig-pass-11111', newPassword: 'New-pass-222222' } });
      ok(change);
      assert.equal((await h.call('GET', '/auth/me', { token: t1 })).status, 401, 'old token revoked');
      const t2 = change.body.data.token;
      ok(await h.call('GET', '/auth/me', { token: t2 }));
      ok(await h.call('POST', '/auth/logout', { token: t2 }));
      assert.equal((await h.call('GET', '/auth/me', { token: t2 })).status, 401);
    });

    test('employee login by employee code (any case) works; brute force is rate limited', async () => {
      ok(await h.call('POST', '/auth/login', { body: { identifier: 'e001', password: 'Test-pass-12345' } }));
      let last = 0;
      for (let i = 0; i < 10; i++) last = (await h.call('POST', '/auth/login', { body: { identifier: 'victim@test.local', password: 'wrong-password-1' } })).status;
      assert.equal(last, 429);
    });

    test('validation: bad month / enum / mass-assignment / regex search never reach the database', async () => {
      const badMonth = await h.call('GET', '/payroll/all?month=2026-13', { token: t().founder });
      assert.equal(badMonth.status, 400);
      assert.equal(errCode(badMonth), 'VALIDATION_ERROR');
      assert.equal((await h.call('GET', '/requests?status=BOGUS', { token: t().superAdmin })).status, 400);
      const mass = await h.call('PUT', '/employees/E001', { token: t().founder, body: { name: 'Hacked', role: 'SUPER_ADMIN', $set: { status: 'x' } } });
      assert.equal(mass.status, 400);
      assert.ok(mass.body.error.details.some((d: any) => d.field === 'role'));
      assert.equal((await h.call('GET', '/attendance/days?search=(%5Ea%2B)%2B%24', { token: t().founder })).status, 200);
      assert.equal((await h.call('POST', '/requests', { token: t().employee1, body: { requestType: 'NOPE', date: D, reason: 'x' } })).status, 400);
      assert.equal((await h.call('GET', '/nonexistent', {})).status, 404);
    });
  });

  // -------------------------------------------------------------- setup policy
  describe('setup', () => {
    test('admin clears weekly offs so any date is a working day; policy version increments', async () => {
      const before = (await h.call('GET', '/settings', { token: t().founder })).body.data.version;
      const r = await h.call('PUT', '/settings', { token: t().founder, body: { weeklyOffDays: [] } });
      ok(r);
      assert.deepEqual(r.body.data.weeklyOffDays, []);
      assert.equal(r.body.data.version, before + 1);
    });
    test('salary preview uses the single backend formula', async () => {
      const r = await h.call('POST', '/employees/salary-preview', { token: t().founder, body: { monthlyCtc: 30000 } });
      ok(r);
      assert.equal(r.body.data.basicSalary, 15000);
      assert.equal(r.body.data.grossSalary, 28000);
      for (const [code, ctc] of [['E001', 30000], ['E002', 24000]] as const) {
        const u = await h.call('PUT', `/employees/${code}`, { token: t().founder, body: { monthlyCtc: ctc } });
        ok(u);
        assert.equal(u.body.data.monthlyCtc, ctc);
        assert.ok(u.body.data.grossSalary > 0);
      }
    });
  });

  // -------------------------------------------------------- Journey A: ESS punch
  describe('Journey A: employee ESS punch → one attendance day → portal, admin, payroll agree', () => {
    test('geofence is a real rule: outside the site → rejected; inside → accepted', async () => {
      ok(await h.call('PUT', '/sources/sites/budigere', { token: t().founder, body: { geo: { lat: 13.0673, lng: 77.742, radiusM: 300 } } }));
      const outside = await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'IN', latitude: 12.0, longitude: 77.0, accuracy: 20 } });
      assert.equal(outside.status, 422);
      assert.equal(errCode(outside), 'BUSINESS_RULE');
      const noLocation = await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'IN' } });
      assert.equal(noLocation.status, 422);
      const empOverride = await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'IN', latitude: 12.0, longitude: 77.0, accuracy: 20, override: true } });
      assert.equal(empOverride.status, 403, 'employees cannot override the geofence');
      assert.equal(await h.models.AttendanceModel.countDocuments({ employeeCode: 'E001', origin: 'ESS_WEB' }), 0);
    });

    test('IN → raw punch + exactly one AttendanceDay (no second "web-portal" row)', async () => {
      const status0 = await h.call('GET', '/attendance/punch/today', { token: t().employee1 });
      ok(status0);
      assert.equal(status0.body.data.nextAction, 'IN');
      const inn = await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'IN', latitude: 13.0674, longitude: 77.7421, accuracy: 15 } });
      ok(inn);
      assert.equal(inn.body.data.action, 'CHECKED_IN');
      assert.equal(inn.body.data.siteId, 'budigere');
      assert.equal(inn.body.data.geofenceResult, 'INSIDE');
      assert.equal(await h.models.AttendanceModel.countDocuments({ employeeCode: 'E001', origin: 'ESS_WEB' }), 1);
      assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E001', businessDate: istToday() }), 1);
      assert.equal(await h.models.AttendanceModel.countDocuments({ sourceId: 'web-portal' }), 0);
    });

    test('duplicate IN / double-tap are rejected with 409', async () => {
      assert.equal((await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'IN', latitude: 13.0674, longitude: 77.7421 } })).status, 409);
      assert.equal((await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'OUT', latitude: 13.0674, longitude: 77.7421 } })).status, 409, 'too soon after the IN');
    });

    test('OUT → AttendanceDay updated; portal, admin grid and payroll show the SAME verdict', async () => {
      // move the IN back so the OUT is not "too soon", then OUT
      const today = istToday();
      await h.models.AttendanceModel.collection.updateOne({ employeeCode: 'E001', origin: 'ESS_WEB' }, { $set: { punchDateTime: new Date(Date.now() - 5 * 60_000) } });
      const out = await h.call('POST', '/attendance/punch', { token: t().employee1, body: { punchType: 'OUT', latitude: 13.0674, longitude: 77.7421 } });
      ok(out);
      assert.equal(out.body.data.action, 'CHECKED_OUT');
      assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E001', businessDate: today }), 1);

      // make the day a deterministic 09:00-17:30 and recompute through the controlled endpoint
      const punches = await h.models.AttendanceModel.find({ employeeCode: 'E001', entryDate: today }).sort({ punchDateTime: 1 }).lean();
      assert.equal(punches.length, 2);
      await h.models.AttendanceModel.collection.updateOne({ _id: punches[0]._id }, { $set: { punchDateTime: instantFromIst(today, '09:00:00'), entryTime: '09:00:00' } });
      await h.models.AttendanceModel.collection.updateOne({ _id: punches[1]._id }, { $set: { punchDateTime: instantFromIst(today, '17:30:00'), entryTime: '17:30:00' } });
      ok(await h.call('POST', '/attendance/recompute', { token: t().founder, body: { fromDate: today, toDate: today, employeeCode: 'E001' } }));

      const portal = (await h.call('GET', `/attendance/days?fromDate=${today}&toDate=${today}`, { token: t().employee1 })).body;
      const admin = (await h.call('GET', `/attendance/days?fromDate=${today}&toDate=${today}&employeeCode=E001`, { token: t().founder })).body;
      assert.equal(portal.data.length, 1);
      assert.equal(portal.data[0].status, 'PRESENT');
      assert.equal(portal.data[0].workMinutes, 510);
      assert.deepEqual(admin.data[0], portal.data[0]);
      assert.equal(portal.summary.totalRecords, 1, 'employee summary covers only the employee\'s own rows');

      const cal = (await h.call('GET', `/attendance/calendar?month=${today.slice(0, 7)}&employeeCode=E001`, { token: t().employee1 })).body.data;
      assert.equal(cal.days.find((d: any) => d.businessDate === today).status, 'PRESENT');

      const pay = (await h.call('GET', `/payroll/employee/E001?month=${today.slice(0, 7)}`, { token: t().employee1 })).body.data;
      assert.ok(pay.presentDays >= 1);
      assert.equal(pay.isProvisional, true);
      const payAll = (await h.call('GET', `/payroll/all?month=${today.slice(0, 7)}`, { token: t().founder })).body.data.find((p: any) => p.empCode === 'E001');
      assert.equal(payAll.presentDays, pay.presentDays);
      assert.equal(payAll.netPayable, pay.netPayable);
    });

    test('GET endpoints never mutate attendance data', async () => {
      const snap = async () => [await h.models.AttendanceDayModel.countDocuments(), await h.models.AttendanceModel.countDocuments(), await h.models.InOutModel.countDocuments(), await h.models.EmployeeModel.countDocuments(),
        JSON.stringify((await h.models.AttendanceDayModel.find({}).sort({ _id: 1 }).lean()).map((d: any) => [d.employeeCode, d.businessDate, d.firstIn, d.lastOut, d.workMinutes, String(d.updatedAt)]))];
      const before = await snap();
      const month = istToday().slice(0, 7);
      for (const p of [`/attendance/days?fromDate=${month}-01&toDate=${istToday()}`, `/attendance/timesheet?fromDate=${month}-01&toDate=${istToday()}`, '/attendance/stats', '/employees', `/payroll/all?month=${month}`, `/attendance/calendar?month=${month}&employeeCode=E001`]) {
        ok(await h.call('GET', p, { token: t().founder }));
      }
      ok(await h.call('GET', '/attendance/punch/today', { token: t().employee1 }));
      assert.deepEqual(await snap(), before);
    });

    test('dashboard numbers come from the roster, never fabricated', async () => {
      const s = (await h.call('GET', '/attendance/stats', { token: t().founder })).body.data;
      assert.equal(s.totalWorkforce, 2); // E001, E002 (+ none invented)
      assert.equal(s.presentCount, 1);
      assert.equal(s.absentCount, 1);
      assert.equal(s.attendanceRate, 50);
      const empty = (await h.call('GET', '/attendance/stats?date=2099-01-01', { token: t().founder })).body.data;
      assert.equal(empty.isFuture, true);
      assert.equal(empty.presentCount, 0);
    });
  });

  // ------------------------------------------------------- Journey B: biometric
  describe('Journey B: biometric vendor sync → raw punches → one attendance day → payroll', () => {
    const rawRows = [
      { Empcode: 'e003 ', Name: 'Gita Three', PunchDate: '02/09/2026 09:02:11', mcid: 1 },
      { Empcode: 'e003 ', Name: 'Gita Three', PunchDate: '02/09/2026 17:35:40', mcid: 1 },
    ];
    test('vendor code is normalized, deduplicated and the employee profile is created by SYNC (not by a GET)', async () => {
      h.services.etimeofficeClient.fetchPunchDataMCID = async () => ({ success: true, records: rawRows });
      assert.equal(await h.models.EmployeeModel.countDocuments({ empCode: 'E003' }), 0);
      const s1 = await h.call('POST', '/sync/budigere', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } });
      ok(s1);
      assert.equal(s1.body.data.inserted, 2);
      const s2 = await h.call('POST', '/sync/budigere', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } });
      ok(s2);
      assert.equal(s2.body.data.inserted, 0, 'idempotent: same vendor punch never creates a second raw punch');
      assert.equal(await h.models.AttendanceModel.countDocuments({ employeeCode: 'E003' }), 2);
      assert.equal(await h.models.EmployeeModel.countDocuments({ empCode: 'E003' }), 1);
      const day = await h.models.AttendanceDayModel.findOne({ employeeCode: 'E003', businessDate: '2026-09-02' }).lean();
      assert.equal(day.firstIn, '09:02');
      assert.equal(day.lastOut, '17:35');
      assert.equal(day.workMinutes, 513);
    });

    test('IN/OUT daily sync from two sources still yields ONE day; vendor mapping joins "A132" to E001', async () => {
      ok(await h.call('PUT', '/employees/E001/source-mappings', { token: t().founder, body: { sourceId: 'bidarahalli', vendorEmployeeCode: 'A132' } }));
      h.services.etimeofficeClient.fetchInOutPunchData = async ({ sourceId }: any) => ({
        success: true,
        records:
          sourceId === 'bidarahalli'
            ? [{ Empcode: 'A132', Name: 'Asha One', DateString: '02/09/2026', INTime: '09:00', OUTTime: '17:30', WorkTime: '08:30', OverTime: '00:00', Status: 'P', Late_In: '00:00' }]
            : [{ Empcode: 'e003', Name: 'Gita Three', DateString: '02/09/2026', INTime: '09:02', OUTTime: '17:35', WorkTime: '08:33', OverTime: '00:03', Status: 'P', Late_In: '00:02' }],
      });
      ok(await h.call('POST', '/sync/in-out/bidarahalli', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } }));
      ok(await h.call('POST', '/sync/in-out/office', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } }));
      ok(await h.call('POST', '/sync/in-out/budigere', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } }));
      assert.equal(await h.models.EmployeeModel.countDocuments({}), 3, 'no duplicate employee for A132');
      assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E001', businessDate: '2026-09-02' }), 1);
      const e3 = await h.models.AttendanceDayModel.findOne({ employeeCode: 'E003', businessDate: '2026-09-02' }).lean();
      assert.equal(await h.models.AttendanceDayModel.countDocuments({ employeeCode: 'E003', businessDate: '2026-09-02' }), 1);
      assert.deepEqual([...e3.sourceIds].sort(), ['budigere', 'office']);
      const days = (await h.call('GET', '/attendance/days?fromDate=2026-09-02&toDate=2026-09-02', { token: t().founder })).body;
      assert.deepEqual(days.data.map((d: any) => [d.employeeCode, d.status]).sort(), [['E001', 'PRESENT'], ['E003', 'PRESENT']]);
      const sheet = (await h.call('GET', '/attendance/timesheet?fromDate=2026-09-02&toDate=2026-09-02', { token: t().founder })).body.data;
      assert.equal(sheet.length, 3, 'timesheet has exactly one row per active employee, not per source');
      assert.equal(new Set(sheet.map((r: any) => r.employeeCode)).size, 3);
      assert.equal(sheet.find((r: any) => r.employeeCode === 'E003').days['2026-09-02'].status, 'PRESENT');
      assert.equal(Object.keys(sheet[0].days).length, 1, 'every date of the requested range is resolved');
    });

    test('vendor sync failures use real HTTP errors, never 200', async () => {
      h.services.etimeofficeClient.fetchPunchDataMCID = async () => { throw new Error('e-Timeoffice remote server error (503)'); };
      const r = await h.call('POST', '/sync/budigere', { token: t().founder, body: { fromDate: '2026-09-03', toDate: '2026-09-03' } });
      assert.equal(r.status, 502);
      assert.equal(errCode(r), 'UPSTREAM_FAILED');
      const all = await h.call('POST', '/sync/all', { token: t().founder, body: { fromDate: '2026-09-03', toDate: '2026-09-03' } });
      assert.equal(all.status, 502);
      assert.equal((await h.call('POST', '/sync/budigere', { token: t().founder, body: { fromDate: '2026-09-05', toDate: '2026-09-01' } })).status, 400);
      assert.equal((await h.call('POST', '/sync/budigere', { token: t().founder, body: { fromDate: '2099-01-01', toDate: '2099-01-01' } })).status, 400);
    });

    test('source health is judged per sync type (a good IN/OUT run cannot hide a failed raw run)', async () => {
      const r = await h.call('GET', '/sources', { token: t().founder });
      ok(r);
      const b = r.body.data.find((s: any) => s.id === 'budigere');
      assert.equal(b.lastRawSync.status, 'FAILED');
      assert.equal(b.lastInOutSync.status, 'SUCCESS');
      assert.equal(b.status, 'failed');
    });
  });

  // ------------------------------------------------- Journey C & D: requests
  describe('Journey C/D: leave & regularization state machine', () => {
    let leaveId = '';
    let punchReqId = '';

    test('employee submits leave → PENDING, balance not yet deducted; name comes from the master', async () => {
      const r = await h.call('POST', '/requests', { token: t().employee1, body: { empName: 'Spoofed', requestType: 'LEAVE', leaveType: 'CASUAL_LEAVE', date: D, reason: 'family event' } });
      ok(r, 201);
      assert.equal(r.body.data.status, 'PENDING');
      assert.equal(r.body.data.empName, 'Asha One');
      assert.equal(r.body.data.days, 1);
      leaveId = r.body.data.id;
      const bal = (await h.call('GET', '/requests/balance/E001', { token: t().employee1 })).body.data;
      assert.equal(bal.balances.CASUAL_LEAVE.used, 0);
      assert.equal(bal.balances.CASUAL_LEAVE.pending, 1);
      assert.equal(bal.balances.CASUAL_LEAVE.available, 12);
    });

    test('overlapping request and over-balance request are refused', async () => {
      assert.equal((await h.call('POST', '/requests', { token: t().employee1, body: { requestType: 'LEAVE', leaveType: 'SICK_LEAVE', date: D, reason: 'dup' } })).status, 409);
      assert.equal((await h.call('POST', '/requests', { token: t().employee1, body: { requestType: 'LEAVE', leaveType: 'COMP_OFF', date: D2, endDate: addDays(D2, 0), halfDay: true, reason: 'ok half' } })).status, 201);
      const tooMany = await h.call('POST', '/requests', { token: t().employee2, body: { requestType: 'LEAVE', leaveType: 'COMP_OFF', date: addDays(istToday(), -20), endDate: addDays(istToday(), -15), reason: 'too long' } });
      assert.equal(tooMany.status, 422);
    });

    test('employees cannot approve; admin approval → APPLIED; the day becomes LEAVE_PAID everywhere', async () => {
      assert.equal((await h.call('PATCH', `/requests/${leaveId}/status`, { token: t().employee1, body: { status: 'APPROVED' } })).status, 403);
      const ap = await h.call('PATCH', `/requests/${leaveId}/status`, { token: t().founder, body: { status: 'APPROVED', reviewComment: 'ok' } });
      ok(ap);
      assert.equal(ap.body.data.status, 'APPLIED');
      assert.equal(ap.body.data.reviewedBy, 'The Founder');
      const adj = await h.models.AttendanceAdjustmentModel.find({ requestId: leaveId }).lean();
      assert.equal(adj.length, 1);
      assert.equal(adj[0].status, 'ACTIVE');
      const day = (await h.call('GET', `/attendance/days?fromDate=${D}&toDate=${D}`, { token: t().employee1 })).body.data[0];
      assert.equal(day.status, 'LEAVE_PAID');
      assert.equal(day.manualOverride, true);
      assert.equal(day.requestId, leaveId);
      const cal = (await h.call('GET', `/attendance/calendar?month=${D.slice(0, 7)}`, { token: t().employee1 })).body.data;
      assert.equal(cal.days.find((x: any) => x.businessDate === D).status, 'LEAVE_PAID', 'portal never shows paid leave as Absent');
      const pay = (await h.call('GET', `/payroll/employee/E001?month=${D.slice(0, 7)}`, { token: t().employee1 })).body.data;
      assert.ok(pay.leaveDays >= 1);
      const bal = (await h.call('GET', '/requests/balance/E001', { token: t().employee1 })).body.data;
      assert.equal(bal.balances.CASUAL_LEAVE.used, 1);
      assert.equal(bal.balances.CASUAL_LEAVE.available, 11);
    });

    test('an approved request cannot be silently re-approved or rejected; revoke is the explicit reversal', async () => {
      const again = await h.call('PATCH', `/requests/${leaveId}/status`, { token: t().founder, body: { status: 'APPROVED' } });
      assert.equal(again.status, 409);
      const rej = await h.call('PATCH', `/requests/${leaveId}/status`, { token: t().founder, body: { status: 'REJECTED' } });
      assert.equal(rej.status, 409);
      assert.equal(errCode(rej), 'CONFLICT');
      assert.equal((await h.call('POST', `/requests/${leaveId}/revoke`, { token: t().founder, body: { reason: 'x' } })).status, 400, 'reason required');
      const rv = await h.call('POST', `/requests/${leaveId}/revoke`, { token: t().founder, body: { reason: 'employee came to work' } });
      ok(rv);
      assert.equal(rv.body.data.status, 'REVOKED');
      const dayAfter = (await h.call('GET', `/attendance/days?fromDate=${D}&toDate=${D}`, { token: t().employee1 })).body.data;
      assert.equal(dayAfter.length, 0, 'no attendance record remains; the day resolves to ABSENT in the calendar');
      const cal = (await h.call('GET', `/attendance/calendar?month=${D.slice(0, 7)}`, { token: t().employee1 })).body.data;
      assert.equal(cal.days.find((x: any) => x.businessDate === D).status, 'ABSENT');
      const bal = (await h.call('GET', '/requests/balance/E001', { token: t().employee1 })).body.data;
      assert.equal(bal.balances.CASUAL_LEAVE.used, 0, 'balance restored');
    });

    test('reject path: PENDING → REJECTED has no attendance effect and cannot be approved later', async () => {
      const r = await h.call('POST', '/requests', { token: t().employee2, body: { requestType: 'LEAVE', leaveType: 'SICK_LEAVE', date: D, reason: 'sick' } });
      ok(r, 201);
      const rej = await h.call('PATCH', `/requests/${r.body.data.id}/status`, { token: t().founder, body: { status: 'REJECTED', reviewComment: 'busy period' } });
      ok(rej);
      assert.equal(rej.body.data.status, 'REJECTED');
      assert.equal((await h.call('PATCH', `/requests/${r.body.data.id}/status`, { token: t().founder, body: { status: 'APPROVED' } })).status, 409);
      assert.equal(await h.models.AttendanceAdjustmentModel.countDocuments({ requestId: r.body.data.id }), 0);
    });

    test('employee can cancel only their own pending request', async () => {
      const r = await h.call('POST', '/requests', { token: t().employee2, body: { requestType: 'WORK_FROM_HOME', date: D2, reason: 'wfh' } });
      ok(r, 201);
      assert.equal((await h.call('POST', `/requests/${r.body.data.id}/cancel`, { token: t().employee1 })).status, 403);
      const c = await h.call('POST', `/requests/${r.body.data.id}/cancel`, { token: t().employee2 });
      ok(c);
      assert.equal(c.body.data.status, 'CANCELLED');
    });

    test('Journey D: missed punch → PENDING → approved → adjustment → PRESENT with approved times → payroll', async () => {
      const r = await h.call('POST', '/requests', { token: t().employee2, body: { requestType: 'MISSED_PUNCH', date: D2, inTime: '09:00', outTime: '18:00', reason: 'forgot to swipe' } });
      ok(r, 201);
      punchReqId = r.body.data.id;
      assert.equal(r.body.data.status, 'PENDING');
      assert.equal((await h.call('POST', '/requests', { token: t().employee2, body: { requestType: 'MISSED_PUNCH', date: addDays(istToday(), 5), inTime: '09:00', reason: 'future' } })).status, 400);
      ok(await h.call('PATCH', `/requests/${punchReqId}/status`, { token: t().superAdmin, body: { status: 'APPROVED' } }));
      const day = (await h.call('GET', `/attendance/days?fromDate=${D2}&toDate=${D2}`, { token: t().employee2 })).body.data[0];
      assert.equal(day.status, 'PRESENT');
      assert.equal(day.firstIn, '09:00');
      assert.equal(day.lastOut, '18:00');
      assert.equal(day.workMinutes, 540);
      assert.deepEqual(day.origins, ['REGULARIZATION']);
      const pay = (await h.call('GET', `/payroll/employee/E002?month=${D2.slice(0, 7)}`, { token: t().employee2 })).body.data;
      assert.ok(pay.presentDays >= 1);
    });

    test('a vendor re-sync cannot overwrite an approved adjustment (facts change, verdict stays)', async () => {
      // vendor says absent for D2 for E002 at budigere
      h.services.etimeofficeClient.fetchInOutPunchData = async () => ({ success: true, records: [{ Empcode: 'e002', Name: 'Ravi Two', DateString: D2.split('-').reverse().join('/'), INTime: '--:--', OUTTime: '--:--', WorkTime: '00:00', Status: 'A' }] });
      ok(await h.call('POST', '/sync/in-out/budigere', { token: t().founder, body: { fromDate: D2, toDate: D2 } }));
      const day = (await h.call('GET', `/attendance/days?fromDate=${D2}&toDate=${D2}&employeeCode=E002`, { token: t().founder })).body.data[0];
      assert.equal(day.status, 'PRESENT');
      assert.equal(day.vendorStatus, 'A');
    });
  });

  // ------------------------------------------------------- Journey E: payroll
  describe('Journey E: payroll → preview → adjustments → close → immutable snapshot → payslip', () => {
    let sept: any[] = [];

    test('open month is provisional and the payslip foots to net pay for every employee', async () => {
      const r = await h.call('GET', `/payroll/all?month=${SEPT}`, { token: t().founder });
      ok(r);
      sept = r.body.data;
      assert.ok(sept.length >= 3);
      for (const p of sept) {
        assert.equal(p.payrollStatus, 'LIVE');
        assert.equal(p.isProvisional, true);
        const sum = (ls: any[]) => ls.reduce((a, l) => a + l.amount, 0);
        assert.ok(Math.abs(sum(p.payslip.earnings) - sum(p.payslip.deductions) - p.netPayable) < 0.011, `${p.empCode} payslip foots`);
        assert.equal(p.payslip.netPay, p.netPayable);
      }
    });

    test('OT preview prices unsaved edits without persisting; saving requires a valid payload', async () => {
      const prev = await h.call('POST', `/payroll/preview/${SEPT}`, { token: t().founder, body: { adjustments: { E001: { otHours: 10, multiplier: 2 } } } });
      ok(prev);
      assert.ok(prev.body.data.find((p: any) => p.empCode === 'E001').otEarnings > 0);
      assert.deepEqual((await h.call('GET', `/payroll/adjustments/${SEPT}`, { token: t().founder })).body.data, {});
      assert.equal((await h.call('POST', `/payroll/adjustments/${SEPT}`, { token: t().founder, body: { adjustments: { E001: { otHours: -4 } } } })).status, 400);
      assert.equal((await h.call('POST', `/payroll/adjustments/${SEPT}`, { token: t().founder, body: { adjustments: { 'bad code!': { otHours: 1 } } } })).status, 400);
      ok(await h.call('POST', `/payroll/adjustments/${SEPT}`, { token: t().founder, body: { reason: 'Worked the off day (test)', adjustments: { e001: { otHours: 2, weeklyOffWorkDays: 1 } } } }));
      const saved = (await h.call('GET', `/payroll/adjustments/${SEPT}`, { token: t().founder })).body.data;
      assert.deepEqual(Object.keys(saved), ['E001'], 'adjustment keys are normalized');
      const hist = (await h.call('GET', `/payroll/adjustments/${SEPT}/history`, { token: t().founder })).body.data;
      assert.equal(hist.length, 1);
    });

    test('cannot close the current/unfinished month, nor a malformed month', async () => {
      const cur = istToday().slice(0, 7);
      const r = await h.call('POST', `/payroll/runs/${cur}/close`, { token: t().founder });
      assert.equal(r.status, 422);
      assert.equal((await h.call('POST', '/payroll/runs/2026-99/close', { token: t().founder })).status, 400);
    });

    test('a month with working days that have no attendance anywhere is refused unless explicitly acknowledged', async () => {
      const cov = await h.call('GET', `/payroll/runs/${SEPT}/coverage`, { token: t().founder });
      ok(cov);
      assert.ok(cov.body.data.missingDates.length > 0, 'the seeded month only has a few punched days');
      assert.ok(cov.body.data.daysWithData < cov.body.data.workingDays);
      const refused = await h.call('POST', `/payroll/runs/${SEPT}/close`, { token: t().founder });
      assert.equal(refused.status, 422);
      assert.match(refused.body.error.message, /Attendance is missing/);
      assert.equal((await h.call('GET', `/payroll/runs/${SEPT}`, { token: t().founder })).body.data.status, 'OPEN', 'nothing was frozen');
    });

    test('close freezes an immutable versioned snapshot with policy + rules version', async () => {
      const before = (await h.call('GET', `/payroll/all?month=${SEPT}`, { token: t().founder })).body.data;
      const r = await h.call('POST', `/payroll/runs/${SEPT}/close`, { token: t().founder, body: { acknowledgeMissingAttendance: true } });
      ok(r);
      assert.equal(r.body.data.status, 'CLOSED');
      assert.equal(r.body.data.currentVersion, 1);
      const snap = await h.models.PayrollSnapshotModel.findOne({ month: SEPT, version: 1 }).lean();
      assert.ok(snap.rulesVersion);
      assert.ok(snap.policyVersion >= 1);
      assert.equal(snap.employeeCount, before.length);
      assert.equal((await h.call('POST', `/payroll/runs/${SEPT}/close`, { token: t().founder })).status, 409, 'already closed');
      const closed = (await h.call('GET', `/payroll/all?month=${SEPT}`, { token: t().founder })).body.data;
      assert.ok(closed.every((p: any) => p.payrollStatus === 'CLOSED' && p.isProvisional === false && p.snapshotVersion === 1));
      assert.deepEqual(closed.map((p: any) => [p.empCode, p.netPayable]), before.map((p: any) => [p.empCode, p.netPayable]));
    });

    test('closed month is really locked: adjustments, requests, holidays, profile/policy edits cannot change it', async () => {
      const lockedNet = (await h.call('GET', `/payroll/employee/E001?month=${SEPT}`, { token: t().employee1 })).body.data.netPayable;
      assert.equal((await h.call('POST', `/payroll/adjustments/${SEPT}`, { token: t().founder, body: { adjustments: { E001: { otHours: 50 } } } })).status, 422);
      assert.equal((await h.call('DELETE', `/payroll/adjustments/${SEPT}`, { token: t().founder })).status, 422);
      assert.equal((await h.call('POST', '/requests', { token: t().employee1, body: { requestType: 'LEAVE', leaveType: 'CASUAL_LEAVE', date: '2026-09-10', reason: 'late' } })).status, 422);
      assert.equal((await h.call('POST', '/settings/holidays', { token: t().founder, body: { date: '2026-09-15', name: 'Late holiday', type: 'FESTIVAL' } })).status, 422);
      assert.equal((await h.call('POST', '/attendance/recompute', { token: t().founder, body: { fromDate: '2026-09-01', toDate: '2026-09-05' } })).status, 422);

      // vendor correction for a closed date is skipped and reported, not applied
      const dayBefore = await h.models.AttendanceDayModel.findOne({ employeeCode: 'E001', businessDate: '2026-09-02' }).lean();
      h.services.etimeofficeClient.fetchInOutPunchData = async () => ({ success: true, records: [{ Empcode: 'A132', Name: 'Asha One', DateString: '02/09/2026', INTime: '10:00', OUTTime: '11:00', WorkTime: '01:00', Status: 'A' }] });
      const sync = await h.call('POST', '/sync/in-out/bidarahalli', { token: t().founder, body: { fromDate: '2026-09-02', toDate: '2026-09-02' } });
      ok(sync);
      assert.match(sync.body.data.note, /closed/);
      const dayAfter = await h.models.AttendanceDayModel.findOne({ employeeCode: 'E001', businessDate: '2026-09-02' }).lean();
      assert.equal(dayAfter.workMinutes, dayBefore.workMinutes);

      // salary / policy edits change OPEN months only; the closed snapshot is untouched
      ok(await h.call('PUT', '/employees/E001', { token: t().founder, body: { monthlyCtc: 90000 } }));
      ok(await h.call('PUT', '/settings', { token: t().founder, body: { shift: { fullDayThresholdMinutes: 100, halfDayThresholdMinutes: 50 } } }));
      const after = (await h.call('GET', `/payroll/employee/E001?month=${SEPT}`, { token: t().employee1 })).body.data;
      assert.equal(after.netPayable, lockedNet);
      assert.equal(after.monthlyCtc, 30000);
      ok(await h.call('PUT', '/settings', { token: t().founder, body: { shift: { halfDayThresholdMinutes: 180, fullDayThresholdMinutes: 360 } } }));
    });

    test('payslip email only for closed months; employee sees the frozen payslip', async () => {
      const mail = await h.call('POST', '/payroll/send-payslip', { token: t().founder, body: { empCode: 'E001', month: SEPT, recipientEmail: 'asha@example.com' } });
      ok(mail);
      assert.ok(!mail.body.data.previewHtml.includes('<script'));
      const open = await h.call('POST', '/payroll/send-payslip', { token: t().founder, body: { empCode: 'E001', month: istToday().slice(0, 7), recipientEmail: 'asha@example.com' } });
      assert.equal(open.status, 422);
      const mine = (await h.call('GET', `/payroll/employee/E001?month=${SEPT}`, { token: t().employee1 })).body.data;
      assert.equal(mine.payrollStatus, 'CLOSED');
    });

    test('reopen: Super Admin only, reason required; re-close creates version 2 and keeps version 1', async () => {
      assert.equal((await h.call('POST', `/payroll/runs/${SEPT}/reopen`, { token: t().superAdmin, body: {} })).status, 400);
      const re = await h.call('POST', `/payroll/runs/${SEPT}/reopen`, { token: t().superAdmin, body: { reason: 'attendance correction approved by HR' } });
      ok(re);
      assert.equal(re.body.data.status, 'REOPENED');
      const live = (await h.call('GET', `/payroll/employee/E001?month=${SEPT}`, { token: t().founder })).body.data;
      assert.equal(live.payrollStatus, 'LIVE');
      ok(await h.call('POST', `/payroll/adjustments/${SEPT}`, { token: t().founder, body: { reason: 'Reopened adjustment (test)', adjustments: { E001: { otHours: 1 } } } }));
      const close2 = await h.call('POST', `/payroll/runs/${SEPT}/close`, { token: t().founder, body: { acknowledgeMissingAttendance: true } });
      ok(close2);
      assert.equal(close2.body.data.currentVersion, 2);
      const versions = (await h.call('GET', `/payroll/runs/${SEPT}/versions`, { token: t().founder })).body.data;
      assert.deepEqual(versions.map((v: any) => v.version), [2, 1]);
      const v1 = (await h.call('GET', `/payroll/runs/${SEPT}/versions/1`, { token: t().founder })).body.data;
      assert.equal(v1.snapshot.find((p: any) => p.empCode === 'E001').monthlyCtc, 30000, 'history preserved, not overwritten');
      assert.equal(close2.body.data.history.length, 3);
    });
  });
});
