import { getSourceById, getAllSources } from '../../config/env.js';
import { etimeofficeClient } from '../etimeoffice/etimeoffice.client.js';
import { parseVendorPunchDate, convertDateStringToISO, parseWorkTimeToMinutes } from '../../utils/dateUtils.js';
import { createRawPunchHash } from '../../utils/hashUtils.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { InOutModel } from '../attendance/inOut.model.js';
import { attendanceDayService, DayKey } from '../attendance/attendanceDay.service.js';
import { SyncLogModel } from './sync.model.js';
import { SyncSummaryResult, SyncType } from './sync.types.js';
import { identityService } from '../employees/identity.service.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { payrollRunService } from '../payroll/payrollRun.service.js';
import { siteService } from '../sites/site.service.js';
import { ApiError } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { isValidEmpCode, normalizeEmpCode } from '../../utils/empCode.js';
import { istToday, monthOf } from '../../utils/istTime.js';
import { dateRange } from '../../utils/validate.js';

export interface SyncOptions {
  fromDate?: string;
  toDate?: string;
  empCode?: string;
  triggeredBy?: 'MANUAL' | 'SCHEDULED';
}

const MAX_RAW_RANGE_DAYS = 31;
const MAX_INOUT_RANGE_DAYS = 62;

export class SyncService {
  /** One sync of a given type per source at a time (manual + scheduler cannot overlap). */
  private running = new Set<string>();

  private validate(options: SyncOptions, maxDays: number) {
    const { from, to } = dateRange(options.fromDate, options.toDate, maxDays);
    const today = istToday();
    const f = from ?? to ?? today;
    const t = to ?? from ?? today;
    if (t > today) throw ApiError.validation('toDate cannot be in the future.', [{ field: 'toDate', issue: 'In the future' }]);
    let empCode = 'ALL';
    if (options.empCode && options.empCode.toUpperCase() !== 'ALL') {
      if (!isValidEmpCode(options.empCode)) throw ApiError.validation('Invalid employee code.', [{ field: 'empCode', issue: 'Invalid' }]);
      empCode = normalizeEmpCode(options.empCode);
    }
    return { fromDate: f, toDate: t, empCode };
  }

  private async startLog(sourceId: string, sourceName: string, type: SyncType, fromDate: string, toDate: string, triggeredBy: string) {
    return SyncLogModel.create({
      sourceId, sourceName, startedAt: new Date(), status: 'RUNNING', recordsFetched: 0, recordsInserted: 0, recordsSkipped: 0,
      requestFromDate: fromDate, requestToDate: toDate, triggeredBy, syncType: type,
    });
  }

  /** Runs `work` for one source with the overlap guard and a durable sync log. */
  private async run(sourceId: string, type: SyncType, options: SyncOptions, maxDays: number,
    work: (ctx: { source: NonNullable<ReturnType<typeof getSourceById>>; fromDate: string; toDate: string; empCode: string }) => Promise<{ fetched: number; inserted: number; skipped: number; partial: boolean; note?: string }>
  ): Promise<SyncSummaryResult> {
    requireDb();
    const source = getSourceById(sourceId);
    if (!source) throw ApiError.validation(`Invalid source "${sourceId}".`, [{ field: 'sourceId', issue: 'Unknown source' }]);
    if (!source.enabled) throw ApiError.rule(`Source ${source.displayName} is disabled.`);
    const { fromDate, toDate, empCode } = this.validate(options, maxDays);

    const lockKey = `${source.id}:${type}`;
    if (this.running.has(lockKey)) throw ApiError.conflict(`A ${type} sync for ${source.displayName} is already running.`);
    this.running.add(lockKey);

    const started = Date.now();
    const log = await this.startLog(source.id, source.displayName, type, fromDate, toDate, options.triggeredBy || 'MANUAL');
    try {
      const out = await work({ source, fromDate, toDate, empCode });
      log.completedAt = new Date();
      log.status = out.partial ? 'PARTIAL' : 'SUCCESS';
      log.recordsFetched = out.fetched;
      log.recordsInserted = out.inserted;
      log.recordsSkipped = out.skipped;
      if (out.note) log.errorMessage = out.note;
      await log.save();
      return {
        success: true, sourceId: source.id, source: source.displayName, syncType: type, fetched: out.fetched, inserted: out.inserted,
        duplicates: out.skipped, status: log.status, logId: String(log._id), durationMs: Date.now() - started, note: out.note,
      };
    } catch (err: any) {
      log.completedAt = new Date();
      log.status = 'FAILED';
      log.errorMessage = String(err?.message || 'Sync failed').slice(0, 500);
      await log.save().catch(() => undefined);
      return {
        success: false, sourceId: source.id, source: source.displayName, syncType: type, fetched: 0, inserted: 0, duplicates: 0,
        status: 'FAILED', logId: String(log._id), durationMs: Date.now() - started, error: log.errorMessage,
      };
    } finally {
      this.running.delete(lockKey);
    }
  }

