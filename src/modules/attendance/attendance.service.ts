import { AttendanceModel } from './attendance.model.js';
import { AttendanceDayModel } from './attendanceDay.model.js';
import { attendanceDayService } from './attendanceDay.service.js';
import { isOffDay, isPresentLike, isLop } from './attendanceStatus.js';
import { resolveDay } from './attendanceResolver.js';
import { IAttendanceRecord, AttendanceQueryFilters, AttendancePaginationResult } from './attendance.types.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { EmployeeProfile } from '../employees/employeeMaster.types.js';
import { outsideEmployment } from '../employees/employment.js';
import { policyService } from '../settings/policy.service.js';
import { siteService } from '../sites/site.service.js';
import { SyncLogModel } from '../sync/sync.model.js';
import { getAllSources } from '../../config/env.js';
import { requireDb } from '../../config/db.js';
import { escapeRegex } from '../../utils/validate.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { isValidBusinessDate, istToday } from '../../utils/istTime.js';
import { revisionService } from '../realtime/revision.service.js';

/**
 * All-time punch totals only change when punches are written, and every write or sync bumps the data revision.
 * Counting the whole (ever-growing) collection on each dashboard load is the slowest part of that screen,
 * so the totals are reused until the revision moves (or a minute passes, as a safety net).
 */
const TOTALS_MAX_AGE_MS = 60_000;
const totalsCache = new Map<string, { revision: number; at: number; value: number }>();
const cachedTotal = async (key: string, count: () => Promise<number>): Promise<number> => {
  const revision = revisionService.getRevision().revision;
  const hit = totalsCache.get(key);
  if (hit && hit.revision === revision && Date.now() - hit.at < TOTALS_MAX_AGE_MS) return hit.value;
  const value = await count();
  totalsCache.set(key, { revision, at: Date.now(), value });
  return value;
};

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
  /**
   * Only on the all-locations answer: the complete dashboard of each location, keyed by siteId, so a screen can switch
   * location without asking again. Each entry is exactly what a request for that location alone would return.
   */
  bySite?: Record<string, Omit<DashboardStatsResult, 'bySite'>>;
}

