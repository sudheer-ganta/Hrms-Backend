import { AttendanceModel } from './attendance.model.js';
import { InOutModel } from './inOut.model.js';
import { AttendanceDayModel } from './attendanceDay.model.js';
import { AttendanceAdjustmentModel } from './attendanceAdjustment.model.js';
import { resolveDay, ResolvedDay, DayFacts, ActiveAdjustment } from './attendanceResolver.js';
import { AttendanceOrigin, isLop, isOffDay, isPresentLike } from './attendanceStatus.js';
import { AttendanceDayDTO, AttendanceSummary, TimesheetEmployee } from './attendanceDay.types.js';
import { policyService, isOvernightShift } from '../settings/policy.service.js';
import { siteService } from '../sites/site.service.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { HRMSPolicySettings } from '../settings/policy.types.js';
import { requireDb } from '../../config/db.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { daysInMonth, datesBetween, hhmmToMinutes, istTimeFromInstant, istToday } from '../../utils/istTime.js';
import { parseWorkTimeToMinutes } from '../../utils/dateUtils.js';
import { escapeRegex } from '../../utils/validate.js';

export interface DayKey {
  employeeCode: string;
  businessDate: string;
}

const keyOf = (k: DayKey) => `${k.employeeCode}|${k.businessDate}`;
const hasTime = (t?: string | null) => !!t && t !== '--:--';

class AttendanceDayService {
  /**
   * PURE: merges raw punches, vendor daily summaries and active adjustments of ONE employee-day
   * into the stored FACTS document (or null when nothing exists for that day).
   */
  private buildDayDoc(code: string, businessDate: string, punches: any[], vendorRows: any[], adjustments: any[]) {
    if (!punches.length && !vendorRows.length && !adjustments.length) return null;
    const policy = policyService.getSettings();

    // Best vendor row: most measured work, then one that has an OUT, then 'P'.
    const rank = (r: any) => (r.workMinutes || 0) * 10 + (hasTime(r.outTime) ? 5 : 0) + (String(r.status).toUpperCase() === 'P' ? 1 : 0);
    const vendor: any = [...vendorRows].sort((a, b) => rank(b) - rank(a))[0] || null;

    let firstIn: string | null = null;
    let lastOut: string | null = null;
    let spanMinutes = 0;
    if (punches.length) {
      const first = punches[0].punchDateTime as Date;
      const last = punches[punches.length - 1].punchDateTime as Date;
      firstIn = istTimeFromInstant(first);
      if (punches.length > 1 && last.getTime() - first.getTime() >= 60_000) {
        lastOut = istTimeFromInstant(last);
        spanMinutes = Math.round((last.getTime() - first.getTime()) / 60_000);
      }
    }
    const overnight = isOvernightShift(policy.shift);
    if (vendor) {
      const vIn = hasTime(vendor.inTime) ? vendor.inTime : null;
      const vOut = hasTime(vendor.outTime) ? vendor.outTime : null;
      if (!firstIn) firstIn = vIn;
      else if (vIn && !overnight && (hhmmToMinutes(vIn) ?? 1e9) < (hhmmToMinutes(firstIn) ?? 1e9)) firstIn = vIn;
      if (!lastOut) lastOut = vOut;
      else if (vOut && !overnight && (hhmmToMinutes(vOut) ?? -1) > (hhmmToMinutes(lastOut) ?? -1)) lastOut = vOut;
    }
    const vendorWork = vendor ? Number(vendor.workMinutes) || parseWorkTimeToMinutes(vendor.workTime) : 0;
    const workMinutes = vendorWork > 0 ? vendorWork : spanMinutes;

    const origins = new Set<AttendanceOrigin>();
    const sourceIds = new Set<string>();
    punches.forEach((p: any) => { origins.add(p.origin || 'DEVICE'); sourceIds.add(p.sourceId); });
    if (vendorRows.length) origins.add('DEVICE');
    vendorRows.forEach((v: any) => sourceIds.add(v.sourceId));
    adjustments.forEach((a: any) => {
      origins.add(a.kind === 'LEAVE' ? 'LEAVE' : a.kind === 'WORK_FROM_HOME' ? 'WFH' : a.kind === 'ON_DUTY' ? 'ON_DUTY' : 'REGULARIZATION');
    });

    const sitePunch: any = punches.find((p: any) => p.siteId) || punches[0];
    const siteId = (sitePunch?.siteId || (vendor ? siteService.siteIdForSource(vendor.sourceId) : null) || (sitePunch ? siteService.siteIdForSource(sitePunch.sourceId) : null)) as string | null;

    return {
      employeeName: vendor?.employeeName || (punches[punches.length - 1] as any)?.employeeName,
      firstIn,
      lastOut,
      workMinutes,
      punchCount: punches.length,
      vendorStatus: vendor ? String(vendor.status) : null,
      vendorOvertimeMinutes: vendor ? parseWorkTimeToMinutes(vendor.overTime) : null,
      vendorLateMinutes: vendor ? parseWorkTimeToMinutes(vendor.lateIn) : null,
      siteId,
      sourceIds: Array.from(sourceIds),
      origins: Array.from(origins),
      manualOverride: adjustments.length > 0,
      adjustmentIds: adjustments.map((a: any) => String(a._id)),
      recomputedAt: new Date(),
      employeeCode: code,
      businessDate,
    };
  }

