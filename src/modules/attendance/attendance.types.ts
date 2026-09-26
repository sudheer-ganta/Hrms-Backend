import { Document } from 'mongoose';

export interface IAttendanceRecord {
  sourceId: string;
  sourceName: string;
  employeeCode: string;
  employeeName: string;
  punchDateTime: Date;
  entryDate: string; // YYYY-MM-DD
  entryTime: string; // HH:mm:ss
  machineId: string;
  machineFlag: string | null;
  syncedAt: Date;
  vendorRecordHash: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AttendanceRecordDocument extends IAttendanceRecord, Document {}

export interface AttendanceQueryFilters {
  sourceId?: string;
  fromDate?: string;
  toDate?: string;
  employeeCode?: string;
  search?: string;
  machineId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface AttendancePaginationResult {
  data: IAttendanceRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface HourlyPunchDistribution {
  hour: string;
  punches: number;
  label: string;
}

export interface AttendanceStatusBreakdown {
  present: number;
  absent: number;
  halfDay: number;
  weeklyOff: number;
  total: number;
  presentPct: number;
  absentPct: number;
  halfDayPct: number;
}

export interface DashboardStatsResult {
  selectedDate: string;
  totalWorkforce: number;          // Total enrolled employees in roster
  presentCount: number;            // Present employees on selected date
  absentCount: number;             // Absent employees on selected date
  lateArrivalsCount: number;       // Late arrivals (after 9:30 AM)
  halfDayCount: number;            // Half-day records
  attendanceRate: number;          // Attendance % (e.g. 86)
  absenteeismRate: number;         // Absenteeism % (e.g. 14)
  todayPunches: number;            // Raw biometric punch volume on date
  totalRecords: number;            // Total system records
  todayActiveEmployees: number;    // Compatibility field
  lastSyncAt: Date | null;
  locationBreakdown: {
    sourceId: string;
    sourceName: string;
    totalWorkforce: number;
    presentCount: number;
    absentCount: number;
    totalPunches: number;
    todayPunches: number;
    activeEmployeesToday: number;
    attendanceRate: number;
    lastSyncStatus?: string;
    lastSyncAt?: Date | null;
  }[];
  hourlyDistribution: HourlyPunchDistribution[];
  statusBreakdown: AttendanceStatusBreakdown;
  recentPunches: IAttendanceRecord[];
}

