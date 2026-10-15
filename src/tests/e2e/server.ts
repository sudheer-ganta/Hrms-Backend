/**
 * Local browser-E2E backend: the real Express app on a THROWAWAY in-memory MongoDB with a few seeded users.
 * It never reads .env and can never reach Atlas (the database is created here and dies with the process).
 *
 *   npm run e2e:server            (API on :5101)
 *   npm run dev -- --mode e2e     (in the frontend repo; talks to :5101)
 *
 * Test-only credentials (localhost only): see SEED below.
 */
import '../helpers.js'; // test env defaults + MONGOMS_SYSTEM_BINARY on this machine
import http from 'http';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'development';
process.env.CORS_ORIGINS = 'http://localhost:5188,http://127.0.0.1:5188';
process.env.PORT = process.env.E2E_PORT || '5101';
process.env.SCHEDULER_ENABLED = 'false';

export const SEED = {
  password: 'E2e-local-pass-1',
  superAdmin: { email: 'sa@e2e.local', name: 'E2E Super Admin' },
  hr: { email: 'hr@e2e.local', name: 'E2E HR (Founder role)' },
  employees: [
    { code: 'E001', name: 'Asha One', email: 'asha@e2e.local', ctc: 30000 },
    { code: 'E002', name: 'Ravi Two', email: 'ravi@e2e.local', ctc: 42000 },
  ],
};

const { MongoMemoryServer } = await import('mongodb-memory-server');
const { default: mongoose } = await import('mongoose');
const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri('hrms_e2e'));

const { createApp } = await import('../../app.js');
const { policyService } = await import('../../modules/settings/policy.service.js');
const { siteService } = await import('../../modules/sites/site.service.js');
const { UserModel } = await import('../../modules/auth/user.model.js');
const { EmployeeModel } = await import('../../modules/employees/employeeMaster.model.js');
await Promise.all([UserModel.init(), EmployeeModel.init()]);
await policyService.init();
await siteService.ensureSites();

const hash = await bcrypt.hash(SEED.password, 8);
await UserModel.create({ email: SEED.superAdmin.email, passwordHash: hash, name: SEED.superAdmin.name, role: 'SUPER_ADMIN', status: 'active' });
await UserModel.create({ email: SEED.hr.email, passwordHash: hash, name: SEED.hr.name, role: 'FOUNDER', status: 'active' });
for (const e of SEED.employees) {
  await EmployeeModel.create({ empCode: e.code, name: e.name, email: e.email, otEligible: true, status: 'active', location: 'office', monthlyCtc: e.ctc, doj: '2025-01-01', updatedAt: new Date().toISOString() });
  await UserModel.create({ email: e.email, passwordHash: hash, name: e.name, role: 'EMPLOYEE', empCode: e.code, status: 'active' });
}

// ---- historical attendance for the Settings-propagation journeys (previous month, same code path as the app) ----
const { punchService } = await import('../../modules/attendance/punch.service.js');
const { addDays, dayNameOf, instantFromIst, istToday } = await import('../../utils/istTime.js');
const prevEnd = addDays(`${istToday().slice(0, 7)}-01`, -1);
const month = prevEnd.slice(0, 7);
const dates = Array.from({ length: Number(prevEnd.slice(8)) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
export const E2E_DATES = {
  month,
  weekday: dates.find((d) => dayNameOf(d) === 'WEDNESDAY')!,
  sunday: dates.find((d) => dayNameOf(d) === 'SUNDAY')!,
  holiday: dates.find((d) => dayNameOf(d) === 'THURSDAY')!,
};
await policyService.updateSettings({ ess: { geofenceMode: 'OFF' } });
await policyService.addHoliday({ date: E2E_DATES.holiday, name: 'E2E Founders Day', type: 'NATIONAL' });
const admin = { id: 'seed', role: 'SUPER_ADMIN' as const, name: 'Seed' };
const punch = async (code: string, date: string, i: string, o: string) => {
  await punchService.recordPunch({ empCode: code, punchType: 'IN' }, admin, instantFromIst(date, `${i}:00`));
  await punchService.recordPunch({ empCode: code, punchType: 'OUT' }, admin, instantFromIst(date, `${o}:00`));
};
await punch('E001', E2E_DATES.weekday, '10:20', '14:30'); // 250 min, late under 09:00 + 60
await punch('E002', E2E_DATES.weekday, '09:30', '16:00'); // 390 min
await punch('E001', E2E_DATES.sunday, '09:00', '17:30'); // worked a weekly off
await punch('E002', E2E_DATES.holiday, '09:00', '17:30'); // worked a paid holiday
console.log(`E2E seed: month ${month}, weekday ${E2E_DATES.weekday}, sunday ${E2E_DATES.sunday}, holiday ${E2E_DATES.holiday}`);

const server = http.createServer(createApp());
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  console.log(`E2E API ready on http://127.0.0.1:${process.env.PORT}/api (throwaway database)`);
});
const stop = async () => { server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
