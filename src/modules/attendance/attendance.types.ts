import { Document } from 'mongoose';
import { AttendanceOrigin } from './attendanceStatus.js';

/**
 * RawPunch: an immutable fact that "employee E was at/with source S at instant T".
 * Biometric (DEVICE) and ESS web punches are both raw punches. Nothing edits them.
 */
export interface IAttendanceRecord {
  sourceId: string;            // vendor account / site the punch came from
  sourceName: string;
  siteId?: string;             // canonical site
  employeeCode: string;        // canonical (normalized) employee code
  vendorEmployeeCode?: string; // code as the vendor knows it
  employeeName: string;
  punchDateTime: Date;         // the instant (UTC)
  entryDate: string;           // business date (IST) YYYY-MM-DD
  entryTime: string;           // IST wall clock HH:mm:ss
  machineId: string;
  machineFlag: string | null;
  origin: AttendanceOrigin;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  meta?: Record<string, unknown>;
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
  origin?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface AttendancePaginationResult {
  data: IAttendanceRecord[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