  /** Rebuilds the stored FACTS for one employee-day. Idempotent. Only this service writes attendance_days. */
  public async recompute(employeeCode: string, businessDate: string): Promise<void> {
    await this.recomputeMany([{ employeeCode, businessDate }]);
  }

  /**
   * Batched rebuild: one query per source collection per chunk (not per day), applied with a single
   * bulk write. Identical result to recomputing each day separately.
   */
  public async recomputeMany(keys: DayKey[]): Promise<number> {
    requireDb();
    const unique = new Map<string, DayKey>();
    for (const k of keys) {
      const nk = { employeeCode: normalizeEmpCode(k.employeeCode), businessDate: k.businessDate };
      unique.set(keyOf(nk), nk);
    }
    const all = Array.from(unique.values());
    const CHUNK = 100;
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      const codes = Array.from(new Set(chunk.map((k) => k.employeeCode)));
      const dates = Array.from(new Set(chunk.map((k) => k.businessDate)));
      const wanted = new Set(chunk.map(keyOf));
      const [punches, vendorRows, adjustments] = await Promise.all([
        AttendanceModel.find({ employeeCode: { $in: codes }, entryDate: { $in: dates } }).sort({ punchDateTime: 1 }).lean(),
        InOutModel.find({ employeeCode: { $in: codes }, date: { $in: dates } }).lean(),
        AttendanceAdjustmentModel.find({ employeeCode: { $in: codes }, businessDate: { $in: dates }, status: 'ACTIVE' }).lean(),
      ]);
      const bucket = <T,>(rows: T[], keyFn: (r: T) => string) => {
        const m = new Map<string, T[]>();
        for (const r of rows) { const k = keyFn(r); if (!wanted.has(k)) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
        return m;
      };
      const pBy = bucket(punches as any[], (p) => `${p.employeeCode}|${p.entryDate}`);
      const vBy = bucket(vendorRows as any[], (v) => `${v.employeeCode}|${v.date}`);
      const aBy = bucket(adjustments as any[], (a) => `${a.employeeCode}|${a.businessDate}`);

      const ops: any[] = [];
      for (const k of chunk) {
        const key = keyOf(k);
        const doc = this.buildDayDoc(k.employeeCode, k.businessDate, pBy.get(key) || [], vBy.get(key) || [], aBy.get(key) || []);
        if (!doc) ops.push({ deleteOne: { filter: { employeeCode: k.employeeCode, businessDate: k.businessDate } } });
        else {
          const { employeeCode, businessDate, ...fields } = doc;
          ops.push({ updateOne: { filter: { employeeCode, businessDate }, update: { $set: fields, $setOnInsert: { employeeCode, businessDate } }, upsert: true } });
        }
      }
      if (ops.length) await AttendanceDayModel.bulkWrite(ops, { ordered: false });
    }
    return all.length;
  }

  // ------------------------------------------------------------------ reads

