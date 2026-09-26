import mongoose, { Schema, Document } from 'mongoose';
import { HRMSPolicySettings } from './policy.types.js';

export interface PolicyDocument extends HRMSPolicySettings, Document {
  key?: string;
}

const PolicySchema = new Schema<PolicyDocument>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global_hrms_policy',
    },
    shift: {
      shiftName: { type: String, default: 'General Shift' },
      startTime: { type: String, default: '09:00' },
      endTime: { type: String, default: '18:00' },
      gracePeriodMinutes: { type: Number, default: 15 },
      halfDayThresholdMinutes: { type: Number, default: 240 },
      fullDayThresholdMinutes: { type: Number, default: 480 },
      breakDurationMinutes: { type: Number, default: 60 },
    },
    overtime: {
      enabled: { type: Boolean, default: true },
      minOvertimeMinutes: { type: Number, default: 30 },
      overtimeAfterHours: { type: Number, default: 8 },
    },
    weeklyOffDays: {
      type: [String],
      default: ['Sunday'],
    },
    holidays: [
      {
        id: { type: String, required: true },
        date: { type: String, required: true },
        name: { type: String, required: true },
        type: { type: String, default: 'NATIONAL' },
      },
    ],
    scheduler: {
      enabled: { type: Boolean, default: true },
      intervalMinutes: { type: Number, default: 5 },
    },
    updatedAt: { type: String },
  },
  {
    timestamps: true,
    collection: 'policies',
  }
);

export const PolicyModel = mongoose.model<PolicyDocument>(
  'Policy',
  PolicySchema
);
