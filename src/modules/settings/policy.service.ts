import mongoose from 'mongoose';
import { PolicyModel } from './policy.model.js';
import { HRMSPolicySettings, CompanyHoliday, ShiftConfig } from './policy.types.js';

const POLICY_KEY = 'global_hrms_policy';

const DEFAULT_SETTINGS: HRMSPolicySettings = {
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
  overtime: {
    enabled: true,
    hoursPerDay: 8,
  },
  leaves: {
    casualLeave: 12,
    sickLeave: 12,
    earnedLeave: 15,
    compOff: 2,
  },
  weeklyOffDays: ['Sunday'],
  holidays: [],
  scheduler: {
    enabled: true,
    intervalMinutes: 5,
  },
  updatedAt: new Date().toISOString(),
};

/**
 * The standard work-day length, in hours, derived dynamically from the
 * configured shift start/end time (e.g. 09:00-17:30 = 8.5h). This is the
 * single source of truth for wage-rate and overtime-threshold math — it
 * replaces the old hardcoded/duplicated assumptions that used to live
 * separately on the client and server.
 */
export function getShiftStandardHours(shift: ShiftConfig): number {
  const [startHour, startMin] = (shift?.startTime || '09:00').split(':').map(Number);
  const [endHour, endMin] = (shift?.endTime || '17:30').split(':').map(Number);
  const startMinutes = (startHour || 0) * 60 + (startMin || 0);
  let endMinutes = (endHour || 0) * 60 + (endMin || 0);
  if (endMinutes <= startMinutes) endMinutes += 24 * 60; // overnight shift wrap-around
  return (endMinutes - startMinutes) / 60;
}

// Explicitly allow-lists known fields for each sub-object instead of
// spreading whatever happens to be stored in Mongo. A field removed from
// HRMSPolicySettings (like the old overtimeAfterHours/defaultRateMultiplier)
// can otherwise keep leaking out of already-persisted documents forever,
// even after it's deleted from the schema and type.
function mergeWithDefaults(doc: any): HRMSPolicySettings {
  const clean = doc || {};
  return {
    ...DEFAULT_SETTINGS,
    weeklyOffDays: clean.weeklyOffDays ?? DEFAULT_SETTINGS.weeklyOffDays,
    holidays: clean.holidays ?? DEFAULT_SETTINGS.holidays,
    updatedAt: clean.updatedAt ?? DEFAULT_SETTINGS.updatedAt,
    shift: { ...DEFAULT_SETTINGS.shift, ...(clean.shift || {}) },
    overtime: {
      enabled: clean.overtime?.enabled ?? DEFAULT_SETTINGS.overtime.enabled,
      hoursPerDay: clean.overtime?.hoursPerDay > 0 ? clean.overtime.hoursPerDay : DEFAULT_SETTINGS.overtime.hoursPerDay,
    },
    leaves: { ...DEFAULT_SETTINGS.leaves, ...(clean.leaves || {}) },
    scheduler: { ...DEFAULT_SETTINGS.scheduler, ...(clean.scheduler || {}) },
  };
}

export class PolicyService {
  // In-memory read cache backed by MongoDB — the DB is the single source of
  // truth; this cache only exists so the many synchronous call sites across
  // the codebase don't all need to become async. It is refreshed from Mongo
  // on connect/reconnect and rewritten on every successful write.
  private cache: HRMSPolicySettings = DEFAULT_SETTINGS;
  private initialized = false;

  public async init(): Promise<void> {
    await this.refreshFromDb();
    mongoose.connection.on('connected', () => this.refreshFromDb());
    mongoose.connection.on('reconnected', () => this.refreshFromDb());
  }

  private async refreshFromDb(): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const doc = await PolicyModel.findOne({ key: POLICY_KEY }).lean();
      if (doc) {
        this.cache = mergeWithDefaults(doc as any);
      } else if (!this.initialized) {
        const created = await PolicyModel.create({ key: POLICY_KEY, ...DEFAULT_SETTINGS });
        this.cache = mergeWithDefaults(created.toObject());
      }
      this.initialized = true;
    } catch (err) {
      console.warn('[PolicyService] Could not load policy settings from MongoDB, using in-memory defaults/cache:', err);
    }
  }

  public getSettings(): HRMSPolicySettings {
    return this.cache;
  }

  public async updateSettings(partial: Partial<HRMSPolicySettings>): Promise<HRMSPolicySettings> {
    const current = this.cache;
    const updated: HRMSPolicySettings = {
      ...current,
      ...partial,
      shift: partial.shift ? { ...current.shift, ...partial.shift } : current.shift,
      overtime: partial.overtime ? { ...current.overtime, ...partial.overtime } : current.overtime,
      leaves: partial.leaves ? { ...current.leaves, ...partial.leaves } : current.leaves,
      scheduler: partial.scheduler ? { ...current.scheduler, ...partial.scheduler } : current.scheduler,
      updatedAt: new Date().toISOString(),
    };

    if (mongoose.connection.readyState !== 1) {
      throw new Error('Cannot save policy settings while the database is disconnected.');
    }

    await PolicyModel.findOneAndUpdate(
      { key: POLICY_KEY },
      { $set: { ...updated, key: POLICY_KEY } },
      { upsert: true, new: true }
    );

    this.cache = updated;
    return updated;
  }

  public async addHoliday(holiday: Omit<CompanyHoliday, 'id'>): Promise<CompanyHoliday> {
    const current = this.cache;
    const newHoliday: CompanyHoliday = {
      id: `hol_${Date.now()}`,
      ...holiday,
    };
    const holidays = [...current.holidays.filter((h) => h.date !== holiday.date), newHoliday].sort(
      (a, b) => a.date.localeCompare(b.date)
    );
    await this.updateSettings({ holidays });
    return newHoliday;
  }

  public async removeHoliday(holidayId: string): Promise<boolean> {
    const current = this.cache;
    const holidays = current.holidays.filter((h) => h.id !== holidayId);
    await this.updateSettings({ holidays });
    return true;
  }
}

export const policyService = new PolicyService();
