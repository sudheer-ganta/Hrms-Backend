import { DayName } from '../../utils/istTime.js';

/**
 * THE one definition of attendance/overtime policy. Resolver, payroll, dashboard,
 * ESS punching and the UI all read these values; nothing else may hard-code them.
 */
export interface ShiftConfig {
  shiftName: string;
  startTime: string; // "09:00" IST wall clock
  endTime: string;   // "17:30"; if earlier than startTime the shift is overnight
  gracePeriodMinutes: number;
  halfDayThresholdMinutes: number; // worked >= this => at least HALF_DAY
  fullDayThresholdMinutes: number; // worked >= this => PRESENT
  minCheckoutForFullDay?: string;  // checkout at/after this time (with >= half-day minutes) => PRESENT
  breakDurationMinutes: number;
}

export interface OvertimeConfig {
  enabled: boolean;
  hoursPerDay: number; // OT hourly-wage divisor (default 8)
  recognition?: 'MANUAL' | 'AUTOMATIC'; // MANUAL = 0 by default, HR enters in OT Calculator; AUTOMATIC = derived from biometric punches
}

/**
 * What happens when someone works on a weekly off or a paid holiday. ONE rule, read by the resolver;
 * payroll, dashboard, timesheet and the portal only consume the resolved day.
 *  MANUAL    - nothing is derived; HR enters the days worked in the OT calculator (previous behavior).
 *  AUTOMATIC - the resolver credits the day from punches using the shift's half/full-day thresholds
 *              (full day = 1, half day = 0.5) and payroll pays them at the Sunday/off-day rate.
 */
export type OffDayRecognition = 'MANUAL' | 'AUTOMATIC';
export interface OffDayWorkConfig {
  /** Work on a configured weekly-off day. */
  weeklyOff: { recognition: OffDayRecognition };
  /** Work on a paid company holiday. Kept separate: the business may treat the two differently. */
  paidHoliday: { recognition: OffDayRecognition };
}

export type HolidayType = 'NATIONAL' | 'FESTIVAL' | 'OPTIONAL';

export interface CompanyHoliday {
  id: string;
  date: string; // YYYY-MM-DD (IST business date)
  name: string;
  type: HolidayType;
  /**
   * true  => company day-off, paid for everyone (NATIONAL / FESTIVAL default).
   * false => NOT a company day-off; a normal working day (employees may opt to take it).
   * Legacy holidays stored without this flag are treated as paid, which preserves the
   * previous behavior where every holiday was a paid day off.
   */
  paid: boolean;
}

export interface LeaveQuotaConfig {
  casualLeave: number;
  sickLeave: number;
  earnedLeave: number;
  compOff: number;
}

export interface SyncSchedulerConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface EssConfig {
  /** ENFORCE: punches outside every configured site geofence are rejected. OFF: no location check. */
  geofenceMode: 'ENFORCE' | 'OFF';
}

export interface HRMSPolicySettings {
  version: number; // incremented on every change; stored in payroll snapshots
  shift: ShiftConfig;
  overtime: OvertimeConfig;
  offDayWork: OffDayWorkConfig;
  leaves: LeaveQuotaConfig;
  weeklyOffDays: DayName[]; // ['SUNDAY']
  holidays: CompanyHoliday[];
  scheduler: SyncSchedulerConfig;
  ess: EssConfig;
  updatedAt: string;
}
