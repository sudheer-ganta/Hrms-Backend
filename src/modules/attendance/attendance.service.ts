import { AttendanceModel } from './attendance.model.js';
import { AttendanceDayModel } from './attendanceDay.model.js';
import { attendanceDayService } from './attendanceDay.service.js';
import { isOffDay, isPresentLike, isLop } from './attendanceStatus.js';
import { resolveDay } from './attendanceResolver.js';
import { IAttendanceRecord, AttendanceQueryFilters, AttendancePaginationResult } from './attendance.types.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { policyService } from '../settings/policy.service.js';
import { siteService } from '../sites/site.service.js';
import { SyncLogModel } from '../sync/sync.model.js';
import { getAllSources } from '../../config/env.js';
import { requireDb } from '../../config/db.js';
import { escapeRegex } from '../../utils/validate.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { isValidBusinessDate, istToday } from '../../utils/istTime.js';

export interface DashboardStatsResult {
  selectedDate: string;
  isFuture: boolean;
  /** Active employees in scope. 0 means "no roster yet", never a made-up number. */
  totalWorkforce: number;
  presentCount: number;       // PRESENT + WFH + OD + MISSED_PUNCH
  halfDayCount: number;
  absentCount: number;        // ABSENT + unpaid leave (working day, no valid attendance)
  leaveCount: number;
  weeklyOffCount: number;     // weekly off + holiday
  lateArrivalsCount: number;  // first punch after shift start + grace (policy)
  /** (present + half) / (workforce - off - paid leave); null when the denominator is 0. */
  attendanceRate: number | null;
  absenteeismRate: number | null;
  todayPunches: number;
  totalRecords: number;
  lastSyncAt: Date | null;
  locationBreakdown: Array<{
    siteId: string; sourceId: string; sourceName: string; totalWorkforce: number; presentCount: number; halfDayCount: number; absentCount: number;
    leaveCount: number; offCount: number; attendanceRate: number | null; totalPunches: number; todayPunches: number;
    lastSyncStatus: string; lastSyncAt: Date | null;
  }>;
  hourlyDistribution: Array<{ hour: string; label: string; punches: number }>;
  recentPunches: IAttendanceRecord[];
}