  private toFacts(doc: any, adjustments: Map<string, ActiveAdjustment>): DayFacts {
    const adj = (doc.adjustmentIds || []).map((id: string) => adjustments.get(String(id))).filter(Boolean) as ActiveAdjustment[];
    return {
      firstIn: doc.firstIn,
      lastOut: doc.lastOut,
      punchCount: doc.punchCount,
      workMinutes: doc.workMinutes,
      vendorStatus: doc.vendorStatus,
      vendorOvertimeMinutes: doc.vendorOvertimeMinutes,
      vendorLateMinutes: doc.vendorLateMinutes,
      adjustments: adj,
    };
  }

  private async loadAdjustments(docs: any[]): Promise<Map<string, ActiveAdjustment>> {
    const ids = Array.from(new Set(docs.flatMap((d) => d.adjustmentIds || [])));
    const map = new Map<string, ActiveAdjustment>();
    if (!ids.length) return map;
    const rows = await AttendanceAdjustmentModel.find({ _id: { $in: ids }, status: 'ACTIVE' }).lean();
    rows.forEach((a: any) =>
      map.set(String(a._id), {
        id: String(a._id), requestId: a.requestId, kind: a.kind, inTime: a.inTime, outTime: a.outTime, paid: a.paid, fraction: a.fraction,
      })
    );
    return map;
  }

  private toDto(
    code: string,
    name: string,
    date: string,
    r: ResolvedDay,
    doc: any | undefined,
    siteNames: Map<string, string>
  ): AttendanceDayDTO {
    const siteId = (doc?.siteId as string | null) ?? null;
    return {
      employeeCode: code,
      employeeName: name,
      businessDate: date,
      siteId,
      siteName: siteId ? siteNames.get(siteId) || siteId : null,
      status: r.status,
      statusLabel: r.statusLabel,
      firstIn: r.firstIn,
      lastOut: r.lastOut,
      workMinutes: r.workMinutes,
      overtimeMinutes: r.overtimeMinutes,
      isLate: r.isLate,
      lateMinutes: r.lateMinutes,
      earlyCheckoutMinutes: r.earlyCheckoutMinutes,
      isWeeklyOff: r.isWeeklyOff,
      isHoliday: r.isHoliday,
      isPaidHoliday: r.isPaidHoliday,
      holidayName: r.holidayName,
      offDayWorkFraction: r.offDayWorkFraction,
      policyVersion: r.policyVersion,
      vendorStatus: r.vendorStatus,
      origins: (doc?.origins || []) as AttendanceOrigin[],
      sourceIds: doc?.sourceIds || [],
      manualOverride: !!doc?.manualOverride,
      adjustmentId: r.adjustmentId,
      requestId: r.requestId,
      inProgress: r.inProgress,
    };
  }

  private async siteNames(): Promise<Map<string, string>> {
    const sites = await siteService.getSites();
    return new Map(sites.map((s) => [s.siteId, s.displayName]));
  }

  /** Resolved rows for stored days in a range (one row per employee per date). */
  public async listResolved(filter: {
    fromDate?: string; toDate?: string; employeeCode?: string; siteId?: string; search?: string; includeInactive?: boolean;
  }): Promise<AttendanceDayDTO[]> {
    requireDb();
    const policy = policyService.getSettings();
    const today = istToday();
    const q: any = {};
    if (filter.fromDate && filter.toDate) q.businessDate = { $gte: filter.fromDate, $lte: filter.toDate };
    else if (filter.fromDate) q.businessDate = { $gte: filter.fromDate };
    else if (filter.toDate) q.businessDate = { $lte: filter.toDate };
    if (filter.employeeCode) q.employeeCode = normalizeEmpCode(filter.employeeCode);
    if (filter.siteId && filter.siteId !== 'all') q.siteId = filter.siteId.toLowerCase();

    const [docs, profiles, siteNames, inactive] = await Promise.all([
      AttendanceDayModel.find(q).lean(),
      employeeMasterService.getAllProfiles(),
      this.siteNames(),
      filter.includeInactive || filter.employeeCode ? Promise.resolve(new Set<string>()) : employeeMasterService.getInactiveCodes(),
    ]);
    const nameOf = new Map(profiles.map((p) => [p.empCode, p.name]));
    const adjustments = await this.loadAdjustments(docs);
    const needle = filter.search?.trim().toLowerCase();

    const out: AttendanceDayDTO[] = [];
    for (const d of docs as any[]) {
      if (inactive.has(d.employeeCode)) continue;
      const name = nameOf.get(d.employeeCode) || d.employeeName || `Employee ${d.employeeCode}`;
      if (needle && !d.employeeCode.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) continue;
      const resolved = resolveDay(d.businessDate, this.toFacts(d, adjustments), { policy, today });
      out.push(this.toDto(d.employeeCode, name, d.businessDate, resolved, d, siteNames));
    }
    out.sort((a, b) => (a.businessDate === b.businessDate ? a.employeeCode.localeCompare(b.employeeCode) : b.businessDate.localeCompare(a.businessDate)));
    return out;
  }

