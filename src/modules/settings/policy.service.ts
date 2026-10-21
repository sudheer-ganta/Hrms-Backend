import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { PolicyModel } from './policy.model.js';
import { HRMSPolicySettings, CompanyHoliday, ShiftConfig, HolidayType, TimeWindow, PfConfig, PfCeilingRow } from './policy.types.js';
import { PAYROLL_RULES } from '../payroll/payroll.config.js';
import { pfCeilingOn } from '../payroll/pfRule.js';
import type { PfTerms } from '../employees/salary.js';
import { ApiError } from '../../utils/apiError.js';
import { DAY_NAME_LIST, DayName, TIME_RE, isValidBusinessDate, hhmmToMinutes } from '../../utils/istTime.js';
import { requireDb } from '../../config/db.js';
import { ENV } from '../../config/env.js';
import { optionalNumber, requireObject } from '../../utils/validate.js';

const POLICY_KEY = 'global_hrms_policy';

export const DEFAULT_SETTINGS: HRMSPolicySettings = {
  version: 1,
  shift: {
    shiftName: 'General Shift',
    startTime: '09:00',
    endTime: '17:30',
    gracePeriodMinutes: 60,
    halfDayThresholdMinutes: 180,
    fullDayThresholdMinutes: 360,
    minCheckoutForFullDay: '16:00',
    otWindows: [],
  },
  shifts: [],
  overtime: { enabled: true, hoursPerDay: 8 },
  offDayWork: { weeklyOff: { recognition: 'MANUAL' }, paidHoliday: { recognition: 'MANUAL' } },
  leaves: { casualLeave: 12, sickLeave: 12, earnedLeave: 15, compOff: 2 },
  weeklyOffDays: ['SUNDAY'],
  holidays: [],
  scheduler: { enabled: true, intervalMinutes: 5 },
  ess: { geofenceMode: 'ENFORCE' },
  // Opening values reproduce payroll.config.ts; from here on HR edits them in Settings instead of the code.
  statutory: {
    pf: {
      employeeRatePct: PAYROLL_RULES.pfRate * 100,
      epsRatePct: 8.33,
      adminRatePct: 0.5,
      edliRatePct: 0.5,
      ceilings: PAYROLL_RULES.pfCeilings.map((c) => ({ ...c })),
    },
  },
  updatedAt: new Date(0).toISOString(),
};

/** The PF rules payroll should use: the policy's, or the defaults for a policy that predates the setting. */
export const pfPolicy = (policy: HRMSPolicySettings): PfConfig => policy?.statutory?.pf ?? DEFAULT_SETTINGS.statutory.pf;

/** The PF rate and the ceiling in force on `isoDate`: what sizes the employer PF in a CTC-to-gross derivation. */
export const pfSalaryTerms = (policy: HRMSPolicySettings, isoDate: string): PfTerms => {
  const pf = pfPolicy(policy);
  return { rate: pctToRate(pf.employeeRatePct), ceiling: pfCeilingOn(isoDate, pf.ceilings) };
};

/** 12 (percent) → 0.12, without float noise (8.33 / 100 is not exactly 0.0833). */
export const pctToRate = (pct: number): number => Number((pct / 100).toFixed(6));

export const BASE_PF_CEILING_DATE = '1900-01-01';

/**
 * Standard work-day length in hours, derived from shift start/end. Single source of
 * truth for wage-rate and overtime-threshold math (overnight shifts wrap past midnight).
 */
const DS = DEFAULT_SETTINGS.shift;
/** Minute-of-day the shift starts / ends (falls back to the defaults only if the stored value is malformed). */
export const shiftStartMinutes = (shift: ShiftConfig): number => hhmmToMinutes(shift?.startTime || DS.startTime) ?? hhmmToMinutes(DS.startTime)!;
export const shiftEndMinutes = (shift: ShiftConfig): number => hhmmToMinutes(shift?.endTime || DS.endTime) ?? hhmmToMinutes(DS.endTime)!;

/**
 * Standard work-day length in hours, derived from shift start/end. Single source of
 * truth for wage-rate and overtime-threshold math (overnight shifts wrap past midnight).
 */
export function getShiftStandardHours(shift: ShiftConfig): number {
  const start = shiftStartMinutes(shift);
  let end = shiftEndMinutes(shift);
  if (end <= start) end += 24 * 60;
  return (end - start) / 60;
}

