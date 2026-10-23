process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildRules } from '../modules/settings/rules.js';
import { DEFAULT_SETTINGS } from '../modules/settings/policy.service.js';
import { HRMSPolicySettings } from '../modules/settings/policy.types.js';
import { PAYROLL_RULES } from '../modules/payroll/payroll.config.js';
import { startHarness, mongodAvailable, Harness } from './helpers.js';

const text = (p: HRMSPolicySettings) => buildRules(p).sections.flatMap((s) => s.rules.map((r) => `${r.title} ${r.detail}`)).join('\n');
const find = (p: HRMSPolicySettings, title: string) => buildRules(p).sections.flatMap((s) => s.rules).find((r) => r.title.startsWith(title))!;

describe('rulebook content follows the live settings', () => {
  test('covers every area, with no empty section and no empty sentence', () => {
    const doc = buildRules(DEFAULT_SETTINGS);
    assert.deepEqual(doc.sections.map((s) => s.id), ['attendance', 'shifts', 'offdays', 'overtime', 'leave', 'pay', 'statutory', 'closing', 'punching']);
    for (const s of doc.sections) {
      assert.ok(s.rules.length > 0, s.id);
      for (const r of s.rules) assert.ok(r.title.trim() && r.detail.trim(), `${s.id}/${r.title}`);
    }
    assert.equal(doc.payrollRulesVersion, PAYROLL_RULES.version);
    assert.equal(doc.policyVersion, DEFAULT_SETTINGS.version);
  });

  test('shift numbers come from the settings, in 12-hour time', () => {
    const p: HRMSPolicySettings = { ...DEFAULT_SETTINGS, shift: { ...DEFAULT_SETTINGS.shift, startTime: '08:30', endTime: '17:00', gracePeriodMinutes: 15, fullDayThresholdMinutes: 450, halfDayThresholdMinutes: 210, otWindows: [{ start: '17:00', end: '18:00' }, { start: '19:00', end: '23:59' }] } };
    assert.match(find(p, 'General shift').detail, /8:30 AM to 5:00 PM/);
    assert.match(find(p, 'Late').detail, /after 8:45 AM .*15 min grace/);
    assert.match(find(p, 'Present').detail, /7 h 30 min/);
    assert.match(find(p, 'Half day').detail, /3 h 30 min/);
    assert.match(find(p, 'What counts').detail, /5:00 PM to 6:00 PM and 7:00 PM to 11:59 PM/);
  });

  test('the Sunday rule is written out in plain words with the real number of days', () => {
    assert.match(find(DEFAULT_SETTINGS, `Absent ${PAYROLL_RULES.weeklyOffWorkAfterAbsentDays} days`).detail, /normal working day.*No weekly-off working pay/);
  });

  test('weekly-off work wording follows the recognition mode', () => {
    const auto = { ...DEFAULT_SETTINGS, offDayWork: { weeklyOff: { recognition: 'AUTOMATIC' as const }, paidHoliday: { recognition: 'MANUAL' as const } } };
    assert.match(find(auto, 'Working on a weekly off').detail, /automatically/);
    assert.match(find(DEFAULT_SETTINGS, 'Working on a weekly off').detail, /OT Calculator/);
  });

  test('statutory figures come from the PF settings and payroll rules', () => {
    const p = { ...DEFAULT_SETTINGS, statutory: { pf: { ...DEFAULT_SETTINGS.statutory.pf, employeeRatePct: 10 } } };
    assert.match(find(p, 'Provident Fund').detail, /Employee 10%/);
    assert.match(text(DEFAULT_SETTINGS), /₹21,000/);
    assert.match(find(DEFAULT_SETTINGS, 'Professional tax').detail, /₹200 a month.*₹25,000/);
  });
});

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('GET /settings/rules', { skip: SKIP }, () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.stop(); });

  test('needs a login, and an employee cannot read it', async () => {
    assert.equal((await h.call('GET', '/settings/rules')).status, 401);
    assert.equal((await h.call('GET', '/settings/rules', { token: h.tokens.employee1 })).status, 403);
  });

  test('HR-level users and above get the rulebook, and a settings change shows up in it', async () => {
    const before = (await h.call('GET', '/settings/rules', { token: h.tokens.founder })).body.data;
    assert.equal((await h.call('GET', '/settings/rules', { token: h.tokens.superAdmin })).status, 200);
    assert.ok(before.sections.length >= 8);
    const put = await h.call('PUT', '/settings', { token: h.tokens.superAdmin, body: { shift: { ...DEFAULT_SETTINGS.shift, gracePeriodMinutes: 20 } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const after = (await h.call('GET', '/settings/rules', { token: h.tokens.founder })).body.data;
    const late = after.sections.find((s: any) => s.id === 'attendance').rules.find((r: any) => r.title === 'Late');
    assert.match(late.detail, /20 min grace/);
    assert.ok(after.policyVersion > before.policyVersion);
  });
});