const HOUR_SLOTS = Array.from({ length: 16 }, (_, i) => {
  const h = 6 + i;
  const label = h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`;
  return { hour: `${String(h).padStart(2, '0')}:00`, label, hourNum: h };
});

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);

/**
 * Who the dashboard counts on `date`: active employees (at the chosen site) who were employed that day.
 * Someone who joins on the 15th is not "absent" on the 10th, and someone who left on the 20th is not "absent" on the 25th.
 */
export const dashboardRoster = (profiles: EmployeeProfile[], date: string, siteId?: string): EmployeeProfile[] =>
  profiles.filter((p) => p.status === 'active' && (!siteId || p.location === siteId) && !outsideEmployment(p, date));

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

    const [profiles, sites] = await Promise.all([employeeMasterService.getAllProfiles(), siteService.getSites()]);
    const siteOfEmployee = new Map(profiles.map((p) => [p.empCode, p.location || '']));

    // Resolve every employee in scope ONCE. For "all locations" that single pass also answers each location.
    const scopeRoster = dashboardRoster(profiles, date, siteFilter);
    const month = date.slice(0, 7);
    const resolved = await attendanceDayService.resolveMonth(scopeRoster.map((p) => p.empCode), month, policy, today);
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

    // ---- the day's punches (every location), newest first; every widget below is a slice of this ----
    const punchQ = { entryDate: date }; // always every location: a location's widgets are slices of it
    const sourceBySite = new Map(getAllSources().map((s) => [s.siteId, s]));
    const [dayPunches, totalRecords, lastLog, lastSiteLogs] = await Promise.all([
      AttendanceModel.find(punchQ).sort({ punchDateTime: -1 }).lean() as unknown as Promise<IAttendanceRecord[]>,
      siteFilter
        ? cachedTotal(`site:${siteFilter}`, () => AttendanceModel.countDocuments({ $or: [{ siteId: siteFilter }, { sourceId: siteFilter }] }))
        : AttendanceModel.estimatedDocumentCount(), // collection metadata: no scan
      SyncLogModel.findOne(siteFilter ? { sourceId: siteFilter } : {}).sort({ startedAt: -1 }).lean(),
      Promise.all(sites.map((site) => SyncLogModel.findOne({ sourceId: sourceBySite.get(site.siteId)?.id || site.siteId }).sort({ startedAt: -1 }).lean())),
    ]);
    const siteTotals = await Promise.all(
      sites.map((site) => cachedTotal(`site:${site.siteId}`, () => AttendanceModel.countDocuments({ $or: [{ siteId: site.siteId }, { sourceId: site.siteId }] })))
    );
    const punchesOfSite = (siteId: string) => dayPunches.filter((p: any) => p.siteId === siteId || p.sourceId === siteId);

    const hourlyOf = (punches: IAttendanceRecord[]) => {
      const hourly: Record<number, number> = {};
      for (const p of punches as any[]) {
        const h = parseInt(String(p.entryTime).split(':')[0], 10);
        if (h >= 0 && h <= 23) hourly[h] = (hourly[h] || 0) + 1;
      }
      return HOUR_SLOTS.map((s) => ({ hour: s.hour, label: s.label, punches: hourly[s.hourNum] || 0 }));
    };

    /** The full dashboard for one view: `view` is a location id, or undefined for everyone in scope. */
    const build = (view?: string): Omit<DashboardStatsResult, 'bySite'> => {
      const roster = view ? scopeRoster.filter((p) => p.location === view) : scopeRoster;
      const overall = tally(roster.map((p) => p.empCode));
      const expected = overall.total - overall.off - overall.leave;
      const punches = view ? punchesOfSite(view) : dayPunches;

      const locationBreakdown = sites.map((site, i) => {
        const codes = roster.filter((p) => siteOfEmployee.get(p.empCode) === site.siteId).map((p) => p.empCode);
        const t = tally(codes);
        const siteExpected = t.total - t.off - t.leave;
        const src = sourceBySite.get(site.siteId);
        const lastSiteLog: any = lastSiteLogs[i];
        return {
          siteId: site.siteId, sourceId: src?.id || site.siteId, sourceName: site.displayName,
          totalWorkforce: t.total, presentCount: t.present, halfDayCount: t.half, absentCount: t.absent, leaveCount: t.leave, offCount: t.off,
          attendanceRate: rate(t.present + t.half, siteExpected), totalPunches: siteTotals[i], todayPunches: punchesOfSite(site.siteId).length,
          lastSyncStatus: lastSiteLog?.status || (src?.corporateId ? 'NEVER_RUN' : 'CREDENTIALS_MISSING'),
          lastSyncAt: (lastSiteLog?.completedAt || lastSiteLog?.startedAt || null) as Date | null,
        };
      });

      // Same "last sync" rule as before: the newest sync log of the view (any location for "all").
      const viewLog: any = view
        ? lastSiteLogs[sites.findIndex((s) => s.siteId === view || sourceBySite.get(s.siteId)?.id === view)] ?? lastLog
        : lastLog;

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
        todayPunches: punches.length,
        totalRecords: view ? (siteTotals[sites.findIndex((s) => s.siteId === view)] ?? 0) : totalRecords,
        lastSyncAt: (viewLog?.completedAt || viewLog?.startedAt || null) as Date | null,
        locationBreakdown,
        hourlyDistribution: hourlyOf(punches),
        recentPunches: punches.slice(0, 10),
      };
    };

    if (siteFilter) {
      // A single-location request (kept for older clients): the same numbers the "all" answer carries for that location.
      return { ...build(siteFilter), totalRecords, lastSyncAt: ((lastLog as any)?.completedAt || (lastLog as any)?.startedAt || null) as Date | null };
    }
    // "All locations": one answer for everyone, plus the complete answer for each location so the screen can switch locally.
    const bySite: Record<string, Omit<DashboardStatsResult, 'bySite'>> = {};
    for (const site of sites) bySite[site.siteId] = build(site.siteId);
    return { ...build(), bySite };
  }
}

export const attendanceService = new AttendanceService();
