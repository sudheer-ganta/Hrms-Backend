import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { PolicyModel } from './policy.model.js';
import { HRMSPolicySettings, CompanyHoliday, ShiftConfig, HolidayType } from './policy.types.js';
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
    breakDurationMinutes: 60,
  },
  overtime: { enabled: true, hoursPerDay: 8 },
  offDayWork: { weeklyOff: { recognition: 'MANUAL' }, paidHoliday: { recognition: 'MANUAL' } },
  leaves: { casualLeave: 12, sickLeave: 12, earnedLeave: 15, compOff: 2 },
  weeklyOffDays: ['SUNDAY'],
  holidays: [],
  scheduler: { enabled: true, intervalMinutes: 5 },
  ess: { geofenceMode: 'ENFORCE' },
  updatedAt: new Date(0).toISOString(),
};

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

// Explicit allow-list per sub-object so removed legacy fields can never leak out of stored documents.
function mergeWithDefaults(doc: any): HRMSPolicySettings {
  const c = doc || {};
  const D = DEFAULT_SETTINGS;
  const positive = (v: any, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  const shift = { ...D.shift, ...(c.shift || {}) };
  return {
    version: positive(c.version, 1),
    shift: {
      shiftName: String(shift.shiftName),
      startTime: TIME_RE.test(shift.startTime) ? shift.startTime : D.shift.startTime,
      endTime: TIME_RE.test(shift.endTime) ? shift.endTime : D.shift.endTime,
      gracePeriodMinutes: Number(shift.gracePeriodMinutes ?? D.shift.gracePeriodMinutes),
      halfDayThresholdMinutes: positive(shift.halfDayThresholdMinutes, D.shift.halfDayThresholdMinutes),
      fullDayThresholdMinutes: positive(shift.fullDayThresholdMinutes, D.shift.fullDayThresholdMinutes),
      minCheckoutForFullDay: shift.minCheckoutForFullDay && TIME_RE.test(shift.minCheckoutForFullDay) ? shift.minCheckoutForFullDay : undefined,
      breakDurationMinutes: Number(shift.breakDurationMinutes ?? D.shift.breakDurationMinutes),
    },
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

  if (body.shift !== undefined) {
    const s = requireObject(body.shift, 'shift');
    const shift: any = {};
    if (s.shiftName !== undefined) shift.shiftName = String(s.shiftName).trim().slice(0, 80) || bad('shift.shiftName', 'Required');
    for (const f of ['startTime', 'endTime'] as const) {
      if (s[f] !== undefined) { if (typeof s[f] !== 'string' || !TIME_RE.test(s[f] as string)) bad(`shift.${f}`, 'Must be HH:mm'); shift[f] = s[f]; }
    }
    if (s.minCheckoutForFullDay !== undefined) {
      if (s.minCheckoutForFullDay === '' || s.minCheckoutForFullDay === null) shift.minCheckoutForFullDay = '';
      else if (typeof s.minCheckoutForFullDay !== 'string' || !TIME_RE.test(s.minCheckoutForFullDay)) bad('shift.minCheckoutForFullDay', 'Must be HH:mm');
      else shift.minCheckoutForFullDay = s.minCheckoutForFullDay;
    }
    const grace = optionalNumber(s.gracePeriodMinutes, 'shift.gracePeriodMinutes', { min: 0, max: 600 });
    const half = optionalNumber(s.halfDayThresholdMinutes, 'shift.halfDayThresholdMinutes', { min: 1, max: 1440 });
    const full = optionalNumber(s.fullDayThresholdMinutes, 'shift.fullDayThresholdMinutes', { min: 1, max: 1440 });
    const brk = optionalNumber(s.breakDurationMinutes, 'shift.breakDurationMinutes', { min: 0, max: 600 });
    if (grace !== undefined) shift.gracePeriodMinutes = grace;
    if (half !== undefined) shift.halfDayThresholdMinutes = half;
    if (full !== undefined) shift.fullDayThresholdMinutes = full;
    if (brk !== undefined) shift.breakDurationMinutes = brk;
    out.shift = shift;
  }
  if (body.overtime !== undefined) {
    const o = requireObject(body.overtime, 'overtime');
    out.overtime = {};
    if (o.enabled !== undefined) out.overtime.enabled = Boolean(o.enabled);
    const h = optionalNumber(o.hoursPerDay, 'overtime.hoursPerDay', { min: 1, max: 24 });
    if (h !== undefined) out.overtime.hoursPerDay = h;
    if (o.recognition !== undefined) {
      if (o.recognition !== 'MANUAL' && o.recognition !== 'AUTOMATIC') throw ApiError.validation('overtime.recognition must be MANUAL or AUTOMATIC.');
      out.overtime.recognition = o.recognition;
    }
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