  public summarize(rows: AttendanceDayDTO[]): AttendanceSummary {
    const s: AttendanceSummary = {
      totalRecords: rows.length, presentCount: 0, halfDayCount: 0, absentCount: 0, leaveCount: 0, offCount: 0,
      missedPunchCount: 0, totalWorkMinutes: 0, avgWorkMinutes: 0, totalOvertimeMinutes: 0, lateArrivalsCount: 0,
    };
    for (const r of rows) {
      if (isPresentLike(r.status)) s.presentCount++;
      if (r.status === 'HALF_DAY') s.halfDayCount++;
      if (isLop(r.status)) s.absentCount++;
      if (r.status === 'LEAVE_PAID') s.leaveCount++;
      if (isOffDay(r.status)) s.offCount++;
      if (r.status === 'MISSED_PUNCH') s.missedPunchCount++;
      s.totalWorkMinutes += r.workMinutes;
      s.totalOvertimeMinutes += r.overtimeMinutes;
      if (r.isLate && (isPresentLike(r.status) || r.status === 'HALF_DAY')) s.lateArrivalsCount++;
    }
    const worked = s.presentCount + s.halfDayCount;
    s.avgWorkMinutes = worked ? Math.round(s.totalWorkMinutes / worked) : 0;
    return s;
  }

  /**
   * Full calendar for a set of employees over a month: every date is resolved, including
   * days with no stored record (absent / weekly off / holiday / future). This is what payroll,
   * the ESS calendar and the employee drawer consume.
   */
  public async resolveMonth(
    employeeCodes: string[] | 'ALL', month: string, policy: HRMSPolicySettings = policyService.getSettings(), today: string = istToday()
  ): Promise<Map<string, ResolvedDay[]>> {
    const dates = daysInMonth(month);
    const { resolved } = await this.resolveRange(employeeCodes, dates[0], dates[dates.length - 1], policy, today);
    return resolved;
  }

  /** Every date in [from, to] resolved for each employee (incl. offs / absences / future), plus the stored docs. */
  public async resolveRange(
    employeeCodes: string[] | 'ALL', from: string, to: string, policy: HRMSPolicySettings = policyService.getSettings(), today: string = istToday()
  ): Promise<{ resolved: Map<string, ResolvedDay[]>; docs: Map<string, any> }> {
    requireDb();
    const dates = datesBetween(from, to);
    const q: any = { businessDate: { $gte: from, $lte: to } };
    if (employeeCodes !== 'ALL') q.employeeCode = { $in: employeeCodes.map(normalizeEmpCode) };
    const docs = (await AttendanceDayModel.find(q).lean()) as any[];
    const adjustments = await this.loadAdjustments(docs);
    const byEmp = new Map<string, Map<string, any>>();
    const docIndex = new Map<string, any>();
    for (const d of docs) {
      if (!byEmp.has(d.employeeCode)) byEmp.set(d.employeeCode, new Map());
      byEmp.get(d.employeeCode)!.set(d.businessDate, d);
      docIndex.set(`${d.employeeCode}|${d.businessDate}`, d);
    }
    const codes = employeeCodes === 'ALL' ? Array.from(byEmp.keys()) : employeeCodes.map(normalizeEmpCode);
    const resolved = new Map<string, ResolvedDay[]>();
    for (const code of codes) {
      const mine = byEmp.get(code);
      resolved.set(code, dates.map((date) => {
        const doc = mine?.get(date);
        return resolveDay(date, doc ? this.toFacts(doc, adjustments) : undefined, { policy, today });
      }));
    }
    return { resolved, docs: docIndex };
  }

