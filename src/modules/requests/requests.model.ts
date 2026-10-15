import mongoose, { Schema, Document } from 'mongoose';
import { AttendanceRegularizationRequest, REQUEST_STATUSES, REQUEST_TYPES, LEAVE_TYPES } from './requests.types.js';

export interface RequestDocument extends AttendanceRegularizationRequest, Document {
  id: string;
}

const RequestSchema = new Schema<RequestDocument>(
  {
    id: { type: String, required: true, unique: true, index: true, immutable: true },
    empCode: { type: String, required: true, index: true, trim: true, uppercase: true, immutable: true },
    empName: { type: String, required: true, trim: true },
    requestType: { type: String, required: true, enum: REQUEST_TYPES, immutable: true },
    date: { type: String, required: true, index: true },
    endDate: { type: String },
    halfDay: { type: Boolean },
    days: { type: Number },
    leaveYear: { type: Number },
    inTime: { type: String },
    outTime: { type: String },
    leaveType: { type: String, enum: LEAVE_TYPES },
    reason: { type: String, required: true },
    status: { type: String, required: true, enum: REQUEST_STATUSES, default: 'PENDING', index: true },
    createdAt: { type: String, required: true },
    reviewedAt: { type: String },
    reviewedBy: { type: String },
    reviewComment: { type: String },
    appliedAt: { type: String },
    applyError: { type: String },
    revokedAt: { type: String },
    revokedBy: { type: String },
    revokeReason: { type: String },
  },
  { timestamps: false, collection: 'requests' }
);

RequestSchema.index({ empCode: 1, date: 1 });

export const RequestModel = mongoose.model<RequestDocument>('EmployeeRequest', RequestSchema);
