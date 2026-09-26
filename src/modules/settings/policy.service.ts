import fs from 'fs';
import path from 'path';
import { HRMSPolicySettings, CompanyHoliday } from './policy.types.js';

const SETTINGS_FILE = path.resolve(process.cwd(), 'data', 'hrms_policy_settings.json');

const DEFAULT_SETTINGS: HRMSPolicySettings = {
  shift: {
    shiftName: 'General Shift',
    startTime: '09:00',
    endTime: '18:00',
    gracePeriodMinutes: 15,
    halfDayThresholdMinutes: 240,
    fullDayThresholdMinutes: 480,
    breakDurationMinutes: 60,
  },
  overtime: {
    enabled: true,
    minOvertimeMinutes: 30,
    overtimeAfterHours: 8,
    defaultRateMultiplier: 1.5,
  },
  weeklyOffDays: ['Sunday'],
  holidays: [],
  scheduler: {
    enabled: true,
    intervalMinutes: 5,
  },
  updatedAt: new Date().toISOString(),
};

export class PolicyService {
  public getSettings(): HRMSPolicySettings {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Deep-merge nested config objects so new fields (added after a settings
        // file was last saved) fall back to their default instead of vanishing.
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          shift: { ...DEFAULT_SETTINGS.shift, ...parsed.shift },
          overtime: { ...DEFAULT_SETTINGS.overtime, ...parsed.overtime },
          scheduler: { ...DEFAULT_SETTINGS.scheduler, ...parsed.scheduler },
        };
      }
    } catch (err) {
      console.warn('Could not read settings file, using defaults:', err);
    }
    return DEFAULT_SETTINGS;
  }

  public updateSettings(partial: Partial<HRMSPolicySettings>): HRMSPolicySettings {
    const current = this.getSettings();
    const updated: HRMSPolicySettings = {
      ...current,
      ...partial,
      shift: partial.shift ? { ...current.shift, ...partial.shift } : current.shift,
      overtime: partial.overtime ? { ...current.overtime, ...partial.overtime } : current.overtime,
      scheduler: partial.scheduler ? { ...current.scheduler, ...partial.scheduler } : current.scheduler,
      updatedAt: new Date().toISOString(),
    };

    try {
      const dir = path.dirname(SETTINGS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save settings file:', err);
    }

    return updated;
  }

  public addHoliday(holiday: Omit<CompanyHoliday, 'id'>): CompanyHoliday {
    const current = this.getSettings();
    const newHoliday: CompanyHoliday = {
      id: `hol_${Date.now()}`,
      ...holiday,
    };
    const holidays = [...current.holidays.filter((h) => h.date !== holiday.date), newHoliday].sort(
      (a, b) => a.date.localeCompare(b.date)
    );
    this.updateSettings({ holidays });
    return newHoliday;
  }

  public removeHoliday(holidayId: string): boolean {
    const current = this.getSettings();
    const holidays = current.holidays.filter((h) => h.id !== holidayId);
    this.updateSettings({ holidays });
    return true;
  }
}

export const policyService = new PolicyService();
