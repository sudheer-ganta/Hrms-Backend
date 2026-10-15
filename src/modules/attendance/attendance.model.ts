import mongoose, { Schema } from 'mongoose';
import { AttendanceRecordDocument } from './attendance.types.js';
import { ATTENDANCE_ORIGINS } from './attendanceStatus.js';

// Collection: attendance_records (the RawPunch store). Rows are append-only: key fields are immutable.
const AttendanceRecordSchema = new Schema<AttendanceRecordDocument>(
  {
    sourceId: { type: String, required: true, index: true, trim: true, lowercase: true, immutable: true },
    sourceName: { type: String, required: true, trim: true },
    siteId: { type: String, trim: true, lowercase: true, index: true },
    employeeCode: { type: String, required: true, index: true, trim: true, uppercase: true, immutable: true },
    vendorEmployeeCode: { type: String, trim: true },
    employeeName: { type: String, required: true, trim: true, default: 'Unknown Employee' },
    punchDateTime: { type: Date, required: true, index: true, immutable: true },
    entryDate: { type: String, required: true, index: true, trim: true },
    entryTime: { type: String, required: true, trim: true },
    machineId: { type: String, default: '0', trim: true, immutable: true },
    machineFlag: { type: String, default: null },
    origin: { type: String, enum: ATTENDANCE_ORIGINS, default: 'DEVICE', index: true },
    latitude: { type: Number },
    longitude: { type: Number },
    accuracy: { type: Number },
    meta: { type: Schema.Types.Mixed },
    syncedAt: { type: Date, default: Date.now, index: true },
    vendorRecordHash: { type: String, required: true, unique: true, index: true, immutable: true },
  },
  { timestamps: true, collection: 'attendance_records' }
);

AttendanceRecordSchema.index({ sourceId: 1, employeeCode: 1, punchDateTime: 1, machineId: 1 }, { unique: true });
AttendanceRecordSchema.index({ sourceId: 1, entryDate: 1 });
AttendanceRecordSchema.index({ entryDate: 1, employeeCode: 1 });

export const AttendanceModel = mongoose.model<AttendanceRecordDocument>('AttendanceRecord', AttendanceRecordSchema);
