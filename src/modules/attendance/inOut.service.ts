import { getSourceById, getAllSources } from '../../config/env.js';
import { etimeofficeClient } from '../etimeoffice/etimeoffice.client.js';
import {
  convertDateStringToISO,
  parseWorkTimeToMinutes,
  formatMinutesToHours,
  getTodayDateString
} from '../../utils/dateUtils.js';
import { InOutModel } from './inOut.model.js';
import { AttendanceModel } from './attendance.model.js';
import { localStore } from '../../config/localStore.js';
import {
  IInOutRecord,
  InOutQueryFilters,
  InOutPaginationResult,
  EmployeeTimesheet,
  EmployeeTimesheetDay
} from './inOut.types.js';
import { SyncLogModel } from '../sync/sync.model.js';
import mongoose from 'mongoose';

export class InOutService {
  /**
   * Syncs IN/OUT attendance data from e-Timeoffice API 3 (/DownloadInOutPunchData)
   */
  public async syncInOutData(params: {
    sourceId: string;
    fromDate: string;
    toDate: string;
    empCode?: string;
    triggeredBy?: 'MANUAL' | 'SCHEDULED';
  }): Promise<{
    success: boolean;
    sourceId: string;
    source: string;
    count: number;
    durationMs: number;
    error?: string;
  }> {
    const startTime = Date.now();
    const { sourceId, fromDate, toDate, empCode = 'ALL', triggeredBy = 'MANUAL' } = params;

    const source = getSourceById(sourceId);
    if (!source) {
      throw new Error(`Invalid source location: "${sourceId}".`);
    }

    let syncLogDoc: any = null;
    let localLogId: string | null = null;
    const isDbConnectedForLog = mongoose.connection.readyState === 1;

    if (isDbConnectedForLog) {
      try {
        syncLogDoc = await SyncLogModel.create({
          sourceId: source.id,
          sourceName: source.displayName,
          startedAt: new Date(),
          status: 'RUNNING',
          recordsFetched: 0,
          recordsInserted: 0,
          recordsSkipped: 0,
          requestFromDate: fromDate,
          requestToDate: toDate,
          triggeredBy,
          syncType: 'INOUT',
        });
      } catch (err) {
        console.warn('Could not write initial IN/OUT sync log to MongoDB:', err);
      }
    } else {
      const localLog = localStore.addSyncLog({
        sourceId: source.id,
        sourceName: source.displayName,
        startedAt: new Date(),
        status: 'RUNNING',
        recordsFetched: 0,
        recordsInserted: 0,
        recordsSkipped: 0,
        requestFromDate: fromDate,
        requestToDate: toDate,
        triggeredBy,
        syncType: 'INOUT',
      });
      localLogId = localLog._id;
    }

    try {
      const clientResult = await etimeofficeClient.fetchInOutPunchData({
        sourceId: source.id,
        fromDate,
        toDate,
        empCode,
      });

      const rawRecords = clientResult.records || [];
      const normalizedDocs: IInOutRecord[] = [];

      for (const rec of rawRecords) {
        if (!rec.DateString) continue;

        const dateISO = convertDateStringToISO(rec.DateString);
        const empCodeClean = (rec.Empcode || 'UNKNOWN').toString().trim().toUpperCase();
        const empNameClean = (rec.Name || 'Unknown Employee').toString().trim();
        const inTime = rec.INTime || '--:--';
        const outTime = rec.OUTTime || '--:--';
        const workTime = rec.WorkTime || '00:00';
        const workMinutes = parseWorkTimeToMinutes(workTime);
        const overTime = rec.OverTime || '00:00';
        const breakTime = rec.BreakTime || '00:00';
        const lateIn = rec.Late_In || '00:00';
        const earlyOut = rec.Erl_Out || '00:00';
        const status = (rec.Status || (inTime !== '--:--' ? 'P' : 'A')).trim();
        const remark = (rec.Remark || '--').trim();

        let statusLabel = 'Present';
        if (status === 'A') statusLabel = 'Absent';
        else if (status === 'P/2') statusLabel = 'Half Day';
        else if (status === 'W' || status === 'WO') statusLabel = 'Weekly Off';
        else if (status === 'H' || status === 'HL') statusLabel = 'Holiday';
        else if (status === 'L' || status === 'PL' || status === 'CL') statusLabel = 'Leave';

        const recordKey = `${source.id}_${empCodeClean}_${dateISO}`;

        normalizedDocs.push({
          sourceId: source.id,
          sourceName: source.displayName,
          employeeCode: empCodeClean,
          employeeName: empNameClean,
          date: dateISO,
          inTime,
          outTime,
          workTime,
          workMinutes,
          overTime,
          breakTime,
          lateIn,
          earlyOut,
          status,
          statusLabel,
          remark,
          syncedAt: new Date(),
          recordKey,
        });
      }

      const isDbConnected = mongoose.connection.readyState === 1;

      if (isDbConnected && normalizedDocs.length > 0) {
        const bulkOps = normalizedDocs.map((doc) => ({
          updateOne: {
            filter: { recordKey: doc.recordKey },
            update: { $set: doc },
            upsert: true,
          },
        }));
        await InOutModel.bulkWrite(bulkOps, { ordered: false });
      }

      // Always save to fallback localStore
      localStore.upsertInOutRecords(normalizedDocs);

      const durationMs = Date.now() - startTime;

      if (syncLogDoc) {
        syncLogDoc.completedAt = new Date();
        syncLogDoc.status = 'SUCCESS';
        syncLogDoc.recordsFetched = rawRecords.length;
        syncLogDoc.recordsInserted = normalizedDocs.length;
        await syncLogDoc.save();
      } else if (localLogId) {
        localStore.updateSyncLog(localLogId, {
          completedAt: new Date(),
          status: 'SUCCESS',
          recordsFetched: rawRecords.length,
          recordsInserted: normalizedDocs.length,
        });
      }

      return {
        success: true,
        sourceId: source.id,
        source: source.displayName,
        count: normalizedDocs.length,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err?.message || 'Failed to sync In/Out punch data';

      if (syncLogDoc) {
        syncLogDoc.completedAt = new Date();
        syncLogDoc.status = 'FAILED';
        syncLogDoc.errorMessage = errorMessage;
        await syncLogDoc.save();
      } else if (localLogId) {
        localStore.updateSyncLog(localLogId, {
          completedAt: new Date(),
          status: 'FAILED',
          errorMessage,
        });
      }

      return {
        success: false,
        sourceId: source.id,
        source: source.displayName,
        count: 0,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Syncs IN/OUT data for all configured locations
   */
  public async syncAllLocationsInOut(params: {
    fromDate: string;
    toDate: string;
    empCode?: string;
    triggeredBy?: 'MANUAL' | 'SCHEDULED';
  }) {
    const sources = getAllSources().filter((s) => s.enabled);
    const results = [];
    for (const src of sources) {
      const res = await this.syncInOutData({
        sourceId: src.id,
        fromDate: params.fromDate,
        toDate: params.toDate,
        empCode: params.empCode,
        triggeredBy: params.triggeredBy,
      });
      results.push(res);
    }
    const totalCount = results.reduce((acc, r) => acc + r.count, 0);
    return {
      success: results.every((r) => r.success),
      results,
      totalCount,
    };
  }

  /**
   * Queries paginated In/Out attendance records with live summary metrics
   */
  public async getInOutRecords(filters: InOutQueryFilters): Promise<InOutPaginationResult> {
    const isDbConnected = mongoose.connection.readyState === 1;
    const {
      sourceId,
      fromDate,
      toDate,
      employeeCode,
      search,
      status,
      page = 1,
      limit = 50,
      sortBy = 'date',
      sortOrder = 'desc',
    } = filters;

    const currentPage = Math.max(1, Number(page));
    const pageSize = Math.max(1, Math.min(200, Number(limit)));
    const skip = (currentPage - 1) * pageSize;

    let records: IInOutRecord[] = [];
    let total = 0;

    if (isDbConnected) {
      const query: any = {};
      if (sourceId && sourceId !== 'all') query.sourceId = sourceId.toLowerCase().trim();
      if (fromDate && toDate) query.date = { $gte: fromDate, $lte: toDate };
      else if (fromDate) query.date = { $gte: fromDate };
      else if (toDate) query.date = { $lte: toDate };

      if (employeeCode) query.employeeCode = employeeCode.trim().toUpperCase();
      if (status && status !== 'all') query.status = status.trim();

      if (search && search.trim()) {
        const regex = new RegExp(search.trim(), 'i');
        query.$or = [{ employeeCode: regex }, { employeeName: regex }];
      }

      const sortOptions: any = {
        [sortBy]: sortOrder === 'asc' ? 1 : -1,
        employeeCode: 1,
      };

      const [count, docs] = await Promise.all([
        InOutModel.countDocuments(query),
        InOutModel.find(query).sort(sortOptions).skip(skip).limit(pageSize).lean(),
      ]);

      total = count;
      records = docs as unknown as IInOutRecord[];
    } else {
      let all = localStore.getInOutRecords();

      if (sourceId && sourceId !== 'all') {
        const normSrc = sourceId.toLowerCase().trim();
        all = all.filter((r) => r.sourceId === normSrc);
      }
      if (fromDate) all = all.filter((r) => r.date >= fromDate);
      if (toDate) all = all.filter((r) => r.date <= toDate);
      if (employeeCode) {
        const code = employeeCode.trim().toUpperCase();
        all = all.filter((r) => r.employeeCode === code);
      }
      if (status && status !== 'all') {
        all = all.filter((r) => r.status === status);
      }
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        all = all.filter(
          (r) =>
            r.employeeCode.toLowerCase().includes(q) ||
            r.employeeName.toLowerCase().includes(q)
        );
      }

      all.sort((a, b) => {
        if (sortBy === 'date') {
          return sortOrder === 'asc'
            ? a.date.localeCompare(b.date)
            : b.date.localeCompare(a.date);
        }
        return 0;
      });

      total = all.length;
      records = all.slice(skip, skip + pageSize);
    }

    // Auto-reconcile any records missing OUT time using raw biometric punches
    records = await this.reconcileWithRawPunches(records);

    // Compute summary metrics across matching set
    const allMatching = isDbConnected
      ? await InOutModel.find(
          (() => {
            const q: any = {};
            if (sourceId && sourceId !== 'all') q.sourceId = sourceId.toLowerCase().trim();
            if (fromDate && toDate) q.date = { $gte: fromDate, $lte: toDate };
            else if (fromDate) q.date = { $gte: fromDate };
            else if (toDate) q.date = { $lte: toDate };
            return q;
          })()
        ).select('status workMinutes overTime lateIn').lean()
      : localStore.getInOutRecords().filter((r) => {
          if (sourceId && sourceId !== 'all' && r.sourceId !== sourceId.toLowerCase().trim()) return false;
          if (fromDate && r.date < fromDate) return false;
          if (toDate && r.date > toDate) return false;
          return true;
        });

    let presentCount = 0;
    let absentCount = 0;
    let halfDayCount = 0;
    let weeklyOffCount = 0;
    let totalWorkMinutes = 0;
    let totalOvertimeMinutes = 0;
    let lateArrivalsCount = 0;

    for (const r of allMatching) {
      if (r.status === 'P') presentCount++;
      else if (r.status === 'A') absentCount++;
      else if (r.status === 'P/2') halfDayCount++;
      else if (r.status === 'W' || r.status === 'WO') weeklyOffCount++;

      totalWorkMinutes += r.workMinutes || 0;
      totalOvertimeMinutes += parseWorkTimeToMinutes(r.overTime);
      if (r.lateIn && r.lateIn !== '00:00' && r.lateIn !== '--:--') {
        lateArrivalsCount++;
      }
    }

    const workingDaysCount = presentCount + halfDayCount;
    const avgWorkMinutes = workingDaysCount > 0 ? Math.round(totalWorkMinutes / workingDaysCount) : 0;

    return {
      data: records,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
      summary: {
        totalRecords: allMatching.length,
        presentCount,
        absentCount,
        halfDayCount,
        weeklyOffCount,
        totalWorkMinutes,
        avgWorkMinutes,
        totalOvertimeMinutes,
        lateArrivalsCount,
      },
    };
  }

  /**
   * Reconciles InOut records with actual biometric machine punches
   * when e-TimeOffice reports missing OUT times or zero work duration.
   */
  private async reconcileWithRawPunches(records: IInOutRecord[]): Promise<IInOutRecord[]> {
    if (!records || records.length === 0) return records;
    const isDbConnected = mongoose.connection.readyState === 1;

    const needsReconciliation = records.filter(
      (r) => !r.outTime || r.outTime === '--:--' || !r.workMinutes || r.workMinutes === 0
    );
    if (needsReconciliation.length === 0) return records;

    const empCodes = Array.from(new Set(needsReconciliation.map((r) => r.employeeCode)));
    const dates = Array.from(new Set(needsReconciliation.map((r) => r.date)));

    let rawPunches: any[] = [];
    if (isDbConnected) {
      try {
        rawPunches = await AttendanceModel.find({
          employeeCode: { $in: empCodes },
          entryDate: { $in: dates },
        }).lean();
      } catch (err) {
        console.warn('[InOutService] Could not fetch raw punches for reconciliation:', err);
      }
    } else {
      rawPunches = localStore.getRecords().filter(
        (p: any) => empCodes.includes(p.employeeCode) && dates.includes(p.entryDate)
      );
    }

    if (!rawPunches || rawPunches.length === 0) return records;

    // Group punches by `employeeCode_entryDate`
    const punchMap = new Map<string, any[]>();
    for (const p of rawPunches) {
      const key = `${p.employeeCode}_${p.entryDate}`;
      if (!punchMap.has(key)) punchMap.set(key, []);
      punchMap.get(key)!.push(p);
    }

    const updatesToPersist: any[] = [];

    for (const r of records) {
      if (r.outTime && r.outTime !== '--:--' && r.workMinutes && r.workMinutes > 0) continue;

      const key = `${r.employeeCode}_${r.date}`;
      const dayPunches = punchMap.get(key);
      if (!dayPunches || dayPunches.length < 2) continue;

      const sorted = [...dayPunches].sort(
        (a, b) => new Date(a.punchDateTime).getTime() - new Date(b.punchDateTime).getTime()
      );
      const firstPunch = sorted[0];
      const lastPunch = sorted[sorted.length - 1];

      const firstTimeStr = firstPunch.entryTime ? firstPunch.entryTime.slice(0, 5) : formatMinutesToHours(new Date(firstPunch.punchDateTime).getHours() * 60 + new Date(firstPunch.punchDateTime).getMinutes());
      const lastTimeStr = lastPunch.entryTime ? lastPunch.entryTime.slice(0, 5) : formatMinutesToHours(new Date(lastPunch.punchDateTime).getHours() * 60 + new Date(lastPunch.punchDateTime).getMinutes());

      if (firstTimeStr === lastTimeStr) continue;

      const firstMs = new Date(firstPunch.punchDateTime).getTime();
      const lastMs = new Date(lastPunch.punchDateTime).getTime();
      const durationMinutes = Math.max(0, Math.round((lastMs - firstMs) / (1000 * 60)));

      if (durationMinutes > 0) {
        if (!r.inTime || r.inTime === '--:--') r.inTime = firstTimeStr;
        r.outTime = lastTimeStr;
        r.workMinutes = durationMinutes;
        r.workTime = formatMinutesToHours(durationMinutes);
        if (durationMinutes >= 480) {
          r.status = 'P';
          r.statusLabel = 'Present';
        } else if (durationMinutes >= 240) {
          r.status = 'P/2';
          r.statusLabel = 'Half Day';
        }
        if (r.remark === 'MIS') r.remark = '--';

        updatesToPersist.push({
          recordKey: r.recordKey,
          inTime: r.inTime,
          outTime: r.outTime,
          workMinutes: r.workMinutes,
          workTime: r.workTime,
          status: r.status,
          statusLabel: r.statusLabel,
          remark: r.remark,
        });
      }
    }

    if (updatesToPersist.length > 0) {
      if (isDbConnected) {
        InOutModel.bulkWrite(
          updatesToPersist.map((u) => ({
            updateOne: {
              filter: { recordKey: u.recordKey },
              update: { $set: u },
            },
          })),
          { ordered: false }
        ).catch((e) => console.warn('[InOutService] Async bulkWrite error:', e.message));
      }
      localStore.upsertInOutRecords(updatesToPersist as any);
    }

    return records;
  }

  /**
   * Generates a complete employee timesheet matrix across a date range
   */
  public async getTimesheetMatrix(filters: {
    sourceId?: string;
    fromDate: string;
    toDate: string;
    search?: string;
  }): Promise<EmployeeTimesheet[]> {
    const isDbConnected = mongoose.connection.readyState === 1;
    const { sourceId, fromDate, toDate, search } = filters;

    let records: IInOutRecord[] = [];
    if (isDbConnected) {
      const q: any = { date: { $gte: fromDate, $lte: toDate } };
      if (sourceId && sourceId !== 'all') q.sourceId = sourceId.toLowerCase().trim();
      records = (await InOutModel.find(q).lean()) as unknown as IInOutRecord[];
    } else {
      records = localStore.getInOutRecords().filter((r) => {
        if (sourceId && sourceId !== 'all' && r.sourceId !== sourceId.toLowerCase().trim()) return false;
        return r.date >= fromDate && r.date <= toDate;
      });
    }

    // Reconcile raw punches for timesheet matrix
    records = await this.reconcileWithRawPunches(records);

    if (search && search.trim()) {
      const query = search.trim().toLowerCase();
      records = records.filter(
        (r) =>
          r.employeeCode.toLowerCase().includes(query) ||
          r.employeeName.toLowerCase().includes(query)
      );
    }

    const map = new Map<string, EmployeeTimesheet>();

    for (const r of records) {
      const key = `${r.sourceId}_${r.employeeCode}`;
      if (!map.has(key)) {
        map.set(key, {
          employeeCode: r.employeeCode,
          employeeName: r.employeeName,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          days: {},
          totalDaysPresent: 0,
          totalDaysAbsent: 0,
          totalWorkMinutes: 0,
          totalOvertimeMinutes: 0,
          avgHoursPerDay: '00:00',
        });
      }

      const sheet = map.get(key)!;
      sheet.days[r.date] = {
        date: r.date,
        inTime: r.inTime,
        outTime: r.outTime,
        workTime: r.workTime,
        workMinutes: r.workMinutes,
        status: r.status,
        lateIn: r.lateIn,
        overTime: r.overTime,
      };

      const hasIn = Boolean(r.inTime && r.inTime !== '--:--');
      const hasOut = Boolean(r.outTime && r.outTime !== '--:--');
      const isSingleSwipe = (hasIn !== hasOut);

      if (r.status === 'P' || r.status === 'P/2' || isSingleSwipe) {
        sheet.totalDaysPresent += r.status === 'P/2' ? 0.5 : 1;
      } else if (r.status === 'A') {
        sheet.totalDaysAbsent += 1;
      }

      sheet.totalWorkMinutes += r.workMinutes || 0;
      sheet.totalOvertimeMinutes += parseWorkTimeToMinutes(r.overTime);
    }

    const result = Array.from(map.values());
    for (const item of result) {
      if (item.totalDaysPresent > 0) {
        const avgMin = Math.round(item.totalWorkMinutes / item.totalDaysPresent);
        item.avgHoursPerDay = formatMinutesToHours(avgMin);
      }
    }

    return result;
  }
}

export const inOutService = new InOutService();
