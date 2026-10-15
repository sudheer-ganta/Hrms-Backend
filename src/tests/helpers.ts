/**
 * Integration-test harness: real Express app + real MongoDB (in-memory mongod). Never touches Atlas.
 * Set MONGOMS_SYSTEM_BINARY (+ MONGOMS_VERSION) to a local mongod if automatic download is unavailable.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-integration-test-secret';
process.env.SCHEDULER_ENABLED = 'false';
for (const s of ['OFFICE', 'BUDIGERE', 'BIDARAHALLI']) {
  process.env[`ETIMESOURCE_${s}_CORPORATE_ID`] = 'test';
  process.env[`ETIMESOURCE_${s}_USERNAME`] = 'test';
  process.env[`ETIMESOURCE_${s}_PASSWORD`] = 'test';
}
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-used';

import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';

const DEFAULT_LOCAL_MONGOD = 'D:\\Hrms\\.mongo-test\\mongodb-win32-x86_64-windows-7.0.14\\bin\\mongod.exe';
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync(DEFAULT_LOCAL_MONGOD)) {
  process.env.MONGOMS_SYSTEM_BINARY = DEFAULT_LOCAL_MONGOD;
  process.env.MONGOMS_VERSION = '7.0.14';
}

export interface Harness {
  base: string;
  tokens: { superAdmin: string; founder: string; employee1: string; employee2: string };
  stop: () => Promise<void>;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
  models: any;
  services: any;
}

export async function startHarness(): Promise<Harness> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  const { default: mongoose } = await import('mongoose');
  await mongoose.connect(mongod.getUri('hrms_test'));

  const { createApp } = await import('../app.js');
  const { policyService } = await import('../modules/settings/policy.service.js');
  const { siteService } = await import('../modules/sites/site.service.js');
  const { UserModel } = await import('../modules/auth/user.model.js');
  const { EmployeeModel } = await import('../modules/employees/employeeMaster.model.js');
  const { authService } = await import('../modules/auth/auth.service.js');
  const { AttendanceModel } = await import('../modules/attendance/attendance.model.js');
  const { AttendanceDayModel } = await import('../modules/attendance/attendanceDay.model.js');
  const { InOutModel } = await import('../modules/attendance/inOut.model.js');
  const { RequestModel } = await import('../modules/requests/requests.model.js');
  const { AttendanceAdjustmentModel } = await import('../modules/attendance/attendanceAdjustment.model.js');
  const { PayrollRunModel, PayrollSnapshotModel } = await import('../modules/payroll/payrollRun.model.js');
  const { etimeofficeClient } = await import('../modules/etimeoffice/etimeoffice.client.js');
  const { syncService } = await import('../modules/sync/sync.service.js');

  await Promise.all([UserModel.init(), EmployeeModel.init(), AttendanceModel.init(), AttendanceDayModel.init(), InOutModel.init(), RequestModel.init(), AttendanceAdjustmentModel.init(), PayrollRunModel.init(), PayrollSnapshotModel.init()]);
  await policyService.init();
  await siteService.ensureSites();

  const hash = await bcrypt.hash('Test-pass-12345', 4);
  const mk = async (email: string, role: string, empCode?: string, name = email) =>
    UserModel.create({ email, passwordHash: hash, name, role, empCode, status: 'active' });
  await mk('root@test.local', 'SUPER_ADMIN', undefined, 'Root Admin');
  await mk('founder@test.local', 'FOUNDER', undefined, 'The Founder');
  for (const [code, name] of [['E001', 'Asha One'], ['E002', 'Ravi Two']] as const) {
    await EmployeeModel.create({ empCode: code, name, otEligible: true, status: 'active', location: 'budigere', updatedAt: new Date().toISOString() });
  }
  await mk('e1@test.local', 'EMPLOYEE', 'E001', 'Asha One');
  await mk('e2@test.local', 'EMPLOYEE', 'E002', 'Ravi Two');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  const call: Harness['call'] = async (method, path, opts = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body };
  };

  const login = async (id: string) => (await call('POST', '/auth/login', { body: { identifier: id, password: 'Test-pass-12345' } })).body.data.token as string;
  const tokens = {
    superAdmin: await login('root@test.local'),
    founder: await login('founder@test.local'),
    employee1: await login('e1@test.local'),
    employee2: await login('e2@test.local'),
  };

  return {
    base, tokens, call,
    models: { UserModel, EmployeeModel, AttendanceModel, AttendanceDayModel, InOutModel, RequestModel, AttendanceAdjustmentModel, PayrollRunModel, PayrollSnapshotModel },
    services: { etimeofficeClient, syncService, policyService, authService },
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

export const mongodAvailable = (): boolean => !!process.env.MONGOMS_SYSTEM_BINARY || fs.existsSync(DEFAULT_LOCAL_MONGOD);

/** Bare mongod + native driver handle (no app), used by the migration test. */
export async function startMongoOnly() {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  const { MongoClient } = await import('mongodb');
  const uri = mongod.getUri('legacy');
  const client = await MongoClient.connect(uri);
  return { uri, db: client.db('legacy'), stop: async () => { await client.close(); await mongod.stop(); } };
}
