/**
 * One-time, idempotent migration to the canonical model:
 *   Employee identity → RawPunch → AttendanceDay → Adjustments → Payroll snapshots.
 *
 * SAFETY
 *  - DRY RUN by default: prints exactly what would change and writes nothing.
 *  - To write:  npm run migrate:canonical -- --apply --backup-confirmed
 *    (take a database backup first, e.g. `mongodump --uri "$MONGODB_URI"` or an Atlas snapshot).
 *  - Nothing is deleted. Rows that must leave a live collection (duplicates, ESS rows written into the
 *    vendor staging table, corrupted partial records) are MOVED to `*_archive` collections with a reason.
 *  - Safe to re-run: every step is idempotent.
 *  - Each step PLANS in memory first and then writes in bulk (a remote Atlas round trip per document
 *    would take hours for ~30k rows).
 *  - RESUMABLE: the long attendance-day rebuild is done in ordered batches and a checkpoint is stored in
 *    `migration_state` after every batch. If the run dies, the next run continues from the last good batch
 *    (--restart ignores the checkpoint). The rebuild is an upsert per employee-day, so repeating a batch
 *    can never duplicate data.
 *  - VERIFIES itself: source vs destination counts, duplicates, invalid rows. Exit code 3 if any check fails.
 */
import mongoose from 'mongoose';
import { ENV } from '../config/env.js';
import { normalizeEmpCode, isValidEmpCode } from '../utils/empCode.js';
import { instantFromIst, isValidBusinessDate } from '../utils/istTime.js';
import { createRawPunchHash } from '../utils/hashUtils.js';

const APPLY = process.argv.includes('--apply');
const BACKUP_OK = process.argv.includes('--backup-confirmed');
const log = (...a: unknown[]) => console.log(APPLY ? '[APPLY]' : '[DRY-RUN]', ...a);
const BATCH = 1000;
const RESTART = process.argv.includes('--restart');
const DAY_BATCH = Number(process.env.MIGRATE_DAY_BATCH || 500);
const FAIL_AFTER_BATCHES = Number(process.env.MIGRATE_FAIL_AFTER_BATCHES || 0); // test hook: simulate a crash
const STATE_KEY = 'canonical-attendance-days';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SITES: Record<string, string> = { office: 'office', budigere: 'budigere', bidarahalli: 'bidarahalli' };
const siteAlias = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (SITES[s]) return s;
  if (s === 'colormyles' || s === 'colormyles hq' || s === 'office staff') return 'office';
  for (const k of Object.keys(SITES)) if (s.startsWith(k)) return k;
  return undefined;
};

const report: Record<string, number> = {};
const bump = (k: string, n = 1) => { report[k] = (report[k] || 0) + n; };

interface Plan { deletes: any[]; archives: any[]; updates: Array<{ id: any; set?: any; unset?: any }>; }
const newPlan = (): Plan => ({ deletes: [], archives: [], updates: [] });

