import mongoose, { Schema, Document } from 'mongoose';
import { IPayrollAdjustment } from './payrollAdjustment.types.js';

export interface PayrollAdjustmentDocument extends IPayrollAdjustment, Document {}

const PayrollAdjustmentSchema = new Schema<PayrollAdjustmentDocument>(
  {
    month: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    adjustments: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    updatedBy: {
      type: String,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

export const PayrollAdjustmentModel =
  mongoose.models.PayrollAdjustment ||
  mongoose.model<PayrollAdjustmentDocument>('PayrollAdjustment', PayrollAdjustmentSchema);
