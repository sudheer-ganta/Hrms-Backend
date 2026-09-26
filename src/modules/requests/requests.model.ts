import mongoose, { Schema, Document } from 'mongoose';
import { AttendanceRegularizationRequest } from './requests.types.js';

export interface RequestDocument extends Omit<AttendanceRegularizationRequest, 'id'>, Document {
  id: string;
}

const RequestSchema = new Schema<RequestDocument>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    empCode: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    empName: {
      type: String,
      required: true,
      trim: true,
    },
    requestType: {
      type: String,
      required: true,
      enum: ['MISSED_PUNCH', 'LEAVE', 'WORK_FROM_HOME', 'ON_DUTY'],
    },
    date: {
      type: String,
      required: true,
      index: true,
    },
    inTime: { type: String },
    outTime: { type: String },
    leaveType: {
      type: String,
      enum: ['CASUAL_LEAVE', 'SICK_LEAVE', 'EARNED_LEAVE'],
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    createdAt: {
      type: String,
      required: true,
    },
    reviewedAt: { type: String },
    reviewComment: { type: String },
  },
  {
    timestamps: true,
    collection: 'requests',
  }
);

RequestSchema.index({ empCode: 1, date: 1 });

export const RequestModel = mongoose.model<RequestDocument>(
  'EmployeeRequest',
  RequestSchema
);
