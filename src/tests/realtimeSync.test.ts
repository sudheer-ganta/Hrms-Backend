import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, mongodAvailable, Harness } from './helpers.js';
import { revisionService } from '../modules/realtime/revision.service.js';

const SKIP = !mongodAvailable() ? 'no local mongod available (set MONGOMS_SYSTEM_BINARY)' : false;

describe('Real-time Data Synchronization & Cross-User Consistency', { skip: SKIP }, () => {
  let h: Harness;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h?.stop();
  });

  test('1. Realtime version endpoint answers with current revision and timestamp', async () => {
    const res = await h.call('GET', '/realtime/version');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.data.revision, 'number');
    assert.equal(typeof res.body.data.lastModified, 'string');
  });

  test('2. Complete flow: User A creates a request, backend persists to MongoDB, revision bumps, User B sees update', async () => {
    // Check initial revision
    const vBefore = (await h.call('GET', '/realtime/version')).body.data.revision;

    // User A (Employee1) submits a request
    const testDate = '2026-11-17'; // Tuesday (working day)
    const createRes = await h.call('POST', '/requests', {
      token: h.tokens.employee1,
      body: {
        date: testDate,
        requestType: 'LEAVE',
        leaveType: 'CASUAL_LEAVE',
        reason: 'Attending family wedding ceremony',
      },
    });

    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const createdReq = createRes.body.data;
    assert.ok(createdReq.id);
    assert.equal(createdReq.empCode, 'E001');

    // Wait 50ms for finish event
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Revision must have incremented
    const vAfter = (await h.call('GET', '/realtime/version')).body.data.revision;
    assert.ok(vAfter > vBefore, `Expected revision to increase from ${vBefore}, got ${vAfter}`);

    // User B (Founder/Admin) queries requests and verifies User A's update is persisted
    const listRes = await h.call('GET', '/requests', { token: h.tokens.founder });
    assert.equal(listRes.status, 200);
    const found = listRes.body.data.find((r: any) => r.id === createdReq.id);
    assert.ok(found, 'User B must see the record created by User A');
    assert.equal(found.status, 'PENDING');
    assert.equal(found.reason, 'Attending family wedding ceremony');

    // User B approves the request
    const approveRes = await h.call('PATCH', `/requests/${createdReq.id}/status`, {
      token: h.tokens.founder,
      body: { status: 'APPROVED', reviewComment: 'Approved by management' },
    });
    assert.equal(approveRes.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Revision must have bumped again
    const vAfterApproval = (await h.call('GET', '/realtime/version')).body.data.revision;
    assert.ok(vAfterApproval > vAfter, `Expected revision to bump after approval, got ${vAfterApproval}`);

    // User A (Employee1) checks requests and sees status updated to APPROVED
    const userAList = await h.call('GET', '/requests', { token: h.tokens.employee1 });
    assert.equal(userAList.status, 200);
    const approvedItem = userAList.body.data.find((r: any) => r.id === createdReq.id);
    assert.equal(approvedItem.status, 'APPLIED');
    assert.equal(approvedItem.reviewComment, 'Approved by management');
  });

  test('3. Read-only endpoints do not bump revision or create phantom writes', async () => {
    const v1 = (await h.call('GET', '/realtime/version')).body.data.revision;
    await h.call('GET', '/employees', { token: h.tokens.founder });
    await h.call('GET', '/attendance/stats', { token: h.tokens.founder });
    await h.call('GET', '/settings', { token: h.tokens.founder });
    const v2 = (await h.call('GET', '/realtime/version')).body.data.revision;
    assert.equal(v1, v2, 'GET queries must not bump data revision');
  });
});
