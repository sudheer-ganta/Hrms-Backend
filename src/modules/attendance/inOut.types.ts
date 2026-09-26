import { Document } from 'mongoose';

export interface IInOutRecord {
  sourceId: string;
  sourceName: string;
  employeeCode: string;
  employeeName: string;
  date: string; // YYYY-MM-DD
  inTime: string; // "08:56" or "--:--"
  outTime: string; // "17:37" or "--:--"
  workTime: string; // "08:11"
  workMinutes: number; // 491
  overTime: string; // "00:00"
  breakTime: string; // "00:00"
  lateIn: string; // "00:00"
  earlyOut: string; // "00:00"
  status: 'P' | 'P/2' | 'A' | 'W' | 'H' | string;
  statusLabel?: string;
  remark: string;
  syncedAt: Date;
  recordKey: string; // unique key: sourceId + employeeCode + date
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InOutRecordDocument extends IInOutRecord, Document {}

export interface InOutQueryFilters {
  sourceId?: string;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  employeeCode?: string;
  search?: string;
  status?: string; // e.g. "P", "A", "P/2"
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface InOutPaginationResult {
  data: IInOutRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  summary: {
    totalRecords: number;
    presentCount: number;
    absentCount: number;
    halfDayCount: number;
    weeklyOffCount: number;
    totalWorkMinutes: number;
    avgWorkMinutes: number;
    totalOvertimeMinutes: number;
    lateArrivalsCount: number;
  };
}

export interface EmployeeTimesheetDay {
  date: string; // YYYY-MM-DD
  inTime: string;
  outTime: string;
  workTime: string;
  workMinutes: number;
  status: string;
  lateIn: string;
  overTime: string;
}

export interface EmployeeTimesheet {
  employeeCode: string;
  employeeName: string;
  sourceId: string;
  sourceName: string;
  days: Record<string, EmployeeTimesheetDay>;
  totalDaysPresent: number;
  totalDaysAbsent: number;
  totalWorkMinutes: number;
  totalOvertimeMinutes: number;
  avgHoursPerDay: string;
}
