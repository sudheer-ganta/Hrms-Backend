import mongoose from 'mongoose';
import { PayrollRunModel } from './payrollRun.model.js';
import { EmployeePayrollSummary } from './payroll.types.js';

class PayrollRunService {
  private assertDbConnected(): void {
    if (mongoose.connection.readyState !== 1) {
      throw new Error(
        'Cannot close or reopen payroll while the database is disconnected — this is a permanent record and must not be written to a temporary local file.'
      );
    }
  }

  /**
   * Returns the CLOSED run for a month, or null if the month is open (live) or
   * was closed and then reopened. Only a genuinely CLOSED record locks the numbers.
   */
  public async getClosedRun(month: string): Promise<{ snapshot: EmployeePayrollSummary[] } | null> {
    if (mongoose.connection.readyState !== 1) return null;
    const run = await PayrollRunModel.findOne({ month, status: 'CLOSED' }).lean();
    return run ? { snapshot: run.snapshot } : null;
  }

  public async getRunStatus(month: string): Promise<any> {
    this.assertDbConnected();
    const run = await PayrollRunModel.findOne({ month }).lean();
    if (!run) {
      return { month, status: 'OPEN' };
    }
    return {
      month: run.month,
      status: run.status,
      employeeCount: run.employeeCount,
      totalNetPaid: run.totalNetPaid,
      closedAt: run.closedAt,
      closedBy: run.closedBy,
      reopenedAt: run.reopenedAt,
      reopenedBy: run.reopenedBy,
      history: run.history,
    };
  }

  public async listRuns(): Promise<any[]> {
    this.assertDbConnected();
    const runs = await PayrollRunModel.find({}).sort({ month: -1 }).lean();
    return runs.map((run) => ({
      month: run.month,
      status: run.status,
      employeeCount: run.employeeCount,
      totalNetPaid: run.totalNetPaid,
      closedAt: run.closedAt,
      closedBy: run.closedBy,
      reopenedAt: run.reopenedAt,
      reopenedBy: run.reopenedBy,
    }));
  }

  /**
   * Locks in a permanent snapshot for a month. The caller supplies the already-
   * computed summaries (from payrollService) — this service only persists them.
   */
  public async closeMonth(
    month: string,
    snapshot: EmployeePayrollSummary[],
    closedBy: string
  ): Promise<any> {
    this.assertDbConnected();

    const existing = await PayrollRunModel.findOne({ month });
    if (existing && existing.status === 'CLOSED') {
      throw new Error(`${month} is already closed. Reopen it first if you need to re-run the close.`);
    }

    const totalNetPaid = snapshot.reduce((sum, s) => sum + (s.netPayable || 0), 0);
    const now = new Date();
    const historyEntry = { action: 'CLOSED' as const, byUser: closedBy, at: now };

    if (existing) {
      existing.status = 'CLOSED';
      existing.snapshot = snapshot;
      existing.employeeCount = snapshot.length;
      existing.totalNetPaid = totalNetPaid;
      existing.closedAt = now;
      existing.closedBy = closedBy;
      existing.history.push(historyEntry);
      await existing.save();
      return existing;
    }

    const created = await PayrollRunModel.create({
      month,
      status: 'CLOSED',
      snapshot,
      employeeCount: snapshot.length,
      totalNetPaid,
      closedAt: now,
      closedBy,
      history: [historyEntry],
    });
    return created;
  }

  /**
   * Reopens a closed month so it goes back to live calculation. The old locked
   * snapshot stays in the record (and in `history`) as an audit trail rather
   * than being deleted.
   */
  public async reopenMonth(month: string, reopenedBy: string): Promise<any> {
    this.assertDbConnected();

    const existing = await PayrollRunModel.findOne({ month });
    if (!existing || existing.status !== 'CLOSED') {
      throw new Error(`${month} is not currently closed.`);
    }

    const now = new Date();
    existing.status = 'REOPENED';
    existing.reopenedAt = now;
    existing.reopenedBy = reopenedBy;
    existing.history.push({ action: 'REOPENED', byUser: reopenedBy, at: now });
    await existing.save();
    return existing;
  }
}

export const payrollRunService = new PayrollRunService();