export const isOvernightShift = (shift: ShiftConfig): boolean => shiftEndMinutes(shift) <= shiftStartMinutes(shift);

/**
 * Overtime minutes for one day: the part of [firstIn, lastOut] (minute-of-day) that lies inside the shift's OT windows.
 * Same-day only; overnight shifts have no overtime windows.
 */
export function overtimeMinutesIn(shift: ShiftConfig, firstIn: number, lastOut: number): number {
  if (isOvernightShift(shift) || lastOut <= firstIn) return 0;
  let total = 0;
  for (const w of shift?.otWindows || []) {
    const s = hhmmToMinutes(w?.start);
    const e = hhmmToMinutes(w?.end);
    if (s === null || e === null || e <= s) continue;
    total += Math.max(0, Math.min(lastOut, e) - Math.max(firstIn, s));
  }
  return total;
}

/** The named shift an employee is on, or the default shift. Matching ignores case and surrounding spaces. */
export function namedShift(policy: HRMSPolicySettings, shiftName?: string | null): ShiftConfig | undefined {
  const want = String(shiftName ?? '').trim().toLowerCase();
  if (!want) return undefined;
  return (policy.shifts || []).find((s) => s.shiftName.trim().toLowerCase() === want);
}

/** The policy as one employee sees it: identical, except `shift` is the employee's own shift. */
export function policyForShift(policy: HRMSPolicySettings, shiftName?: string | null): HRMSPolicySettings {
  const own = namedShift(policy, shiftName);
  return own ? { ...policy, shift: own } : policy;
}

/** Minute-of-day after which a first punch counts as late (shift start + grace). */
export const lateThresholdMinutes = (shift: ShiftConfig): number =>
  shiftStartMinutes(shift) + (shift?.gracePeriodMinutes ?? 0);

const normalizeDayNames = (days: unknown): DayName[] => {
  const arr = Array.isArray(days) ? days : DEFAULT_SETTINGS.weeklyOffDays;
  const out = arr.map((d) => String(d).trim().toUpperCase()).filter((d): d is DayName => (DAY_NAME_LIST as readonly string[]).includes(d));
  return Array.from(new Set(out));
};

const normalizeHoliday = (h: any): CompanyHoliday => ({
  id: String(h.id),
  date: String(h.date),
  name: String(h.name),
  type: (['NATIONAL', 'FESTIVAL', 'OPTIONAL'] as const).includes(h.type) ? h.type : 'NATIONAL',
  paid: h.paid === undefined ? true : Boolean(h.paid), // legacy rows were all paid days off
});