async function main() {
  if (APPLY && !BACKUP_OK) {
    console.error('Refusing to write: pass --backup-confirmed to confirm you have a database backup.');
    process.exit(2);
  }
  if (process.env.MIGRATE_MONGODB_URI) {
    await mongoose.connect(process.env.MIGRATE_MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  } else {
    const { connectDatabase } = await import('../config/database.js');
    await connectDatabase();
  }
  const db = mongoose.connection.db!;
  const c = (n: string) => db.collection(n);
  log('Connected to', mongoose.connection.name);
  const initial = {
    punches: await c('attendance_records').countDocuments(),
    inOut: await c('in_out_records').countDocuments(),
  };
  log(`Source counts: raw punches ${initial.punches}, daily rows (in_out) ${initial.inOut}`);

  /** Executes a plan: archive first (nothing is lost), then deletes, then updates. */
  const execute = async (coll: string, plan: Plan) => {
    if (!APPLY) return;
    for (let i = 0; i < plan.archives.length; i += BATCH) {
      await c(`${coll}_archive`).insertMany(plan.archives.slice(i, i + BATCH), { ordered: false }).catch(() => undefined);
    }
    for (let i = 0; i < plan.deletes.length; i += BATCH) {
      await c(coll).deleteMany({ _id: { $in: plan.deletes.slice(i, i + BATCH) } });
    }
    for (let i = 0; i < plan.updates.length; i += BATCH) {
      const ops = plan.updates.slice(i, i + BATCH).map((u) => ({
        updateOne: { filter: { _id: u.id }, update: { ...(u.set ? { $set: u.set } : {}), ...(u.unset ? { $unset: u.unset } : {}) } },
      }));
      await c(coll).bulkWrite(ops, { ordered: false });
    }
  };
  /** Schedules a document to leave the live collection; a copy with the reason is kept in <coll>_archive. */
  const archive = (plan: Plan, coll: string, doc: any, reason: string) => {
    bump(`archived:${coll}:${reason}`);
    const { _id, ...rest } = doc;
    plan.archives.push({ ...rest, _archivedAt: new Date(), _archiveReason: reason, _origId: _id });
    plan.deletes.push(_id);
  };

  // ---------------------------------------------------------------- 1. users
  {
    const plan = newPlan();
    for (const u of await c('users').find({}).toArray()) {
      const code = u.empCode ? normalizeEmpCode(u.empCode) : undefined;
      const set: any = {};
      if (code && code !== u.empCode) set.empCode = code;
      if (u.tokenVersion === undefined) set.tokenVersion = 0;
      if (Object.keys(set).length) { bump('users:normalized'); plan.updates.push({ id: u._id, set }); }
    }
    await execute('users', plan);
    const dup = await c('users').aggregate([{ $match: { empCode: { $ne: null } } }, { $group: { _id: { $toUpper: '$empCode' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
    if (dup.length) log('WARNING: users sharing an employee code (resolve manually):', dup.map((d) => d._id));
  }

  // ------------------------------------------------------------- 2. employees
  const profileSite = new Map<string, string | undefined>();
  {
    const plan = newPlan();
    const seen = new Set<string>();
    for (const e of await c('employees').find({}).toArray()) {
      const code = normalizeEmpCode(e.empCode);
      if (seen.has(code)) { log(`WARNING: duplicate employee ${code}: archiving the later document`); archive(plan, 'employees', e, 'duplicate-empcode'); continue; }
      seen.add(code);
      const set: any = {};
      const unset: any = {};
      if (code !== e.empCode) set.empCode = code;
      const site = siteAlias(e.location);
      if (site && site !== e.location) set.location = site;
      profileSite.set(code, site ?? (typeof e.location === 'string' ? e.location.toLowerCase() : undefined));
      if (!e.doj && e.joiningDate) set.doj = e.joiningDate;
      if (!e.bankAccount && e.bankAccountNumber) set.bankAccount = e.bankAccountNumber;
      if (e.otMultiplier === undefined && typeof e.otRatePerHour === 'number' && e.otRatePerHour > 0 && e.otRatePerHour <= 10) {
        set.otMultiplier = e.otRatePerHour; // the legacy "<= 10 means multiplier" overload becomes an explicit field
        unset.otRatePerHour = '';
      }
      if (e.managerEmpCode && normalizeEmpCode(e.managerEmpCode) !== e.managerEmpCode) set.managerEmpCode = normalizeEmpCode(e.managerEmpCode);
      if (Object.keys(set).length || Object.keys(unset).length) {
        bump('employees:normalized');
        plan.updates.push({ id: e._id, set: Object.keys(set).length ? set : undefined, unset: Object.keys(unset).length ? unset : undefined });
      }
    }
    await execute('employees', plan);
  }

  // --------------------------------------------------------------- 3. policy
  const pol = await c('policies').findOne({ key: 'global_hrms_policy' });
  if (pol) {
    const set: any = {};
    const days = (pol.weeklyOffDays || ['Sunday']).map((d: string) => String(d).toUpperCase());
    if (JSON.stringify(days) !== JSON.stringify(pol.weeklyOffDays)) set.weeklyOffDays = days;
    if (pol.version === undefined) set.version = 1;
    if (!pol.ess) set.ess = { geofenceMode: 'ENFORCE' };
    if ((pol.holidays || []).some((h: any) => h.paid === undefined)) set.holidays = pol.holidays.map((h: any) => ({ ...h, paid: h.paid === undefined ? true : h.paid }));
    if (Object.keys(set).length) { bump('policy:updated'); if (APPLY) await c('policies').updateOne({ _id: pol._id }, { $set: set }); }
  }

  // ------------------------------------------------------ 4. raw punches
  const punchColl = c('attendance_records');
  {
    const plan = newPlan();
    const seenHash = new Set<string>();
    const seenKey = new Set<string>();
    let scanned = 0;
    for await (const p of punchColl.find({}).sort({ punchDateTime: 1, _id: 1 })) {
      scanned++;
      const code = normalizeEmpCode(p.employeeCode);
      if (!isValidEmpCode(code) || !isValidBusinessDate(p.entryDate) || !/^\d{2}:\d{2}:\d{2}$/.test(String(p.entryTime))) { archive(plan, 'attendance_records', p, 'corrupted'); continue; }
      const isEss = p.sourceId === 'web-portal' || p.machineId === 'ESS_GEO_PORTAL';
      const origin = isEss ? 'ESS_WEB' : p.origin || 'DEVICE';
      const sourceId = isEss ? profileSite.get(code) || 'unassigned' : String(p.sourceId).toLowerCase();
      const siteId = isEss ? profileSite.get(code) || undefined : SITES[sourceId] ? sourceId : undefined;
      const machineId = isEss ? `ESS:${p.machineFlag === 'IN' ? 'CHECKED_IN' : 'CHECKED_OUT'}` : String(p.machineId ?? '0').trim();
      const hash = createRawPunchHash({ origin, sourceId, employeeCode: code, entryDate: p.entryDate, entryTime: p.entryTime, machineId });
      const instant = instantFromIst(p.entryDate, p.entryTime);
      const key = `${sourceId}|${code}|${+instant}|${machineId}`;
      if (seenHash.has(hash) || seenKey.has(key)) { archive(plan, 'attendance_records', p, 'duplicate-punch'); continue; }
      seenHash.add(hash);
      seenKey.add(key);
      const changed = p.vendorRecordHash !== hash || p.employeeCode !== code || +new Date(p.punchDateTime) !== +instant || p.origin !== origin || p.sourceId !== sourceId;
      if (changed) {
        bump('punches:canonicalized');
        const set: any = { employeeCode: code, origin, sourceId, vendorRecordHash: hash, punchDateTime: instant, machineId, vendorEmployeeCode: p.vendorEmployeeCode || p.employeeCode };
        if (siteId) set.siteId = siteId;
        if (isEss) set.sourceName = 'ESS Web';
        plan.updates.push({ id: p._id, set });
      }
    }
    bump('punches:scanned', scanned);
    await execute('attendance_records', plan);
  }

  // ------------------------------------------- 5. vendor staging (in_out_records)
  const ioColl = c('in_out_records');
  {
    const plan = newPlan();
    const all = await ioColl.find({}).sort({ _id: 1 }).toArray();
    // real (non-office) rows by employee+date, to decide whether an 'office' override row is a stray copy
    const realByDay = new Set<string>();
    for (const r of all) if (r.sourceId && r.sourceId !== 'office' && r.sourceId !== 'web-portal' && r.employeeCode) realByDay.add(`${normalizeEmpCode(r.employeeCode)}|${r.date}`);
    const seenKey = new Set<string>();
    for (const r of all) {
      const code = r.employeeCode ? normalizeEmpCode(r.employeeCode) : '';
      if (!r.sourceId || !code || !isValidBusinessDate(r.date)) { archive(plan, 'in_out_records', r, 'corrupted-partial-record'); continue; }
      if (r.sourceId === 'web-portal') { archive(plan, 'in_out_records', r, 'ess-row-moved-to-raw-punches'); continue; }
      const sourceId = String(r.sourceId).toLowerCase();
      const key = `${sourceId}_${code}_${r.date}`;
      if (seenKey.has(key)) { archive(plan, 'in_out_records', r, 'duplicate-day'); continue; }
      if (r.manualOverride && sourceId === 'office' && (r.remark === 'REGULARIZED' || r.status === 'L') && realByDay.has(`${code}|${r.date}`)) {
        archive(plan, 'in_out_records', r, 'approval-override-row'); // the effect lives in attendance_adjustments now
        continue;
      }
      seenKey.add(key);
      const set: any = {};
      if (code !== r.employeeCode) set.employeeCode = code;
      if (key !== r.recordKey) set.recordKey = key;
      if (sourceId !== r.sourceId) set.sourceId = sourceId;
      if (Object.keys(set).length || r.manualOverride !== undefined || r.statusLabel !== undefined) {
        bump('staging:normalized');
        plan.updates.push({ id: r._id, set: Object.keys(set).length ? set : undefined, unset: { manualOverride: '', statusLabel: '' } });
      }
    }
    await execute('in_out_records', plan);
  }

  // --------------------------------------------- 6. requests → adjustments
  const adjColl = c('attendance_adjustments');
  {
    const now = new Date();
    const holidays = new Set<string>((pol?.holidays || []).filter((h: any) => h.paid !== false).map((h: any) => h.date));
    const offDays = new Set<string>((pol?.weeklyOffDays || ['Sunday']).map((d: string) => String(d).toUpperCase()));
    const dayName = (d: string) => ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][new Date(`${d}T00:00:00Z`).getUTCDay()];
    const adjOps: any[] = [];
    const plan = newPlan();
    for (const q of await c('requests').find({}).toArray()) {
      const code = normalizeEmpCode(q.empCode);
      const set: any = {};
      if (code !== q.empCode) set.empCode = code;
      if (q.requestType === 'LEAVE') {
        if (q.days === undefined) set.days = holidays.has(q.date) || offDays.has(dayName(q.date)) ? 0 : 1;
        if (q.leaveYear === undefined) set.leaveYear = Number(String(q.date).slice(0, 4));
      }
      if (q.status === 'APPROVED') {
        bump('adjustments:created');
        adjOps.push({
          updateOne: {
            filter: { requestId: q.id, businessDate: q.date },
            update: { $setOnInsert: { employeeCode: code, businessDate: q.date, kind: q.requestType, requestId: q.id, inTime: q.inTime, outTime: q.outTime, leaveType: q.leaveType, paid: true, fraction: 1, status: 'ACTIVE', approvedBy: q.reviewedBy || 'migration', approvedAt: q.reviewedAt ? new Date(q.reviewedAt) : now, createdAt: now, updatedAt: now } },
            upsert: true,
          },
        });
        set.status = 'APPLIED';
        set.appliedAt = q.reviewedAt || now.toISOString();
      }
      if (Object.keys(set).length) { bump('requests:updated'); plan.updates.push({ id: q._id, set }); }
    }
    if (APPLY) for (let i = 0; i < adjOps.length; i += BATCH) await adjColl.bulkWrite(adjOps.slice(i, i + BATCH), { ordered: false });
    await execute('requests', plan);
  }

  // ------------------------------------------------- 7. payroll snapshots
  for (const run of await c('payroll_runs').find({}).toArray()) {
    if (Array.isArray(run.snapshot) && run.snapshot.length && run.currentVersion === undefined) {
      bump('payroll:legacy-snapshot-versioned');
      if (APPLY) {
        const now = new Date();
        await c('payroll_snapshots').updateOne({ month: run.month, version: 1 }, {
          $setOnInsert: { month: run.month, version: 1, snapshot: run.snapshot, employeeCount: run.employeeCount, totalNetPaid: run.totalNetPaid, closedAt: run.closedAt, closedBy: run.closedBy, rulesVersion: 'legacy', policyVersion: 0, policy: null, calcMeta: { source: 'legacy-migration', generatedAt: now.toISOString() }, createdAt: now, updatedAt: now },
        }, { upsert: true });
        await c('payroll_runs').updateOne({ _id: run._id }, { $set: { currentVersion: 1 } });
      }
    }
  }
  for (const a of await c('payrolladjustments').find({}).toArray()) {
    const keys = Object.keys(a.adjustments || {});
    if (keys.some((k) => normalizeEmpCode(k) !== k)) {
      const norm: any = {}; for (const k of keys) norm[normalizeEmpCode(k)] = a.adjustments[k];
      bump('payroll-adjustments:normalized'); if (APPLY) await c('payrolladjustments').updateOne({ _id: a._id }, { $set: { adjustments: norm } });
    }
  }

  // ------------------------------------- 8. attendance_days (derived facts)
  // Reuse the production code path so migrated days are identical to live-computed ones.
  const pairs = new Map<string, { employeeCode: string; businessDate: string }>();
  // Rows without a usable employee code / date (e.g. corrupted partial records that this same run archives in apply
  // mode, but which are still present during a dry run) cannot be an attendance day: skipped and counted.
  const addPair = (rawCode: unknown, date: unknown) => {
    const code = typeof rawCode === 'string' && rawCode.trim() ? normalizeEmpCode(rawCode) : '';
    if (!code || !isValidEmpCode(code) || !isValidBusinessDate(date)) { bump('attendance_days:skipped-invalid-source-row'); return; }
    pairs.set(`${code}|${date}`, { employeeCode: code, businessDate: date as string });
  };
  for await (const p of punchColl.find({}, { projection: { employeeCode: 1, entryDate: 1 } })) addPair(p.employeeCode, p.entryDate);
  for await (const r of ioColl.find({}, { projection: { employeeCode: 1, date: 1 } })) addPair(r.employeeCode, r.date);
  for await (const a of adjColl.find({}, { projection: { employeeCode: 1, businessDate: 1 } })) addPair(a.employeeCode, a.businessDate);
  bump('attendance_days:to-build', pairs.size);

  // Deterministic order => a batch index means the same thing on every run.
  const ordered = Array.from(pairs.values()).sort((x, y) => (x.businessDate === y.businessDate ? x.employeeCode.localeCompare(y.employeeCode) : x.businessDate.localeCompare(y.businessDate)));
  const totalBatches = Math.ceil(ordered.length / DAY_BATCH);
  const signature = `${ordered.length}|${DAY_BATCH}|${ordered[0]?.businessDate ?? ''}|${ordered[ordered.length - 1]?.businessDate ?? ''}`;
  const saved: any = await c('migration_state').findOne({ _id: STATE_KEY as any });
  const resumable = !RESTART && saved && saved.signature === signature;
  log(saved
    ? `Checkpoint found: status ${saved.status}, batch ${saved.nextBatch}/${saved.totalBatches}, ${resumable ? 'will resume' : 'does not match the current data (or --restart): rebuilding from the start'}`
    : 'No checkpoint: first run');

  let skippedBatches = 0, builtPairs = 0;
  if (APPLY) {
    const { attendanceDayService } = await import('../modules/attendance/attendanceDay.service.js');
    const { policyService } = await import('../modules/settings/policy.service.js');
    await policyService.refreshFromDb(); // may create the default policy document: apply mode only
    const { AttendanceDayModel } = await import('../modules/attendance/attendanceDay.model.js');
    await AttendanceDayModel.init();
    const saveState = (patch: Record<string, unknown>) =>
      c('migration_state').updateOne({ _id: STATE_KEY as any }, { $set: { signature, totalBatches, totalPairs: ordered.length, updatedAt: new Date(), ...patch } }, { upsert: true });

    const startBatch = resumable ? (saved.status === 'COMPLETE' ? totalBatches : Number(saved.nextBatch) || 0) : 0;
    skippedBatches = startBatch;
    if (startBatch > 0) log(`Resuming at batch ${startBatch + 1}/${totalBatches}: ${Math.min(startBatch * DAY_BATCH, ordered.length)} employee-days already done are skipped`);
    const t0 = Date.now();
    for (let bi = startBatch; bi < totalBatches; bi++) {
      const slice = ordered.slice(bi * DAY_BATCH, (bi + 1) * DAY_BATCH);
      for (let attempt = 1; ; attempt++) {
        try { await attendanceDayService.recomputeMany(slice); break; }
        catch (err) {
          if (attempt >= 3) { await saveState({ status: 'FAILED', nextBatch: bi, lastError: String((err as Error)?.message || err) }); throw err; }
          log(`  batch ${bi + 1} failed (attempt ${attempt}/3): ${(err as Error)?.message}; retrying`);
          await sleep(1000 * attempt);
        }
      }
      builtPairs += slice.length;
      await saveState({ status: 'RUNNING', nextBatch: bi + 1 });
      const done = (bi + 1 - startBatch);
      const elapsed = (Date.now() - t0) / 1000;
      const eta = Math.round((elapsed / done) * (totalBatches - bi - 1));
      log(`  attendance_days batch ${bi + 1}/${totalBatches}  ${Math.min((bi + 1) * DAY_BATCH, ordered.length)}/${ordered.length} employee-days  (${slice[slice.length - 1].businessDate})  elapsed ${Math.round(elapsed)}s  eta ${eta}s`);
      if (FAIL_AFTER_BATCHES && done >= FAIL_AFTER_BATCHES) throw new Error(`simulated crash after ${done} batch(es) (MIGRATE_FAIL_AFTER_BATCHES)`);
    }
    await saveState({ status: 'COMPLETE', nextBatch: totalBatches, completedAt: new Date() });
  }

  // -------------------------------------------------- 9. verification
  let failed = 0;
  if (APPLY) {
    const check = (name: string, ok: boolean, detail: string) => { if (!ok) failed++; console.log(`[VERIFY] ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
    const now = {
      punches: await c('attendance_records').countDocuments(),
      inOut: await c('in_out_records').countDocuments(),
      days: await c('attendance_days').countDocuments(),
    };
    const archivedPunches = report['archived:attendance_records:duplicate-punch'] || 0;
    const archivedInOut = Object.entries(report).filter(([k]) => k.startsWith('archived:in_out_records:')).reduce((a, [, v]) => a + v, 0);
    check('raw punches: source - archived = destination', now.punches === initial.punches - archivedPunches, `${initial.punches} - ${archivedPunches} = ${initial.punches - archivedPunches}, destination ${now.punches}`);
    check('daily rows: source - archived = destination', now.inOut === initial.inOut - archivedInOut, `${initial.inOut} - ${archivedInOut} = ${initial.inOut - archivedInOut}, destination ${now.inOut}`);

    const expectedKeys = new Set(pairs.keys());
    let orphans = 0, invalid = 0;
    const seen = new Map<string, number>();
    for await (const d of c('attendance_days').find({}, { projection: { employeeCode: 1, businessDate: 1, workMinutes: 1, firstIn: 1, lastOut: 1 } })) {
      const k = `${d.employeeCode}|${d.businessDate}`;
      seen.set(k, (seen.get(k) || 0) + 1);
      if (!expectedKeys.has(k)) orphans++;
      const badTime = (t: unknown) => t != null && t !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
      if (!isValidBusinessDate(d.businessDate) || !isValidEmpCode(d.employeeCode) || d.employeeCode !== normalizeEmpCode(d.employeeCode) || (d.workMinutes ?? 0) < 0 || badTime(d.firstIn) || badTime(d.lastOut)) invalid++;
    }
    const duplicates = Array.from(seen.values()).filter((n) => n > 1).length;
    const missing = Array.from(expectedKeys).filter((k) => !seen.has(k)).length;
    check('employee-days: every source day has exactly one attendance_day', missing === 0 && duplicates === 0, `expected ${pairs.size}, destination ${now.days}, missing ${missing}, duplicates ${duplicates}`);
    check('no orphan attendance_days (rows with no source data)', orphans === 0, `${orphans} orphan row(s)`);
    check('no invalid attendance_days (bad date / code / time / negative minutes)', invalid === 0, `${invalid} invalid row(s)`);
    const errorBatches = (await c('migration_state').findOne({ _id: STATE_KEY as any }) as any)?.status === 'FAILED' ? 1 : 0;
    console.log(`[VERIFY] SUMMARY  migrated this run ${builtPairs} employee-days, skipped (already done, resumed) ${skippedBatches} batch(es), batch errors ${errorBatches}, final attendance_days ${now.days}`);

    const byMonth = await ioColl.aggregate([{ $group: { _id: { m: { $substr: ['$date', 0, 7] }, s: '$status' }, n: { $sum: 1 } } }, { $sort: { '_id.m': 1 } }]).toArray();
    log('legacy vendor statuses per month (compare with /attendance/days summary per month before switching reads):');
    for (const row of byMonth.slice(-18)) log(`  ${row._id.m}  ${String(row._id.s).padEnd(4)} ${row.n}`);
  }

  console.log('\n=== MIGRATION REPORT ===');
  for (const [k, v] of Object.entries(report).sort()) console.log(`${k.padEnd(60)} ${v}`);
  console.log(APPLY ? (failed ? `\nApplied, but ${failed} verification check(s) FAILED. Do not deploy; investigate.` : '\nApplied and verified. Review the *_archive collections, then deploy the new backend.') : '\nDry run only: nothing was written. Re-run with --apply --backup-confirmed.');
  await mongoose.disconnect();
  process.exit(failed ? 3 : 0); // imported services may hold timers; the migration is finished
}

main().catch((e) => { console.error(e); process.exit(1); });
