import mongoose, { Schema, Document } from 'mongoose';
import { ATTENDANCE_ORIGINS, AttendanceOrigin } from './attendanceStatus.js';

/**
 * AttendanceDay: the ONE daily record per employee per business date.
 *
 * It stores FACTS (first in, last out, measured minutes, vendor verdict, contributing
 * sources/origins, adjustment references). The final STATUS is produced by
 * resolveDay() with the CURRENT policy at read time, so a holiday or threshold change
 * can never leave a stale stored verdict.
 */
export interface IAttendanceDay {
  employeeCode: string;
  businessDate: string; // YYYY-MM-DD IST
  employeeName?: string;
  firstIn: string | null;
  lastOut: string | null;
  workMinutes: number;
  punchCount: number;
  vendorStatus: string | null;
  vendorOvertimeMinutes: number | null;
  vendorLateMinutes: number | null;
  siteId: string | null;
  sourceIds: string[];
  origins: AttendanceOrigin[];
  manualOverride: boolean;
  adjustmentIds: string[];
  recomputedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AttendanceDayDocument extends IAttendanceDay, Document {}

const AttendanceDaySchema = new Schema<AttendanceDayDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    businessDate: { type: String, required: true, immutable: true },
    employeeName: { type: String, trim: true },
    firstIn: { type: String, default: null },
    lastOut: { type: String, default: null },
    workMinutes: { type: Number, default: 0 },
    punchCount: { type: Number, default: 0 },
    vendorStatus: { type: String, default: null },
    vendorOvertimeMinutes: { type: Number, default: null },
    vendorLateMinutes: { type: Number, default: null },
    siteId: { type: String, default: null, lowercase: true },
    sourceIds: { type: [String], default: [] },
    origins: { type: [String], enum: ATTENDANCE_ORIGINS, default: [] },
    manualOverride: { type: Boolean, default: false },
    adjustmentIds: { type: [String], default: [] },
    recomputedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'attendance_days' }
);

// The invariant of the whole design: one row per employee per business date.
AttendanceDaySchema.index({ employeeCode: 1, businessDate: 1 }, { unique: true });
AttendanceDaySchema.index({ businessDate: 1, siteId: 1 });

export const AttendanceDayModel = mongoose.model<AttendanceDayDocument>('AttendanceDay', AttendanceDaySchema);