const normalizeWindows = (raw: any): TimeWindow[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((w: any) => w && TIME_RE.test(String(w.start)) && TIME_RE.test(String(w.end)))
    .map((w: any) => ({ start: String(w.start), end: String(w.end) }));

/** Complete, typed shift from stored/raw data; anything missing or malformed falls back to `base`. */
function normalizeShift(raw: any, base: ShiftConfig): ShiftConfig {
  const s = { ...base, ...(raw || {}) };
  const positive = (v: any, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  return {
    shiftName: String(s.shiftName),
    startTime: TIME_RE.test(s.startTime) ? s.startTime : base.startTime,
    endTime: TIME_RE.test(s.endTime) ? s.endTime : base.endTime,
    gracePeriodMinutes: Number(s.gracePeriodMinutes ?? base.gracePeriodMinutes),
    halfDayThresholdMinutes: positive(s.halfDayThresholdMinutes, base.halfDayThresholdMinutes),
    fullDayThresholdMinutes: positive(s.fullDayThresholdMinutes, base.fullDayThresholdMinutes),
    minCheckoutForFullDay: s.minCheckoutForFullDay && TIME_RE.test(s.minCheckoutForFullDay) ? s.minCheckoutForFullDay : undefined,
    otWindows: normalizeWindows(s.otWindows),
  };
}

/** Ascending ceiling history whose first row is in force from the beginning; falls back to `base` if empty/malformed. */
function normalizeCeilings(raw: any, base: PfCeilingRow[]): PfCeilingRow[] {
  const rows = (Array.isArray(raw) ? raw : [])
    .filter((r: any) => r && isValidBusinessDate(r.from) && typeof r.ceiling === 'number' && r.ceiling > 0)
    .map((r: any) => ({ from: String(r.from), ceiling: Number(r.ceiling) }))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!rows.length) return base.map((r) => ({ ...r }));
  rows[0] = { ...rows[0], from: BASE_PF_CEILING_DATE };
  return rows;
}

// Explicit allow-list per sub-object so removed legacy fields can never leak out of stored documents.
function mergeWithDefaults(doc: any): HRMSPolicySettings {
  const c = doc || {};
  const D = DEFAULT_SETTINGS;
  const positive = (v: any, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  return {
    version: positive(c.version, 1),
    shift: normalizeShift(c.shift, D.shift),
    shifts: (Array.isArray(c.shifts) ? c.shifts : []).map((s: any) => normalizeShift(s, D.shift)),
    overtime: {
      enabled: c.overtime?.enabled ?? D.overtime.enabled,
      hoursPerDay: positive(c.overtime?.hoursPerDay, D.overtime.hoursPerDay),
    },
    offDayWork: {
      // A stored single `recognition` (first version of this setting) applies to both kinds.
      weeklyOff: { recognition: (c.offDayWork?.weeklyOff?.recognition ?? c.offDayWork?.recognition) === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL' },
      paidHoliday: { recognition: (c.offDayWork?.paidHoliday?.recognition ?? c.offDayWork?.recognition) === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL' },
    },
    leaves: {
      casualLeave: Number(c.leaves?.casualLeave ?? D.leaves.casualLeave),
      sickLeave: Number(c.leaves?.sickLeave ?? D.leaves.sickLeave),
      earnedLeave: Number(c.leaves?.earnedLeave ?? D.leaves.earnedLeave),
      compOff: Number(c.leaves?.compOff ?? D.leaves.compOff),
    },
    weeklyOffDays: normalizeDayNames(c.weeklyOffDays),
    holidays: (c.holidays || []).map(normalizeHoliday),
    scheduler: {
      enabled: c.scheduler?.enabled ?? D.scheduler.enabled,
      intervalMinutes: positive(c.scheduler?.intervalMinutes, D.scheduler.intervalMinutes),
    },
    ess: { geofenceMode: c.ess?.geofenceMode === 'OFF' ? 'OFF' : 'ENFORCE' },
    statutory: {
      pf: {
        employeeRatePct: positive(c.statutory?.pf?.employeeRatePct, D.statutory.pf.employeeRatePct),
        epsRatePct: positive(c.statutory?.pf?.epsRatePct, D.statutory.pf.epsRatePct),
        adminRatePct: Number(c.statutory?.pf?.adminRatePct ?? D.statutory.pf.adminRatePct),
        edliRatePct: Number(c.statutory?.pf?.edliRatePct ?? D.statutory.pf.edliRatePct),
        ceilings: normalizeCeilings(c.statutory?.pf?.ceilings, D.statutory.pf.ceilings),
      },
    },
    updatedAt: c.updatedAt ? String(c.updatedAt) : D.updatedAt,
  };
}

/** Validates a partial policy update and returns only whitelisted, typed fields. */
export function validatePolicyUpdate(input: unknown): Partial<HRMSPolicySettings> {
  const body = requireObject(input);
  const out: any = {};
  const bad = (field: string, issue: string) => {
    throw ApiError.validation(`Invalid ${field}.`, [{ field, issue }]);
  };

  /** Validates the fields of one shift object that are present; `path` prefixes error fields. */
  const validateShiftFields = (raw: unknown, path: string): Record<string, any> => {
    const s = requireObject(raw, path);
    const shift: any = {};
    if (s.shiftName !== undefined) shift.shiftName = String(s.shiftName).trim().slice(0, 80) || bad(`${path}.shiftName`, 'Required');
    for (const f of ['startTime', 'endTime'] as const) {
      if (s[f] !== undefined) { if (typeof s[f] !== 'string' || !TIME_RE.test(s[f] as string)) bad(`${path}.${f}`, 'Must be HH:mm'); shift[f] = s[f]; }
    }
    if (s.minCheckoutForFullDay !== undefined) {
      if (s.minCheckoutForFullDay === '' || s.minCheckoutForFullDay === null) shift.minCheckoutForFullDay = '';
      else if (typeof s.minCheckoutForFullDay !== 'string' || !TIME_RE.test(s.minCheckoutForFullDay)) bad(`${path}.minCheckoutForFullDay`, 'Must be HH:mm');
      else shift.minCheckoutForFullDay = s.minCheckoutForFullDay;
    }
    const grace = optionalNumber(s.gracePeriodMinutes, `${path}.gracePeriodMinutes`, { min: 0, max: 600 });
    const half = optionalNumber(s.halfDayThresholdMinutes, `${path}.halfDayThresholdMinutes`, { min: 1, max: 1440 });
    const full = optionalNumber(s.fullDayThresholdMinutes, `${path}.fullDayThresholdMinutes`, { min: 1, max: 1440 });
    if (grace !== undefined) shift.gracePeriodMinutes = grace;
    if (half !== undefined) shift.halfDayThresholdMinutes = half;
    if (full !== undefined) shift.fullDayThresholdMinutes = full;
    if (s.otWindows !== undefined) {
      if (!Array.isArray(s.otWindows) || s.otWindows.length > 6) bad(`${path}.otWindows`, 'Must be a list of at most 6 overtime windows');
      shift.otWindows = (s.otWindows as unknown[]).map((raw, i) => {
        const w = requireObject(raw, `${path}.otWindows[${i}]`);
        if (typeof w.start !== 'string' || !TIME_RE.test(w.start)) bad(`${path}.otWindows[${i}].start`, 'Must be HH:mm');
        if (typeof w.end !== 'string' || !TIME_RE.test(w.end)) bad(`${path}.otWindows[${i}].end`, 'Must be HH:mm');
        if ((hhmmToMinutes(w.end as string) ?? 0) <= (hhmmToMinutes(w.start as string) ?? 0)) bad(`${path}.otWindows[${i}]`, 'Overtime must end after it starts (same day)');
        return { start: w.start as string, end: w.end as string };
      });
    }
    if (shift.halfDayThresholdMinutes !== undefined && shift.fullDayThresholdMinutes !== undefined && shift.halfDayThresholdMinutes > shift.fullDayThresholdMinutes) {
      bad(`${path}.halfDayThresholdMinutes`, 'Must not exceed the full-day threshold');
    }
    return shift;
  };

  if (body.shift !== undefined) out.shift = validateShiftFields(body.shift, 'shift');
  if (body.shifts !== undefined) {
    if (!Array.isArray(body.shifts) || body.shifts.length > 10) bad('shifts', 'Must be a list of at most 10 shifts');
    const seen = new Set<string>();
    out.shifts = (body.shifts as unknown[]).map((raw, i) => {
      const fields = validateShiftFields(raw, `shifts[${i}]`);
      if (!fields.shiftName) bad(`shifts[${i}].shiftName`, 'Required');
      const key = String(fields.shiftName).toLowerCase();
      if (seen.has(key)) bad(`shifts[${i}].shiftName`, 'Shift names must be unique');
      seen.add(key);
      const merged = normalizeShift(fields, DEFAULT_SETTINGS.shift);
      if (merged.halfDayThresholdMinutes > merged.fullDayThresholdMinutes) bad(`shifts[${i}].halfDayThresholdMinutes`, 'Must not exceed the full-day threshold');
      return merged;
    });
  }
  if (body.overtime !== undefined) {
    const o = requireObject(body.overtime, 'overtime');
    out.overtime = {};
    if (o.enabled !== undefined) out.overtime.enabled = Boolean(o.enabled);
    const h = optionalNumber(o.hoursPerDay, 'overtime.hoursPerDay', { min: 1, max: 24 });
    if (h !== undefined) out.overtime.hoursPerDay = h;
  }
  if (body.offDayWork !== undefined) {
    const w = requireObject(body.offDayWork, 'offDayWork');
    out.offDayWork = {};
    for (const kind of ['weeklyOff', 'paidHoliday'] as const) {
      if (w[kind] === undefined) continue;
      const k = requireObject(w[kind], `offDayWork.${kind}`);
      if (k.recognition === undefined) continue;
      if (k.recognition !== 'MANUAL' && k.recognition !== 'AUTOMATIC') bad(`offDayWork.${kind}.recognition`, 'MANUAL or AUTOMATIC');
      out.offDayWork[kind] = { recognition: k.recognition };
    }
  }
  if (body.leaves !== undefined) {
    const l = requireObject(body.leaves, 'leaves');
    out.leaves = {};
    for (const f of ['casualLeave', 'sickLeave', 'earnedLeave', 'compOff'] as const) {
      const v = optionalNumber(l[f], `leaves.${f}`, { min: 0, max: 366 });
      if (v !== undefined) out.leaves[f] = v;
    }
  }
  if (body.weeklyOffDays !== undefined) {
    if (!Array.isArray(body.weeklyOffDays)) bad('weeklyOffDays', 'Must be an array');
    const days = (body.weeklyOffDays as unknown[]).map((d) => String(d).trim().toUpperCase());
    if (days.some((d) => !(DAY_NAME_LIST as readonly string[]).includes(d))) bad('weeklyOffDays', `Allowed: ${DAY_NAME_LIST.join(', ')}`);
    out.weeklyOffDays = Array.from(new Set(days));
  }
  if (body.scheduler !== undefined) {
    const sc = requireObject(body.scheduler, 'scheduler');
    out.scheduler = {};
    if (sc.enabled !== undefined) out.scheduler.enabled = Boolean(sc.enabled);
    const i = optionalNumber(sc.intervalMinutes, 'scheduler.intervalMinutes', { min: 1, max: 1440 });
    if (i !== undefined) out.scheduler.intervalMinutes = Math.floor(i);
  }
  if (body.ess !== undefined) {
    const e = requireObject(body.ess, 'ess');
    if (e.geofenceMode !== undefined) {
      if (e.geofenceMode !== 'ENFORCE' && e.geofenceMode !== 'OFF') bad('ess.geofenceMode', 'ENFORCE or OFF');
      out.ess = { geofenceMode: e.geofenceMode };
    }
  }
  if (body.statutory !== undefined) {
    const st = requireObject(body.statutory, 'statutory');
    out.statutory = {};
    if (st.pf !== undefined) {
      const p = requireObject(st.pf, 'statutory.pf');
      const pf: any = {};
      const employee = optionalNumber(p.employeeRatePct, 'statutory.pf.employeeRatePct', { min: 0.01, max: 100 });
      const eps = optionalNumber(p.epsRatePct, 'statutory.pf.epsRatePct', { min: 0, max: 100 });
      const admin = optionalNumber(p.adminRatePct, 'statutory.pf.adminRatePct', { min: 0, max: 10 });
      const edli = optionalNumber(p.edliRatePct, 'statutory.pf.edliRatePct', { min: 0, max: 10 });
      if (employee !== undefined) pf.employeeRatePct = employee;
      if (eps !== undefined) pf.epsRatePct = eps;
      if (admin !== undefined) pf.adminRatePct = admin;
      if (edli !== undefined) pf.edliRatePct = edli;
      if (pf.employeeRatePct !== undefined && pf.epsRatePct !== undefined && pf.epsRatePct > pf.employeeRatePct) {
        bad('statutory.pf.epsRatePct', 'Pension share cannot exceed the PF rate');
      }
      if (p.ceilings !== undefined) {
        if (!Array.isArray(p.ceilings) || p.ceilings.length < 1 || p.ceilings.length > 20) bad('statutory.pf.ceilings', 'Must be a list of 1 to 20 ceilings');
        const seen = new Set<string>();
        const rows = (p.ceilings as unknown[]).map((raw, i) => {
          const r = requireObject(raw, `statutory.pf.ceilings[${i}]`);
          if (!isValidBusinessDate(r.from)) bad(`statutory.pf.ceilings[${i}].from`, 'Must be YYYY-MM-DD');
          const ceiling = optionalNumber(r.ceiling, `statutory.pf.ceilings[${i}].ceiling`, { min: 1, max: 10_000_000 });
          if (ceiling === undefined) bad(`statutory.pf.ceilings[${i}].ceiling`, 'Required');
          return { from: r.from as string, ceiling: ceiling as number };
        }).sort((a, b) => a.from.localeCompare(b.from));
        for (const r of rows) {
          if (seen.has(r.from)) bad('statutory.pf.ceilings', `Two ceilings start on ${r.from}`);
          seen.add(r.from);
        }
        rows[0] = { ...rows[0], from: BASE_PF_CEILING_DATE }; // the first row is "in force from the beginning"
        pf.ceilings = rows;
      }
      out.statutory.pf = pf;
    }
  }
  // holidays are managed ONLY through the dedicated add/remove operations.

  const full = out.shift?.fullDayThresholdMinutes;
  const half = out.shift?.halfDayThresholdMinutes;
  if (full !== undefined && half !== undefined && half > full) bad('shift.halfDayThresholdMinutes', 'Must not exceed the full-day threshold');
  return out;
}

export function validateHolidayInput(input: unknown): Omit<CompanyHoliday, 'id'> {
  const b = requireObject(input);
  if (!isValidBusinessDate(b.date)) throw ApiError.validation('Holiday date must be YYYY-MM-DD.', [{ field: 'date', issue: 'Invalid date' }]);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) throw ApiError.validation('Holiday name is required (max 120 chars).', [{ field: 'name', issue: 'Invalid' }]);
  const type = (b.type ?? 'NATIONAL') as HolidayType;
  if (!['NATIONAL', 'FESTIVAL', 'OPTIONAL'].includes(type)) throw ApiError.validation('Invalid holiday type.', [{ field: 'type', issue: 'Invalid value' }]);
  // Explicit semantics: NATIONAL/FESTIVAL are paid days off; OPTIONAL is paid only when explicitly flagged.
  const paid = b.paid === undefined ? type !== 'OPTIONAL' : Boolean(b.paid);
  return { date: b.date as string, name, type, paid };
}

const flatten = (prefix: string, obj: Record<string, any>, into: Record<string, any>) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(`${prefix}.${k}`, v, into);
    else into[`${prefix}.${k}`] = v;
  }
};

export class PolicyService {
  // Read cache backed by MongoDB. MongoDB is the source of truth; the cache exists so
  // synchronous call sites can read policy, and it is refreshed periodically and after every write.
  private cache: HRMSPolicySettings = DEFAULT_SETTINGS;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;

  public async init(): Promise<void> {
    await this.refreshFromDb();
    mongoose.connection.on('connected', () => void this.refreshFromDb());
    mongoose.connection.on('reconnected', () => void this.refreshFromDb());
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshFromDb(), ENV.POLICY_REFRESH_MS);
      this.timer.unref?.();
    }
  }

  public async refreshFromDb(): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    try {
      let doc = await PolicyModel.findOne({ key: POLICY_KEY }).lean();
      if (!doc) {
        await PolicyModel.updateOne({ key: POLICY_KEY }, { $setOnInsert: { ...DEFAULT_SETTINGS, key: POLICY_KEY } }, { upsert: true });
        doc = await PolicyModel.findOne({ key: POLICY_KEY }).lean();
      }
      this.cache = mergeWithDefaults(doc);
      this.loaded = true;
    } catch (err) {
      console.warn('[PolicyService] Could not refresh policy from MongoDB; keeping last known value:', err);
    }
  }

  /** True once policy has been read from MongoDB at least once (payroll refuses to run on defaults). */
  public isLoaded(): boolean {
    return this.loaded;
  }

  public getSettings(): HRMSPolicySettings {
    return this.cache;
  }

  public async updateSettings(input: unknown): Promise<HRMSPolicySettings> {
    requireDb();
    const partial = validatePolicyUpdate(input);
    const $set: Record<string, any> = { updatedAt: new Date().toISOString() };
    for (const [section, value] of Object.entries(partial)) {
      if (Array.isArray(value)) $set[section] = value;
      else if (value && typeof value === 'object') flatten(section, value as any, $set);
      else $set[section] = value;
    }
    await PolicyModel.updateOne({ key: POLICY_KEY }, { $set, $inc: { version: 1 }, $setOnInsert: { key: POLICY_KEY } }, { upsert: true });
    await this.refreshFromDb();
    return this.cache;
  }

  public async addHoliday(input: unknown): Promise<CompanyHoliday> {
    requireDb();
    const h = validateHolidayInput(input);
    const holiday: CompanyHoliday = { id: `hol_${randomUUID()}`, ...h };
    // Atomic: one holiday per date (replace), no read-modify-write of the whole array.
    await PolicyModel.updateOne({ key: POLICY_KEY }, { $pull: { holidays: { date: h.date } } });
    await PolicyModel.updateOne(
      { key: POLICY_KEY },
      { $push: { holidays: { $each: [holiday], $sort: { date: 1 } } }, $inc: { version: 1 }, $set: { updatedAt: new Date().toISOString() } }
    );
    await this.refreshFromDb();
    return holiday;
  }

  public findHoliday(id: string): CompanyHoliday | undefined {
    return this.cache.holidays.find((h) => h.id === id);
  }

  public async removeHoliday(id: string): Promise<void> {
    requireDb();
    await PolicyModel.updateOne(
      { key: POLICY_KEY },
      { $pull: { holidays: { id } }, $inc: { version: 1 }, $set: { updatedAt: new Date().toISOString() } }
    );
    await this.refreshFromDb();
  }
}

export const policyService = new PolicyService();