  // ------------------------------------------------------------- API 2 (raw)

  public syncRaw(sourceId: string, options: SyncOptions = {}): Promise<SyncSummaryResult> {
    return this.run(sourceId, 'RAW', options, MAX_RAW_RANGE_DAYS, async ({ source, fromDate, toDate, empCode }) => {
      const result = await etimeofficeClient.fetchPunchDataMCID({ sourceId: source.id, fromDate, toDate, empCode });
      const rows = result.records || [];
      const parsed: any[] = [];
      let parseErrors = 0;
      for (const rec of rows) {
        try {
          if (!rec.PunchDate) continue;
          const p = parseVendorPunchDate(rec.PunchDate);
          const vendorCode = normalizeEmpCode(rec.Empcode || 'UNKNOWN');
          const code = await identityService.canonicalCode(source.id, vendorCode);
          const machineId = rec.mcid !== undefined && rec.mcid !== null ? String(rec.mcid).trim() : '0';
          parsed.push({
            sourceId: source.id, sourceName: source.displayName, siteId: siteService.siteIdForSource(source.id),
            employeeCode: code, vendorEmployeeCode: vendorCode, employeeName: String(rec.Name || '').trim() || `Employee ${code}`,
            punchDateTime: p.punchDateTime, entryDate: p.entryDate, entryTime: p.entryTime, machineId,
            machineFlag: rec.M_Flag ? String(rec.M_Flag).trim() : null, origin: 'DEVICE', syncedAt: new Date(),
            vendorRecordHash: createRawPunchHash({ origin: 'DEVICE', sourceId: source.id, employeeCode: code, entryDate: p.entryDate, entryTime: p.entryTime, machineId }),
          });
        } catch {
          parseErrors++;
        }
      }

      const closed = await payrollRunService.closedMonthsAmong(parsed.map((d) => d.entryDate));
      const writable = parsed.filter((d) => !closed.has(monthOf(d.entryDate)));
      const skippedClosed = parsed.length - writable.length;

      let inserted = 0;
      if (writable.length) {
        try {
          const res = await AttendanceModel.bulkWrite(
            writable.map((doc) => ({ updateOne: { filter: { vendorRecordHash: doc.vendorRecordHash }, update: { $setOnInsert: doc }, upsert: true } })),
            { ordered: false }
          );
          inserted = res.upsertedCount || 0;
        } catch (e: any) {
          // E11000 on the compound (source, employee, instant, machine) index = same punch seen under another hash: a duplicate, not a failure.
          const writeErrors: any[] = e?.writeErrors || e?.result?.getWriteErrors?.() || [];
          if (!writeErrors.length || writeErrors.some((w) => (w.code ?? w.err?.code) !== 11000)) throw e;
          inserted = e?.result?.upsertedCount ?? e?.result?.nUpserted ?? 0;
        }
        await employeeMasterService.ensureProfiles(writable.map((d) => ({ empCode: d.employeeCode, name: d.employeeName, siteId: d.siteId })));
        for (const d of writable) await identityService.ensureMapping(source.id, d.vendorEmployeeCode, d.employeeCode);
        const keys: DayKey[] = writable.map((d) => ({ employeeCode: d.employeeCode, businessDate: d.entryDate }));
        await attendanceDayService.recomputeMany(keys);
      }
      const notes = [skippedClosed ? `${skippedClosed} punch(es) skipped: payroll month closed` : '', parseErrors ? `${parseErrors} unparseable record(s)` : ''].filter(Boolean);
      return { fetched: rows.length, inserted, skipped: writable.length - inserted, partial: notes.length > 0, note: notes.join('; ') || undefined };
    });
  }

