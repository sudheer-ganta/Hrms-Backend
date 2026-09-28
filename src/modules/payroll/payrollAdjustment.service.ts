import mongoose from 'mongoose';
import { PayrollAdjustmentModel } from './payrollAdjustment.model.js';
import { EmployeeOtAdjustment } from './payrollAdjustment.types.js';
import { localStore } from '../../config/localStore.js';

class PayrollAdjustmentService {
  public async getAdjustments(
    month: string
  ): Promise<Record<string, EmployeeOtAdjustment>> {
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      try {
        const doc = (await PayrollAdjustmentModel.findOne({ month }).lean()) as any;
        if (doc && doc.adjustments) {
          return doc.adjustments as Record<string, EmployeeOtAdjustment>;
        }
      } catch (err) {
        console.warn('MongoDB getAdjustments query failed, using localStore fallback:', err);
      }
    }
    return localStore.getAdjustments(month) || {};
  }

  public async saveAdjustments(
    month: string,
    adjustments: Record<string, EmployeeOtAdjustment>,
    updatedBy: string = 'Admin'
  ): Promise<Record<string, EmployeeOtAdjustment>> {
    // Always persist to fallback localStore
    localStore.saveAdjustments(month, adjustments);

    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      try {
        await PayrollAdjustmentModel.findOneAndUpdate(
          { month },
          {
            month,
            adjustments,
            updatedBy,
            updatedAt: new Date(),
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        console.warn('MongoDB saveAdjustments update failed, local store updated:', err);
      }
    }

    return adjustments;
  }

  public async clearAdjustments(month: string): Promise<void> {
    localStore.clearAdjustments(month);
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      try {
        await PayrollAdjustmentModel.deleteOne({ month });
      } catch (err) {
        console.warn('MongoDB clearAdjustments delete failed:', err);
      }
    }
  }
}

export const payrollAdjustmentService = new PayrollAdjustmentService();
