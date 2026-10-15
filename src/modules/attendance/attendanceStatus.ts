/**
 * Canonical attendance status. The frontend consumes ONLY these values.
 * Vendor codes (P, P/2, A, W, H, ...) are stored separately as `vendorStatus`.
 */
export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'HALF_DAY',
  'ABSENT',
  'WEEKLY_OFF',
  'HOLIDAY',
  'LEAVE_PAID',
  'LEAVE_UNPAID',
  'WORK_FROM_HOME',
  'ON_DUTY',
  'MISSED_PUNCH',
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_ORIGINS = ['DEVICE', 'ESS_WEB', 'REGULARIZATION', 'LEAVE', 'WFH', 'ON_DUTY'] as const;
export type AttendanceOrigin = (typeof ATTENDANCE_ORIGINS)[number];

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  HALF_DAY: 'Half Day',
  ABSENT: 'Absent',
  WEEKLY_OFF: 'Weekly Off',
  HOLIDAY: 'Holiday',
  LEAVE_PAID: 'Paid Leave',
  LEAVE_UNPAID: 'Unpaid Leave',
  WORK_FROM_HOME: 'Work From Home',
  ON_DUTY: 'On Duty',
  MISSED_PUNCH: 'Missed Punch',
};

/** Days paid as fully worked (counted in payroll presentDays). */
export const PRESENT_LIKE: readonly AttendanceStatus[] = ['PRESENT', 'WORK_FROM_HOME', 'ON_DUTY', 'MISSED_PUNCH'];
/** Company/employee days off (neither worked nor LOP). */
export const OFF_DAYS: readonly AttendanceStatus[] = ['WEEKLY_OFF', 'HOLIDAY'];
/** Days that cost Loss of Pay. */
export const LOP_LIKE: readonly AttendanceStatus[] = ['ABSENT', 'LEAVE_UNPAID'];

export const isPresentLike = (s?: AttendanceStatus | null): boolean => !!s && PRESENT_LIKE.includes(s);
export const isOffDay = (s?: AttendanceStatus | null): boolean => !!s && OFF_DAYS.includes(s);
export const isLop = (s?: AttendanceStatus | null): boolean => !!s && LOP_LIKE.includes(s);

/** Vendor (e-TimeOffice) status code → canonical status, or null when the vendor code carries no verdict. */
export const mapVendorStatus = (code?: string | null): AttendanceStatus | 'UNKNOWN_ABSENT' | null => {
  const c = String(code ?? '').trim().toUpperCase();
  switch (c) {
    case 'P':
    case 'PRESENT':
      return 'PRESENT';
    case 'P/2':
    case 'HALF':
    case '1/2P':
      return 'HALF_DAY';
    case 'W':
    case 'WO':
      return 'WEEKLY_OFF';
    case 'H':
    case 'HL':
      return 'HOLIDAY';
    case 'L':
    case 'PL':
    case 'CL':
      return 'LEAVE_PAID';
    case 'A':
      return 'UNKNOWN_ABSENT'; // the vendor does not know our policy; resolver re-derives
    default:
      return null;
  }
};
