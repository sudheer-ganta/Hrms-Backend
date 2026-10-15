import mongoose, { Schema, Document } from 'mongoose';
import { HRMSPolicySettings } from './policy.types.js';

export interface PolicyDocument extends Omit<HRMSPolicySettings, 'updatedAt'>, Document {
  key?: string;
  updatedAt?: any;
}

// Defaults here MUST match DEFAULT_SETTINGS in policy.service.ts (single source: the service).
const PolicySchema = new Schema<PolicyDocument>(
  {
    key: { type: String, required: true, unique: true, default: 'global_hrms_policy' },
    version: { type: Number, default: 1 },
    shift: {
      shiftName: { type: String, default: 'General Shift' },
      startTime: { type: String, default: '09:00' },
      endTime: { type: String, default: '17:30' },
      gracePeriodMinutes: { type: Number, default: 60 },
      halfDayThresholdMinutes: { type: Number, default: 180 },
      fullDayThresholdMinutes: { type: Number, default: 360 },
      minCheckoutForFullDay: { type: String, default: '16:00' },
      breakDurationMinutes: { type: Number, default: 60 },
    },
    overtime: {
      enabled: { type: Boolean, default: true },
      hoursPerDay: { type: Number, default: 8 },
    },
    offDayWork: {
      weeklyOff: { recognition: { type: String, enum: ['MANUAL', 'AUTOMATIC'], default: 'MANUAL' } },
      paidHoliday: { recognition: { type: String, enum: ['MANUAL', 'AUTOMATIC'], default: 'MANUAL' } },
    },
    leaves: {
      casualLeave: { type: Number, default: 12 },
      sickLeave: { type: Number, default: 12 },
      earnedLeave: { type: Number, default: 15 },
      compOff: { type: Number, default: 2 },
    },
    weeklyOffDays: { type: [String], default: ['SUNDAY'] },
    holidays: [
      {
        _id: false,
        id: { type: String, required: true },
        date: { type: String, required: true },
        name: { type: String, required: true },
        type: { type: String, enum: ['NATIONAL', 'FESTIVAL', 'OPTIONAL'], default: 'NATIONAL' },
        paid: { type: Boolean, default: true },
      },
    ],
    scheduler: {
      enabled: { type: Boolean, default: true },
      intervalMinutes: { type: Number, default: 5 },
    },
    ess: {
      geofenceMode: { type: String, enum: ['ENFORCE', 'OFF'], default: 'ENFORCE' },
    },
    updatedAt: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'policies' } // updatedAt is an ISO string maintained by the service
);

export const PolicyModel = mongoose.model<PolicyDocument>('Policy', PolicySchema);
