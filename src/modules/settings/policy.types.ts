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
  /**
   * THE overtime rule: the minutes between an employee's first and last punch that fall inside one of these
   * same-day windows are overtime. Time outside every window (the shift itself, a break, the gap before OT starts)
   * is never overtime. A shift without windows has no overtime.
   */
  otWindows: TimeWindow[];
}

export interface TimeWindow {
  start: string; // "19:00" IST wall clock
  end: string;   // "21:00"
}

export interface OvertimeConfig {
  enabled: boolean;
  hoursPerDay: number; // OT hourly-wage divisor (default 8)
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

/** One row of the PF wage ceiling history: this ceiling applies from `from` (YYYY-MM-DD) until the next row. */
export interface PfCeilingRow {
  from: string;
  ceiling: number;
}

/**
 * Provident Fund rules the government can change. All rates are percentages of the PF wages
 * (e.g. 12 means 12%). The ceiling is date-effective so a change mid-month is prorated (payroll/pfRule.ts).
 */
export interface PfConfig {
  employeeRatePct: number; // employee share; the employer pays the same amount
  epsRatePct: number;      // part of the employer's share that goes to the pension scheme (EPS)
  adminRatePct: number;    // employer PF admin charge
  edliRatePct: number;     // employer EDLI contribution
  /** Ascending by date; the first row is always 1900-01-01 (in force "from the beginning"). */
  ceilings: PfCeilingRow[];
}

export interface StatutoryConfig {
  pf: PfConfig;
}

export interface HRMSPolicySettings {
  version: number; // incremented on every change; stored in payroll snapshots
  shift: ShiftConfig; // the default shift, used by everyone not assigned to a named shift below
  /** Additional named shifts. An employee whose profile `shiftName` matches one uses it instead of `shift`. */
  shifts: ShiftConfig[];
  overtime: OvertimeConfig;
  offDayWork: OffDayWorkConfig;
  leaves: LeaveQuotaConfig;
  weeklyOffDays: DayName[]; // ['SUNDAY']
  holidays: CompanyHoliday[];
  scheduler: SyncSchedulerConfig;
  ess: EssConfig;
  statutory: StatutoryConfig;
  updatedAt: string;
}