  /** One employee, every date in the range, as display-ready DTOs (portal calendar, drawer, timesheet rows). */
  public async calendar(employeeCode: string, from: string, to: string): Promise<AttendanceDayDTO[]> {
    const code = normalizeEmpCode(employeeCode);
    const [{ resolved, docs }, profile, siteNames] = await Promise.all([
      this.resolveRange([code], from, to),
      employeeMasterService.findProfile(code),
      this.siteNames(),
    ]);
    const name = profile?.name || `Employee ${code}`;
    return (resolved.get(code) || []).map((r) => this.toDto(code, name, r.businessDate, r, docs.get(`${code}|${r.businessDate}`), siteNames));
  }

  /** Timesheet: ONE row per active employee, one resolved verdict for EVERY date of the range. */
  public async timesheet(filter: { fromDate: string; toDate: string; siteId?: string; search?: string }): Promise<TimesheetEmployee[]> {
    requireDb();
    const policy = policyService.getSettings();
    const today = istToday();
    const [profiles, siteNames] = await Promise.all([employeeMasterService.getAllProfiles(), this.siteNames()]);
    const needle = filter.search?.trim().toLowerCase();
    const site = filter.siteId && filter.siteId !== 'all' ? filter.siteId.toLowerCase() : undefined;
    const roster = profiles.filter(
      (p) => p.status === 'active' && (!site || p.location === site) && (!needle || p.empCode.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
    );
    const { resolved, docs } = await this.resolveRange(roster.map((p) => p.empCode), filter.fromDate, filter.toDate, policy, today);
    return roster.map((p) => {
      const t: TimesheetEmployee = {
        employeeCode: p.empCode, employeeName: p.name, siteId: p.location || null, siteName: p.location ? siteNames.get(p.location) || p.location : null, days: {},
        totals: { presentDays: 0, halfDays: 0, leaveDays: 0, absentDays: 0, offDays: 0, missedPunchDays: 0, workMinutes: 0, overtimeMinutes: 0, lateDays: 0 },
      };
      for (const r of resolved.get(p.empCode) || []) {
        const dto = this.toDto(p.empCode, p.name, r.businessDate, r, docs.get(`${p.empCode}|${r.businessDate}`), siteNames);
        t.days[r.businessDate] = dto;
        if (isPresentLike(dto.status)) t.totals.presentDays++;
        if (dto.status === 'HALF_DAY') t.totals.halfDays++;
        if (dto.status === 'LEAVE_PAID') t.totals.leaveDays++;
        if (isLop(dto.status)) t.totals.absentDays++;
        if (isOffDay(dto.status)) t.totals.offDays++;
        if (dto.status === 'MISSED_PUNCH') t.totals.missedPunchDays++;
        if (dto.isLate && dto.status) t.totals.lateDays++;
        t.totals.workMinutes += dto.workMinutes;
        t.totals.overtimeMinutes += dto.overtimeMinutes;
      }
      return t;
    });
  }

  /** Resolves a single employee-day on demand (used by ESS status). */
  public async resolveOne(employeeCode: string, businessDate: string): Promise<{ day: ResolvedDay; doc: any | null }> {
    requireDb();
    const code = normalizeEmpCode(employeeCode);
    const doc = (await AttendanceDayModel.findOne({ employeeCode: code, businessDate }).lean()) as any;
    const adjustments = doc ? await this.loadAdjustments([doc]) : new Map<string, ActiveAdjustment>();
    const day = resolveDay(businessDate, doc ? this.toFacts(doc, adjustments) : undefined, { policy: policyService.getSettings(), today: istToday() });
    return { day, doc };
  }

  public escape = escapeRegex;
}

export const attendanceDayService = new AttendanceDayService();
