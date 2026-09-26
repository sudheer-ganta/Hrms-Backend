export interface ShiftConfig {
  shiftName: string;
  startTime: string; // "09:00"
  endTime: string;   // "18:00"
  gracePeriodMinutes: number; // 15
  halfDayThresholdMinutes: number; // 240 (4 hours)
  fullDayThresholdMinutes: number; // 480 (8 hours)
  breakDurationMinutes: number; // 60
}

export interface OvertimeConfig {
  enabled: boolean;
  minOvertimeMinutes: number; // 30
  overtimeAfterHours: number; // 8
  defaultRateMultiplier: number; // 1.5 = time-and-a-half. Per-employee otRatePerHour overrides this.
}

export interface CompanyHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  type: 'NATIONAL' | 'FESTIVAL' | 'OPTIONAL';
}

export interface SyncSchedulerConfig {
  enabled: boolean;
  intervalMinutes: number; // 5, 10, 15, 30, 60
}

export interface HRMSPolicySettings {
  shift: ShiftConfig;
  overtime: OvertimeConfig;
  weeklyOffDays: string[]; // ['Sunday']
  holidays: CompanyHoliday[];
  scheduler: SyncSchedulerConfig;
  updatedAt: string;
}
