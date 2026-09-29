import mongoose, { Schema, Document } from 'mongoose';
import { EmployeeOtAdjustment } from './payrollAdjustment.types.js';

export interface IPayrollAdjustmentAudit {
  month: string;
  action: 'SAVE' | 'CLEAR';
  performedBy: string;
  performedAt: Date;
  previousAdjustments: Record<string, EmployeeOtAdjustment>;
  newAdjustments: Record<string, EmployeeOtAdjustment>;
}

export interface PayrollAdjustmentAuditDocument extends IPayrollAdjustmentAudit, Document {}

// Append-only audit trail for manual OT/hours overrides. Records are never
// updated or deleted — this is the permanent history of who changed what and
// when, independent of the "current" PayrollAdjustmentModel document (which
// only reflects what's currently being applied and gets overwritten/cleared
// as admins make corrections).
const PayrollAdjustmentAuditSchema = new Schema<PayrollAdjustmentAuditDocument>(
  {
    month: { type: String, required: true, index: true },
    action: { type: String, required: true, enum: ['SAVE', 'CLEAR'] },
    performedBy: { type: String, required: true },
    performedAt: { type: Date, required: true, default: Date.now, index: true },
    previousAdjustments: { type: Schema.Types.Mixed, default: {} },
    newAdjustments: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: 'payroll_adjustment_audit',
  }
);

export const PayrollAdjustmentAuditModel =
  mongoose.models.PayrollAdjustmentAudit ||
  mongoose.model<PayrollAdjustmentAuditDocument>('PayrollAdjustmentAudit', PayrollAdjustmentAuditSchema);