  // ----------------------------------------------------- API 3 (daily in/out)

  public syncInOut(sourceId: string, options: SyncOptions = {}): Promise<SyncSummaryResult> {
    return this.run(sourceId, 'INOUT', options, MAX_INOUT_RANGE_DAYS, async ({ source, fromDate, toDate, empCode }) => {
      const result = await etimeofficeClient.fetchInOutPunchData({ sourceId: source.id, fromDate, toDate, empCode });
      const rows = result.records || [];
      const docs: any[] = [];
      let parseErrors = 0;
      for (const rec of rows) {
        const date = convertDateStringToISO(rec.DateString || '');
        const vendorCode = normalizeEmpCode(rec.Empcode || '');
        if (!date || !vendorCode) { parseErrors++; continue; }
        const code = await identityService.canonicalCode(source.id, vendorCode);
        const inTime = rec.INTime || '--:--';
        const outTime = rec.OUTTime || '--:--';
        const workTime = rec.WorkTime || '00:00';
        docs.push({
          sourceId: source.id, sourceName: source.displayName, employeeCode: code, vendorEmployeeCode: vendorCode,
          employeeName: String(rec.Name || '').trim() || `Employee ${code}`, date, inTime, outTime, workTime,
          workMinutes: parseWorkTimeToMinutes(workTime), overTime: rec.OverTime || '00:00', breakTime: rec.BreakTime || '00:00',
          lateIn: rec.Late_In || '00:00', earlyOut: rec.Erl_Out || '00:00',
          status: String(rec.Status || (inTime !== '--:--' ? 'P' : 'A')).trim(), remark: String(rec.Remark || '--').trim(),
          syncedAt: new Date(), recordKey: `${source.id}_${code}_${date}`,
        });
      }
      const closed = await payrollRunService.closedMonthsAmong(docs.map((d) => d.date));
      const writable = docs.filter((d) => !closed.has(monthOf(d.date)));
      const skippedClosed = docs.length - writable.length;

      if (writable.length) {
        await InOutModel.bulkWrite(
          writable.map((doc) => ({ updateOne: { filter: { recordKey: doc.recordKey }, update: { $set: doc }, upsert: true } })),
          { ordered: false }
        );
        await employeeMasterService.ensureProfiles(writable.map((d) => ({ empCode: d.employeeCode, name: d.employeeName, siteId: siteService.siteIdForSource(source.id) })));
        for (const d of writable) await identityService.ensureMapping(source.id, d.vendorEmployeeCode, d.employeeCode);
        await attendanceDayService.recomputeMany(writable.map((d) => ({ employeeCode: d.employeeCode, businessDate: d.date })));
      }
      const notes = [skippedClosed ? `${skippedClosed} day record(s) skipped: payroll month closed` : '', parseErrors ? `${parseErrors} unparseable record(s)` : ''].filter(Boolean);
      return { fetched: rows.length, inserted: writable.length, skipped: skippedClosed, partial: notes.length > 0, note: notes.join('; ') || undefined };
    });
  }

  public async syncAll(type: SyncType, options: SyncOptions = {}): Promise<SyncSummaryResult[]> {
    const results: SyncSummaryResult[] = [];
    for (const source of getAllSources().filter((s) => s.enabled)) {
      try {
        results.push(await (type === 'RAW' ? this.syncRaw(source.id, options) : this.syncInOut(source.id, options)));
      } catch (e: any) {
        // validation / lock conflicts for this source must not hide the other sources
        results.push({
          success: false, sourceId: source.id, source: source.displayName, syncType: type, fetched: 0, inserted: 0, duplicates: 0,
          status: 'FAILED', durationMs: 0, error: e?.message || 'Sync failed',
        });
      }
    }
    return results;
  }
}

export const syncService = new SyncService();
