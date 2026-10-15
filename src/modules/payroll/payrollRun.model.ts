import mongoose, { Schema, Document } from 'mongoose';
import { IPayrollRun, IPayrollSnapshot } from './payrollRun.types.js';

export interface PayrollRunDocument extends IPayrollRun, Document {}
export interface PayrollSnapshotDocument extends IPayrollSnapshot, Document {}

const PayrollRunSchema = new Schema<PayrollRunDocument>(
  {
    month: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, enum: ['CLOSED', 'REOPENED'], default: 'CLOSED', index: true },
    currentVersion: { type: Number, default: 1 },
    employeeCount: { type: Number, required: true },
    totalNetPaid: { type: Number, required: true },
    closedAt: { type: Date, required: true },
    closedBy: { type: String, required: true },
    reopenedAt: { type: Date },
    reopenedBy: { type: String },
    reopenReason: { type: String },
    history: {
      type: [
        {
          _id: false,
          action: { type: String, enum: ['CLOSED', 'REOPENED'], required: true },
          byUser: { type: String, required: true },
          at: { type: Date, required: true },
          version: { type: Number },
          reason: { type: String },
        },
      ],
      default: [],
    },
    // legacy, read-only
    snapshot: { type: [Schema.Types.Mixed], select: false } as any,
  },
  { timestamps: true, collection: 'payroll_runs' }
);

// Snapshots are append-only: one document per (month, version), never updated.
const PayrollSnapshotSchema = new Schema<PayrollSnapshotDocument>(
  {
    month: { type: String, required: true, index: true, immutable: true },
    version: { type: Number, required: true, immutable: true },
    snapshot: { type: [Schema.Types.Mixed], required: true, immutable: true } as any,
    employeeCount: { type: Number, required: true, immutable: true },
    totalNetPaid: { type: Number, required: true, immutable: true },
    closedAt: { type: Date, required: true, immutable: true },
    closedBy: { type: String, required: true, immutable: true },
    rulesVersion: { type: String, required: true, immutable: true },
    policyVersion: { type: Number, required: true, immutable: true },
    policy: { type: Schema.Types.Mixed, immutable: true },
    calcMeta: { type: Schema.Types.Mixed, immutable: true },
  },
  { timestamps: true, collection: 'payroll_snapshots' }
);
PayrollSnapshotSchema.index({ month: 1, version: 1 }, { unique: true });

export const PayrollRunModel = mongoose.model<PayrollRunDocument>('PayrollRun', PayrollRunSchema);
export const PayrollSnapshotModel = mongoose.model<PayrollSnapshotDocument>('PayrollSnapshot', PayrollSnapshotSchema);
