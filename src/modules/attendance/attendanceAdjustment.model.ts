import mongoose, { Schema, Document } from 'mongoose';
import { AdjustmentKind } from './attendanceResolver.js';

/**
 * AttendanceAdjustment: the effect of an approved request on ONE employee-day.
 * Reversible: revoking the request sets status REVOKED and the day is recomputed;
 * nothing is ever overwritten in place.
 */
export interface IAttendanceAdjustment {
  employeeCode: string;
  businessDate: string;
  kind: AdjustmentKind;
  requestId: string;
  inTime?: string;
  outTime?: string;
  leaveType?: string;
  paid: boolean;
  fraction: number;
  status: 'ACTIVE' | 'REVOKED';
  reason?: string;
  approvedBy: string;
  approvedAt: Date;
  revokedBy?: string;
  revokedAt?: Date;
  revokeReason?: string;
}

export interface AttendanceAdjustmentDocument extends IAttendanceAdjustment, Document {}

const AttendanceAdjustmentSchema = new Schema<AttendanceAdjustmentDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, uppercase: true },
    businessDate: { type: String, required: true },
    kind: { type: String, required: true, enum: ['MISSED_PUNCH', 'LEAVE', 'WORK_FROM_HOME', 'ON_DUTY'] },
    requestId: { type: String, required: true, index: true },
    inTime: { type: String },
    outTime: { type: String },
    leaveType: { type: String },
    paid: { type: Boolean, default: true },
    fraction: { type: Number, default: 1 },
    status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', index: true },
    reason: { type: String },
    approvedBy: { type: String, required: true },
    approvedAt: { type: Date, required: true },
    revokedBy: { type: String },
    revokedAt: { type: Date },
    revokeReason: { type: String },
  },
  { timestamps: true, collection: 'attendance_adjustments' }
);


// A request produces at most one adjustment per day (idempotent apply).
AttendanceAdjustmentSchema.index({ requestId: 1, businessDate: 1 }, { unique: true });
AttendanceAdjustmentSchema.index({ employeeCode: 1, businessDate: 1, status: 1 });

export const AttendanceAdjustmentModel = mongoose.model<AttendanceAdjustmentDocument>('AttendanceAdjustment', AttendanceAdjustmentSchema);
