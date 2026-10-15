import { PayrollRunModel, PayrollSnapshotModel } from './payrollRun.model.js';
import { EmployeePayrollSummary } from './payroll.types.js';
import { PAYROLL_RULES } from './payroll.config.js';
import { policyService } from '../settings/policy.service.js';
import { ApiError } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { istMonth, monthOf } from '../../utils/istTime.js';

class PayrollRunService {
  /**
   * The frozen snapshot for a month if (and only if) the month is CLOSED.
   * Fails closed: if MongoDB is unreachable we cannot know whether the month is locked,
   * so we refuse instead of recomputing a closed month from other data.
   */
  public async getClosedRun(month: string): Promise<{ snapshot: EmployeePayrollSummary[]; version: number } | null> {
    requireDb();
    const run: any = await PayrollRunModel.findOne({ month, status: 'CLOSED' }).select('+snapshot').lean();
    if (!run) return null;
    const snap: any = await PayrollSnapshotModel.findOne({ month, version: run.currentVersion }).lean();
    if (snap) return { snapshot: snap.snapshot, version: snap.version };
    if (Array.isArray(run.snapshot) && run.snapshot.length) return { snapshot: run.snapshot, version: run.currentVersion || 1 }; // legacy
    throw ApiError.rule(`Payroll for ${month} is marked CLOSED but its snapshot is missing. Contact support before continuing.`);
  }

  public async isClosed(month: string): Promise<boolean> {
    requireDb();
    return !!(await PayrollRunModel.exists({ month, status: 'CLOSED' }));
  }

  /** Blocks any write that would change a closed payroll month. */
  public async assertMonthOpen(month: string, what = 'This change'): Promise<void> {
    if (await this.isClosed(month)) {
      throw ApiError.rule(`${what} affects ${month}, whose payroll is CLOSED. Reopen the month first.`);
    }
  }

  public async assertDatesOpen(dates: string[], what?: string): Promise<void> {
    for (const m of new Set(dates.map(monthOf))) await this.assertMonthOpen(m, what);
  }

  /** Months in `dates` that are closed (for skip-and-report flows such as vendor sync). */
  public async closedMonthsAmong(dates: string[]): Promise<Set<string>> {
    requireDb();
    const months = Array.from(new Set(dates.map(monthOf)));
    if (!months.length) return new Set();
    const rows = await PayrollRunModel.find({ month: { $in: months }, status: 'CLOSED' }).select('month').lean();
    return new Set(rows.map((r: any) => r.month));
  }

  public async getRunStatus(month: string): Promise<any> {
    requireDb();
    const run: any = await PayrollRunModel.findOne({ month }).lean();
    if (!run) return { month, status: 'OPEN' };
    return this.toStatus(run, true);
  }

  private toStatus(run: any, withHistory: boolean) {
    return {
      month: run.month,
      status: run.status,
      currentVersion: run.currentVersion ?? 1,
      employeeCount: run.employeeCount,
      totalNetPaid: run.totalNetPaid,
      closedAt: run.closedAt,
      closedBy: run.closedBy,
      reopenedAt: run.reopenedAt,
      reopenedBy: run.reopenedBy,
      reopenReason: run.reopenReason,
      ...(withHistory ? { history: run.history } : {}),
    };
  }

  public async listRuns(): Promise<any[]> {
    requireDb();
    const runs = await PayrollRunModel.find({}).sort({ month: -1 }).lean();
    return runs.map((r) => this.toStatus(r, false));
  }

  /** Snapshot versions of a month (audit trail). */
  public async listVersions(month: string): Promise<any[]> {
    requireDb();
    const docs = await PayrollSnapshotModel.find({ month }).sort({ version: -1 }).select('-snapshot').lean();
    return docs;
  }

  public async getVersion(month: string, version: number): Promise<any> {
    requireDb();
    const doc = await PayrollSnapshotModel.findOne({ month, version }).lean();
    if (!doc) throw ApiError.notFound(`No snapshot version ${version} for ${month}.`);
    return doc;
  }

