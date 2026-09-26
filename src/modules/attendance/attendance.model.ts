import mongoose, { Schema } from 'mongoose';
import { AttendanceRecordDocument } from './attendance.types.js';

const AttendanceRecordSchema = new Schema<AttendanceRecordDocument>(
  {
    sourceId: {
      type: String,
      required: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    sourceName: {
      type: String,
      required: true,
      trim: true,
    },
    employeeCode: {
      type: String,
      required: true,
      index: true,
      trim: true,
      uppercase: true,
    },
    employeeName: {
      type: String,
      required: true,
      trim: true,
      default: 'Unknown Employee',
    },
    punchDateTime: {
      type: Date,
      required: true,
      index: true,
    },
    entryDate: {
      type: String,
      required: true,
      index: true,
      trim: true, // Format: YYYY-MM-DD
    },
    entryTime: {
      type: String,
      required: true,
      trim: true, // Format: HH:mm:ss
    },
    machineId: {
      type: String,
      required: false,
      default: '0',
      trim: true,
    },
    machineFlag: {
      type: String,
      default: null,
    },
    syncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    vendorRecordHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'attendance_records',
  }
);

// Compound Unique index to strictly prevent duplicate punches
AttendanceRecordSchema.index(
  { sourceId: 1, employeeCode: 1, punchDateTime: 1, machineId: 1 },
  { unique: true }
);

// Composite query indexes for fast filtering
AttendanceRecordSchema.index({ sourceId: 1, entryDate: 1 });
AttendanceRecordSchema.index({ entryDate: 1, employeeCode: 1 });

export const AttendanceModel = mongoose.model<AttendanceRecordDocument>(
  'AttendanceRecord',
  AttendanceRecordSchema
);
