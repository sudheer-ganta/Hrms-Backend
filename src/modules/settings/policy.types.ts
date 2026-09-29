export interface ShiftConfig {
  shiftName: string;
  startTime: string; // "09:00"
  endTime: string;   // "18:00"
  gracePeriodMinutes: number; // 15
  halfDayThresholdMinutes: number; // 180 (3 hours)
  fullDayThresholdMinutes: number; // 360 (6 hours)
  minCheckoutForFullDay?: string; // "16:00" - checkout at or after this time is counted as Full Day Present (P)
  breakDurationMinutes: number; // 60
}

export interface OvertimeConfig {
  enabled: boolean;
}

export interface CompanyHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  type: 'NATIONAL' | 'FESTIVAL' | 'OPTIONAL';
}

export interface LeaveQuotaConfig {
  casualLeave: number; // e.g. 12
  sickLeave: number;   // e.g. 12
  earnedLeave: number; // e.g. 15
  compOff?: number;    // e.g. 2
}

export interface SyncSchedulerConfig {
  enabled: boolean;
  intervalMinutes: number; // 5, 10, 15, 30, 60
}

export interface HRMSPolicySettings {
  shift: ShiftConfig;
  overtime: OvertimeConfig;
  leaves: LeaveQuotaConfig;
  weeklyOffDays: string[]; // ['Sunday']
  holidays: CompanyHoliday[];
  scheduler: SyncSchedulerConfig;
  updatedAt: string;
}