  /** Validates a computed payroll before it is allowed to be frozen. */
  public validateForClose(month: string, snapshot: EmployeePayrollSummary[]): void {
    if (month >= istMonth()) {
      throw ApiError.rule(`Payroll for ${month} cannot be closed yet: the month has not ended (current IST month is ${istMonth()}).`);
    }
    if (!snapshot.length) throw ApiError.rule('There are no employees to close payroll for.');
    const problems: string[] = [];
    for (const s of snapshot) {
      const nums = [s.netPayable, s.grossEarnings, s.totalDeductions, s.lopDeduction, s.otEarnings];
      if (nums.some((x) => !Number.isFinite(x))) problems.push(`${s.empCode}: non-numeric amount`);
      if (s.elapsedDays !== s.monthDays) problems.push(`${s.empCode}: month not fully elapsed`);
      if (s.netPayable < 0) problems.push(`${s.empCode}: negative net pay`);
    }
    if (problems.length) {
      throw ApiError.rule(`Payroll validation failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
    }
  }

  /**
   * Freezes a month as a NEW immutable snapshot version. A reopened month gets
   * version N+1; earlier versions are kept untouched for audit.
   */
  public async closeMonth(month: string, snapshot: EmployeePayrollSummary[], closedBy: string): Promise<any> {
    requireDb();
    this.validateForClose(month, snapshot);

    const existing: any = await PayrollRunModel.findOne({ month }).lean();
    if (existing && existing.status === 'CLOSED') {
      throw ApiError.conflict(`${month} is already closed. Reopen it first if you need to re-run the close.`);
    }
    const last: any = await PayrollSnapshotModel.findOne({ month }).sort({ version: -1 }).select('version').lean();
    const version = Math.max(last?.version || 0, existing?.currentVersion || 0) + 1;
    const now = new Date();
    const policy = policyService.getSettings();
    const totalNetPaid = snapshot.reduce((sum, s) => sum + (s.netPayable || 0), 0);

    await PayrollSnapshotModel.create({
      month, version, snapshot, employeeCount: snapshot.length, totalNetPaid, closedAt: now, closedBy,
      rulesVersion: PAYROLL_RULES.version, policyVersion: policy.version, policy,
      calcMeta: { generatedAt: now.toISOString(), source: 'attendance_days+employees', monthDays: snapshot[0]?.monthDays ?? 0 },
    });

    const historyEntry = { action: 'CLOSED' as const, byUser: closedBy, at: now, version };
    if (existing) {
      // Conditional update: only succeeds if nobody closed it meanwhile.
      const res = await PayrollRunModel.findOneAndUpdate(
        { month, status: 'REOPENED' },
        { $set: { status: 'CLOSED', currentVersion: version, employeeCount: snapshot.length, totalNetPaid, closedAt: now, closedBy }, $push: { history: historyEntry } },
        { new: true }
      ).lean();
      if (!res) throw ApiError.conflict(`${month} was closed by another administrator.`);
      return this.toStatus(res, true);
    }
    const created = await PayrollRunModel.create({
      month, status: 'CLOSED', currentVersion: version, employeeCount: snapshot.length, totalNetPaid, closedAt: now, closedBy, history: [historyEntry],
    });
    return this.toStatus(created.toObject(), true);
  }

  /** Reopens a closed month (keeps every snapshot version). A reason is mandatory. */
  public async reopenMonth(month: string, reopenedBy: string, reason: string): Promise<any> {
    requireDb();
    if (!reason || reason.trim().length < 5) {
      throw ApiError.validation('A reason (at least 5 characters) is required to reopen a closed payroll month.', [{ field: 'reason', issue: 'Required' }]);
    }
    const now = new Date();
    const res = await PayrollRunModel.findOneAndUpdate(
      { month, status: 'CLOSED' },
      {
        $set: { status: 'REOPENED', reopenedAt: now, reopenedBy, reopenReason: reason.trim() },
        $push: { history: { action: 'REOPENED', byUser: reopenedBy, at: now, reason: reason.trim() } },
      },
      { new: true }
    ).lean();
    if (!res) throw ApiError.rule(`${month} is not currently closed.`);
    return this.toStatus(res, true);
  }
}

export const payrollRunService = new PayrollRunService();
