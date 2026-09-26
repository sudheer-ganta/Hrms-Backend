import mongoose, { Schema, Document } from 'mongoose';
import { IPayrollRun } from './payrollRun.types.js';

export interface PayrollRunDocument extends IPayrollRun, Document {}

const PayrollRunSchema = new Schema<PayrollRunDocument>(
  {
    month: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['CLOSED', 'REOPENED'],
      default: 'CLOSED',
      index: true,
    },
    // Snapshot is stored as-is (Mixed) since it mirrors the EmployeePayrollSummary
    // shape exactly at close time — it must never be recomputed or re-derived.
    // Cast to `any`: Mongoose's Mixed-array typing doesn't reconcile cleanly with
    // the strongly-typed EmployeePayrollSummary[] field it's declared against.
    snapshot: {
      type: [Schema.Types.Mixed],
      required: true,
    } as any,
    employeeCount: {
      type: Number,
      required: true,
    },
    totalNetPaid: {
      type: Number,
      required: true,
    },
    closedAt: {
      type: Date,
      required: true,
    },
    closedBy: {
      type: String,
      required: true,
    },
    reopenedAt: {
      type: Date,
    },
    reopenedBy: {
      type: String,
    },
    history: {
      type: [
        {
          action: { type: String, enum: ['CLOSED', 'REOPENED'], required: true },
          byUser: { type: String, required: true },
          at: { type: Date, required: true },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: 'payroll_runs',
  }
);

export const PayrollRunModel = mongoose.model<PayrollRunDocument>('PayrollRun', PayrollRunSchema);
