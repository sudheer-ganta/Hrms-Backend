import mongoose from 'mongoose';
import { PayrollAdjustmentModel } from './payrollAdjustment.model.js';
import { PayrollAdjustmentAuditModel, IPayrollAdjustmentAudit } from './payrollAdjustmentAudit.model.js';
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
        // A confirmed, healthy DB read is authoritative — including a genuine
        // "no adjustments saved" result. Don't let a stale local file shadow it.
        return (doc && doc.adjustments) || {};
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
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      try {
        const previous = await this.getAdjustments(month);

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

        await this.logAudit({
          month,
          action: 'SAVE',
          performedBy: updatedBy,
          performedAt: new Date(),
          previousAdjustments: previous,
          newAdjustments: adjustments,
        });

        return adjustments;
      } catch (err) {
        console.warn('MongoDB saveAdjustments update failed, falling back to localStore:', err);
      }
    }

    // Only touch the local file when the database is genuinely unreachable
    localStore.saveAdjustments(month, adjustments);
    return adjustments;
  }

  public async clearAdjustments(month: string, clearedBy: string = 'Admin'): Promise<void> {
    localStore.clearAdjustments(month);
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      try {
        const previous = await this.getAdjustments(month);
        await PayrollAdjustmentModel.deleteOne({ month });

        await this.logAudit({
          month,
          action: 'CLEAR',
          performedBy: clearedBy,
          performedAt: new Date(),
          previousAdjustments: previous,
          newAdjustments: {},
        });
      } catch (err) {
        console.warn('MongoDB clearAdjustments delete failed:', err);
      }
    }
  }

  /**
   * Permanent, append-only history of every adjustment change for a month —
   * who changed what and when. Used to answer "what did we actually pay and
   * why" if a payment is ever questioned or audited, long after the fact.
   */
  public async getAdjustmentHistory(month: string): Promise<IPayrollAdjustmentAudit[]> {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Adjustment history requires an active database connection.');
    }
    const docs = await PayrollAdjustmentAuditModel.find({ month }).sort({ performedAt: -1 }).lean();
    return docs as unknown as IPayrollAdjustmentAudit[];
  }

  private async logAudit(entry: IPayrollAdjustmentAudit): Promise<void> {
    try {
      await PayrollAdjustmentAuditModel.create(entry);
    } catch (err) {
      // The audit log itself failing must never block the actual save/clear —
      // but it's worth knowing about, since it means this change won't be
      // traceable later.
      console.error('[PayrollAdjustmentService] Failed to write audit log entry:', err);
    }
  }
}

export const payrollAdjustmentService = new PayrollAdjustmentService();