const HOUR_SLOTS = Array.from({ length: 16 }, (_, i) => {
  const h = 6 + i;
  const label = h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`;
  return { hour: `${String(h).padStart(2, '0')}:00`, label, hourNum: h };
});

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);

export class AttendanceService {
  /** Raw punch log (immutable facts), paginated. */
  public async getRawPunches(f: AttendanceQueryFilters): Promise<AttendancePaginationResult> {
    requireDb();
    const page = f.page ?? 1;
    const limit = f.limit ?? 50;
    const q: any = {};
    if (f.sourceId && f.sourceId !== 'all') q.sourceId = f.sourceId.toLowerCase().trim();
    if (f.fromDate && f.toDate) q.entryDate = { $gte: f.fromDate, $lte: f.toDate };
    else if (f.fromDate) q.entryDate = { $gte: f.fromDate };
    else if (f.toDate) q.entryDate = { $lte: f.toDate };
    if (f.employeeCode) q.employeeCode = normalizeEmpCode(f.employeeCode);
    if (f.machineId) q.machineId = f.machineId.trim();
    if (f.origin) q.origin = f.origin;
    if (f.search?.trim()) {
      const rx = new RegExp(escapeRegex(f.search.trim()), 'i');
      q.$or = [{ employeeCode: rx }, { employeeName: rx }];
    }
    const sortBy = f.sortBy === 'entryDate' || f.sortBy === 'employeeCode' ? f.sortBy : 'punchDateTime';
    const [total, records] = await Promise.all([
      AttendanceModel.countDocuments(q),
      AttendanceModel.find(q).sort({ [sortBy]: f.sortOrder === 'asc' ? 1 : -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return {
      data: records as unknown as IAttendanceRecord[],
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Dashboard numbers for one business date. Every figure comes from the attendance resolver
   * applied to the active-employee roster; nothing is estimated or defaulted.
   */
  public async getDashboardStats(dateParam?: string, sourceIdParam?: string): Promise<DashboardStatsResult> {
    requireDb();
    const today = istToday();
    const date = dateParam && isValidBusinessDate(dateParam) ? dateParam : today;
    const siteFilter = sourceIdParam && sourceIdParam !== 'all' ? sourceIdParam.trim().toLowerCase() : undefined;
    const policy = policyService.getSettings();

    const [profiles, sites, dayDocs] = await Promise.all([
      employeeMasterService.getAllProfiles(),
      siteService.getSites(),
      AttendanceDayModel.find({ businessDate: date }).lean(),
    ]);
    const roster = profiles.filter((p) => p.status === 'active' && (!siteFilter || p.location === siteFilter));
    const rosterCodes = new Set(roster.map((p) => p.empCode));
    const siteOfEmployee = new Map(profiles.map((p) => [p.empCode, p.location || '']));

    const month = date.slice(0, 7);
    const resolved = await attendanceDayService.resolveMonth(roster.map((p) => p.empCode), month, policy, today);
    const dayIndex = date.slice(8, 10);
    const todayResolved = new Map<string, ReturnType<typeof resolveDay>>();
    for (const [code, days] of resolved) todayResolved.set(code, days[Number(dayIndex) - 1]);

    const tally = (codes: Iterable<string>) => {
      const t = { total: 0, present: 0, half: 0, absent: 0, leave: 0, off: 0, late: 0 };
      for (const c of codes) {
        const r = todayResolved.get(c);
        if (!r) continue;
        t.total++;
        if (!r.status) continue; // future
        if (isPresentLike(r.status)) t.present++;
        else if (r.status === 'HALF_DAY') t.half++;
        else if (isLop(r.status)) t.absent++;
        else if (r.status === 'LEAVE_PAID') t.leave++;
        else if (isOffDay(r.status)) t.off++;
        if (r.isLate && (isPresentLike(r.status) || r.status === 'HALF_DAY')) t.late++;
      }
      return t;
    };
    const overall = tally(rosterCodes);
    const expected = overall.total - overall.off - overall.leave;

    // ---- raw punch based widgets (volume, hourly, recent) ----
    const punchQ: any = { entryDate: date };
    if (siteFilter) punchQ.$or = [{ siteId: siteFilter }, { sourceId: siteFilter }];
    const [todayPunches, totalRecords, hourlyDocs, recent, lastLog] = await Promise.all([
      AttendanceModel.countDocuments(punchQ),
      AttendanceModel.countDocuments(siteFilter ? { $or: [{ siteId: siteFilter }, { sourceId: siteFilter }] } : {}),
      AttendanceModel.find(punchQ).select('entryTime').lean(),
      AttendanceModel.find(punchQ).sort({ punchDateTime: -1 }).limit(10).lean(),
      SyncLogModel.findOne(siteFilter ? { sourceId: siteFilter } : {}).sort({ startedAt: -1 }).lean(),
    ]);
    const hourly: Record<number, number> = {};
    for (const p of hourlyDocs as any[]) {
      const h = parseInt(String(p.entryTime).split(':')[0], 10);
      if (h >= 0 && h <= 23) hourly[h] = (hourly[h] || 0) + 1;
    }

    // ---- per site ----
    const sourceBySite = new Map(getAllSources().map((s) => [s.siteId, s]));
    const locationBreakdown = await Promise.all(
      sites.map(async (site) => {
        const codes = roster.filter((p) => siteOfEmployee.get(p.empCode) === site.siteId).map((p) => p.empCode);
        const t = tally(codes);
        const siteExpected = t.total - t.off - t.leave;
        const src = sourceBySite.get(site.siteId);
        const [totalPunches, todaySitePunches, lastSiteLog] = await Promise.all([
          AttendanceModel.countDocuments({ $or: [{ siteId: site.siteId }, { sourceId: site.siteId }] }),
          AttendanceModel.countDocuments({ entryDate: date, $or: [{ siteId: site.siteId }, { sourceId: site.siteId }] }),
          SyncLogModel.findOne({ sourceId: src?.id || site.siteId }).sort({ startedAt: -1 }).lean(),
        ]);
        return {
          siteId: site.siteId, sourceId: src?.id || site.siteId, sourceName: site.displayName,
          totalWorkforce: t.total, presentCount: t.present, halfDayCount: t.half, absentCount: t.absent, leaveCount: t.leave, offCount: t.off,
          attendanceRate: rate(t.present + t.half, siteExpected), totalPunches, todayPunches: todaySitePunches,
          lastSyncStatus: lastSiteLog?.status || (src?.corporateId ? 'NEVER_RUN' : 'CREDENTIALS_MISSING'),
          lastSyncAt: (lastSiteLog?.completedAt || lastSiteLog?.startedAt || null) as Date | null,
        };
      })
    );

    return {
      selectedDate: date,
      isFuture: date > today,
      totalWorkforce: overall.total,
      presentCount: overall.present,
      halfDayCount: overall.half,
      absentCount: overall.absent,
      leaveCount: overall.leave,
      weeklyOffCount: overall.off,
      lateArrivalsCount: overall.late,
      attendanceRate: rate(overall.present + overall.half, expected),
      absenteeismRate: expected > 0 ? 100 - (rate(overall.present + overall.half, expected) as number) : null,
      todayPunches,
      totalRecords,
      lastSyncAt: (lastLog?.completedAt || lastLog?.startedAt || null) as Date | null,
      locationBreakdown,
      hourlyDistribution: HOUR_SLOTS.map((s) => ({ hour: s.hour, label: s.label, punches: hourly[s.hourNum] || 0 })),
      recentPunches: recent as unknown as IAttendanceRecord[],
    };
  }
}

export const attendanceService = new AttendanceService();
