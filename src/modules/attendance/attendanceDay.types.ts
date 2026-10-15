import { AttendanceOrigin, AttendanceStatus } from './attendanceStatus.js';

/** One employee, one business date, one verdict. The contract every screen consumes. */
export interface AttendanceDayDTO {
  employeeCode: string;
  employeeName: string;
  businessDate: string;
  siteId: string | null;
  siteName: string | null;
  status: AttendanceStatus | null; // null only for future days
  statusLabel: string;
  firstIn: string | null;          // HH:mm IST
  lastOut: string | null;
  workMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  lateMinutes: number;
  earlyCheckoutMinutes: number;
  isWeeklyOff: boolean;
  isHoliday: boolean;
  isPaidHoliday: boolean;
  holidayName: string | null;
  offDayWorkFraction: number;
  policyVersion: number;
  vendorStatus: string | null;
  origins: AttendanceOrigin[];
  sourceIds: string[];
  manualOverride: boolean;
  adjustmentId: string | null;
  requestId: string | null;
  inProgress: boolean;
}

export interface AttendanceSummary {
  totalRecords: number;
  presentCount: number;      // PRESENT + WFH + OD + MISSED_PUNCH
  halfDayCount: number;
  absentCount: number;       // ABSENT + LEAVE_UNPAID
  leaveCount: number;        // LEAVE_PAID
  offCount: number;          // WEEKLY_OFF + HOLIDAY
  missedPunchCount: number;
  totalWorkMinutes: number;
  avgWorkMinutes: number;
  totalOvertimeMinutes: number;
  lateArrivalsCount: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AttendanceDayListResponse {
  success: true;
  data: AttendanceDayDTO[];
  pagination: Pagination;
  summary: AttendanceSummary;
}

export interface TimesheetEmployee {
  employeeCode: string;
  employeeName: string;
  siteId: string | null;
  siteName: string | null;
  days: Record<string, AttendanceDayDTO>;
  totals: {
    presentDays: number;
    halfDays: number;
    leaveDays: number;
    absentDays: number;
    offDays: number;
    missedPunchDays: number;
    workMinutes: number;
    overtimeMinutes: number;
    lateDays: number;
  };
}
