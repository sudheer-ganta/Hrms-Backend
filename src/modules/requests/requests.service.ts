import { randomUUID } from 'crypto';
import { RequestModel } from './requests.model.js';
import {
  AttendanceRegularizationRequest, LeaveBalance, LeaveType, LEAVE_TYPES, REQUEST_TYPES, RequestType,
  ACTIVE_STATUSES, EFFECTIVE_STATUSES, RequestStatus,
} from './requests.types.js';
import { leaveDaysFor, leaveWorkingDates, datesBetween } from './leaveDays.js';
import { policyService } from '../settings/policy.service.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { payrollRunService } from '../payroll/payrollRun.service.js';
import { AttendanceAdjustmentModel } from '../attendance/attendanceAdjustment.model.js';
import { attendanceDayService } from '../attendance/attendanceDay.service.js';
import { ApiError } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { istToday } from '../../utils/istTime.js';
import { optionalDate, optionalTime, requireDate, requireEnum, requireNonEmptyString, requireObject, optionalString } from '../../utils/validate.js';

const toRequest = (doc: any): AttendanceRegularizationRequest => {
  const { _id, __v, updatedAt, ...rest } = doc;
  return rest as AttendanceRegularizationRequest;
};

const MAX_RANGE_DAYS = 31;

export class RequestsService {
  public async getRequests(filter: { empCode?: string; status?: string } = {}): Promise<AttendanceRegularizationRequest[]> {
    requireDb();
    const q: any = {};
    if (filter.empCode) q.empCode = normalizeEmpCode(filter.empCode);
    if (filter.status) q.status = filter.status;
    const docs = await RequestModel.find(q).sort({ createdAt: -1 }).lean();
    return docs.map(toRequest);
  }

  private async mustGet(id: string): Promise<AttendanceRegularizationRequest> {
    const doc = await RequestModel.findOne({ id }).lean();
    if (!doc) throw ApiError.notFound('Request not found.');
    return toRequest(doc);
  }

  /** Dates on which this request produces an attendance adjustment. */
  private effectiveDates(r: AttendanceRegularizationRequest): string[] {
    const end = r.endDate || r.date;
    if (r.requestType === 'LEAVE') return leaveWorkingDates(r.date, end, policyService.getSettings());
    if (r.requestType === 'MISSED_PUNCH') return [r.date];
    // WFH / ON_DUTY: working days only
    return leaveWorkingDates(r.date, end, policyService.getSettings());
  }

  // ----------------------------------------------------------------- create

  public async createRequest(input: unknown, actingEmpCode?: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    const body = requireObject(input);
    const empCode = normalizeEmpCode(actingEmpCode ?? body.empCode);
    if (!empCode) throw ApiError.validation('empCode is required.', [{ field: 'empCode', issue: 'Required' }]);
    const profile = await employeeMasterService.findProfile(empCode);
    if (!profile || profile.status !== 'active') throw ApiError.rule(`Employee ${empCode} is not an active employee.`);

    const requestType = requireEnum<RequestType>(body.requestType, REQUEST_TYPES, 'requestType');
    const date = requireDate(body.date, 'date');
    const endDate = optionalDate(body.endDate, 'endDate');
    const reason = requireNonEmptyString(body.reason, 'reason', 500);
    const halfDay = body.halfDay === true;
    const today = istToday();

    if (endDate && endDate < date) throw ApiError.validation('endDate must not be before date.', [{ field: 'endDate', issue: 'Before start' }]);
    const last = endDate || date;
    if (datesBetween(date, last).length > MAX_RANGE_DAYS) throw ApiError.validation(`A request may cover at most ${MAX_RANGE_DAYS} days.`, [{ field: 'endDate', issue: 'Range too long' }]);
    if (date.slice(0, 4) !== last.slice(0, 4)) throw ApiError.validation('A request cannot span two calendar years. Submit one request per year.', [{ field: 'endDate', issue: 'Spans years' }]);
    if (halfDay && (requestType !== 'LEAVE' || date !== last)) throw ApiError.validation('Half-day applies to a single-day leave only.', [{ field: 'halfDay', issue: 'Invalid' }]);
    if (requestType === 'MISSED_PUNCH') {
      if (endDate && endDate !== date) throw ApiError.validation('A missed-punch request covers a single date.', [{ field: 'endDate', issue: 'Not allowed' }]);
      if (date > today) throw ApiError.validation('A missed-punch request cannot be for a future date.', [{ field: 'date', issue: 'In the future' }]);
    }

    const inTime = optionalTime(body.inTime, 'inTime');
    const outTime = optionalTime(body.outTime, 'outTime');
    if (requestType === 'MISSED_PUNCH' && !inTime && !outTime) {
      throw ApiError.validation('Provide the missing in-time and/or out-time.', [{ field: 'inTime', issue: 'Required' }]);
    }

    let leaveType: LeaveType | undefined;
    if (requestType === 'LEAVE') leaveType = requireEnum<LeaveType>(body.leaveType, LEAVE_TYPES, 'leaveType');

    await payrollRunService.assertDatesOpen([date, last], 'This request');

    // One adjustment per employee-day: no overlap with any open or effective request.
    const candidates = await RequestModel.find({ empCode, status: { $in: ACTIVE_STATUSES }, date: { $lte: last } }).lean();
    const overlapping = candidates.find((r: any) => (r.endDate || r.date) >= date);
    if (overlapping) {
      throw ApiError.conflict(`A ${String(overlapping.status).toLowerCase()} request already covers ${overlapping.date}${overlapping.endDate ? ` to ${overlapping.endDate}` : ''}.`);
    }

    const policy = policyService.getSettings();
    let days: number | undefined;
    if (requestType === 'LEAVE') {
      days = leaveDaysFor(date, last, policy, halfDay);
      if (days === 0) throw ApiError.rule('The selected dates are all weekly offs or holidays; no leave is needed.');
      if (leaveType !== 'UNPAID_LEAVE') {
        const bal = await this.getLeaveBalance(empCode, Number(date.slice(0, 4)));
        const left = bal.balances[leaveType as Exclude<LeaveType, 'UNPAID_LEAVE'>].available;
        if (days > left) throw ApiError.rule(`Insufficient ${leaveType!.replace(/_/g, ' ').toLowerCase()} balance: ${left} day(s) left, ${days} requested.`);
      }
    }

    const doc: AttendanceRegularizationRequest = {
      id: `req_${randomUUID()}`,
      empCode,
      empName: profile.name, // never trust a client-supplied name
      requestType,
      date,
      ...(endDate && endDate !== date ? { endDate } : {}),
      ...(halfDay ? { halfDay: true } : {}),
      ...(days !== undefined ? { days, leaveYear: Number(date.slice(0, 4)) } : {}),
      ...(inTime ? { inTime } : {}),
      ...(outTime ? { outTime } : {}),
      ...(leaveType ? { leaveType } : {}),
      reason,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    await RequestModel.create(doc);
    return doc;
  }

  // -------------------------------------------------------------- lifecycle

  /** PENDING → APPROVED → APPLIED. Failure to apply leaves it APPROVED (retryable); it is never swallowed. */
  public async approve(id: string, reviewer: string, comment?: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    const req = await this.mustGet(id);
    if (req.status !== 'PENDING') {
      throw ApiError.conflict(`Only a PENDING request can be approved (current status: ${req.status}).`);
    }
    const dates = this.effectiveDates(req);
    await payrollRunService.assertDatesOpen([req.date, req.endDate || req.date], 'Approving this request');

    if (req.requestType === 'LEAVE' && req.leaveType && req.leaveType !== 'UNPAID_LEAVE') {
      const bal = await this.getLeaveBalance(req.empCode, req.leaveYear ?? Number(req.date.slice(0, 4)));
      const left = bal.balances[req.leaveType as Exclude<LeaveType, 'UNPAID_LEAVE'>].available;
      if ((req.days ?? 0) > left) throw ApiError.rule(`Insufficient balance at approval: ${left} day(s) left, ${req.days} requested.`);
    }

    const claimed = await RequestModel.findOneAndUpdate(
      { id, status: 'PENDING' },
      { $set: { status: 'APPROVED', reviewedBy: reviewer, reviewedAt: new Date().toISOString(), ...(comment ? { reviewComment: comment } : {}) }, $unset: { applyError: '' } },
      { new: true }
    ).lean();
    if (!claimed) throw ApiError.conflict('This request was already processed by another administrator.');

    return this.apply(toRequest(claimed), dates, reviewer);
  }

  /** Re-attempts the apply step for an APPROVED request. Idempotent. */
  public async retryApply(id: string, actor: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    const req = await this.mustGet(id);
    if (req.status !== 'APPROVED') throw ApiError.conflict(`Only an APPROVED (not yet applied) request can be re-applied (current status: ${req.status}).`);
    await payrollRunService.assertDatesOpen([req.date, req.endDate || req.date], 'Applying this request');
    return this.apply(req, this.effectiveDates(req), actor);
  }

  private async apply(req: AttendanceRegularizationRequest, dates: string[], approver: string): Promise<AttendanceRegularizationRequest> {
    try {
      const kind = req.requestType;
      const approvedAt = new Date();
      for (const businessDate of dates) {
        await AttendanceAdjustmentModel.updateOne(
          { requestId: req.id, businessDate },
          {
            $set: { status: 'ACTIVE' },
            $unset: { revokedAt: '', revokedBy: '' },
            $setOnInsert: {
              employeeCode: req.empCode, businessDate, kind, requestId: req.id,
              inTime: req.inTime, outTime: req.outTime, leaveType: req.leaveType,
              paid: req.leaveType !== 'UNPAID_LEAVE', fraction: req.halfDay ? 0.5 : 1,
              approvedBy: approver, approvedAt,
            },
          },
          { upsert: true }
        );
      }
      await attendanceDayService.recomputeMany(dates.map((d) => ({ employeeCode: req.empCode, businessDate: d })));
      const applied = await RequestModel.findOneAndUpdate(
        { id: req.id, status: 'APPROVED' },
        { $set: { status: 'APPLIED', appliedAt: new Date().toISOString() }, $unset: { applyError: '' } },
        { new: true }
      ).lean();
      if (!applied) throw ApiError.conflict('Request changed while it was being applied.');
      return toRequest(applied);
    } catch (err: any) {
      await RequestModel.updateOne({ id: req.id }, { $set: { applyError: String(err?.message || 'apply failed').slice(0, 300) } });
      if (err instanceof ApiError) throw err;
      throw new ApiError('INTERNAL', 'The request was approved but its attendance effect could not be applied. It stays APPROVED and can be re-applied.');
    }
  }

  public async reject(id: string, reviewer: string, comment?: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    const res = await RequestModel.findOneAndUpdate(
      { id, status: 'PENDING' },
      { $set: { status: 'REJECTED', reviewedBy: reviewer, reviewedAt: new Date().toISOString(), ...(comment ? { reviewComment: comment } : {}) } },
      { new: true }
    ).lean();
    if (!res) {
      const cur = await this.mustGet(id);
      throw ApiError.conflict(`Only a PENDING request can be rejected (current status: ${cur.status}). To undo an approved request, use revoke.`);
    }
    return toRequest(res);
  }

  /** The employee (or an admin) withdraws a request that has not been decided. */
  public async cancel(id: string, actor: string, actorEmpCode?: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    const req = await this.mustGet(id);
    if (actorEmpCode && normalizeEmpCode(actorEmpCode) !== req.empCode) throw ApiError.forbidden('You can only cancel your own requests.');
    const res = await RequestModel.findOneAndUpdate(
      { id, status: 'PENDING' },
      { $set: { status: 'CANCELLED', reviewedBy: actor, reviewedAt: new Date().toISOString() } },
      { new: true }
    ).lean();
    if (!res) throw ApiError.conflict(`Only a PENDING request can be cancelled (current status: ${req.status}).`);
    return toRequest(res);
  }

  /** Explicit reversal of an approved/applied request: adjustments are voided and the days recomputed. */
  public async revoke(id: string, actor: string, reason: string): Promise<AttendanceRegularizationRequest> {
    requireDb();
    if (!reason || reason.trim().length < 5) throw ApiError.validation('A reason (at least 5 characters) is required to revoke a request.', [{ field: 'reason', issue: 'Required' }]);
    const req = await this.mustGet(id);
    if (!(EFFECTIVE_STATUSES as readonly RequestStatus[]).includes(req.status)) {
      throw ApiError.conflict(`Only an APPROVED or APPLIED request can be revoked (current status: ${req.status}).`);
    }
    await payrollRunService.assertDatesOpen([req.date, req.endDate || req.date], 'Revoking this request');

    const adj = await AttendanceAdjustmentModel.find({ requestId: id, status: 'ACTIVE' }).lean();
    await AttendanceAdjustmentModel.updateMany({ requestId: id, status: 'ACTIVE' }, { $set: { status: 'REVOKED', revokedBy: actor, revokedAt: new Date() } });
    await attendanceDayService.recomputeMany(adj.map((a: any) => ({ employeeCode: a.employeeCode, businessDate: a.businessDate })));
    const res = await RequestModel.findOneAndUpdate(
      { id, status: { $in: EFFECTIVE_STATUSES } },
      { $set: { status: 'REVOKED', revokedBy: actor, revokedAt: new Date().toISOString(), revokeReason: reason.trim() } },
      { new: true }
    ).lean();
    if (!res) throw ApiError.conflict('Request changed while it was being revoked.');
    return toRequest(res);
  }

  // ---------------------------------------------------------------- balance

  /** Balance per employee + leave type + calendar leave year, in days (0.5 supported). */
  public async getLeaveBalance(empCodeInput: string, year: number = Number(istToday().slice(0, 4))): Promise<LeaveBalance> {
    requireDb();
    const empCode = normalizeEmpCode(empCodeInput);
    const quota = policyService.getSettings().leaves;
    const rows = await RequestModel.find({
      empCode,
      requestType: 'LEAVE',
      leaveYear: year,
      status: { $in: ACTIVE_STATUSES },
    }).lean();

    const sum = (type: LeaveType, statuses: readonly RequestStatus[]) =>
      rows.filter((r: any) => r.leaveType === type && statuses.includes(r.status)).reduce((a: number, r: any) => a + (r.days ?? 1), 0);
    const entry = (type: Exclude<LeaveType, 'UNPAID_LEAVE'>, q: number) => {
      const used = sum(type, EFFECTIVE_STATUSES);
      return { quota: q, used, pending: sum(type, ['PENDING']), available: Math.max(0, q - used) };
    };
    return {
      empCode,
      year,
      balances: {
        CASUAL_LEAVE: entry('CASUAL_LEAVE', quota.casualLeave),
        SICK_LEAVE: entry('SICK_LEAVE', quota.sickLeave),
        EARNED_LEAVE: entry('EARNED_LEAVE', quota.earnedLeave),
        COMP_OFF: entry('COMP_OFF', quota.compOff),
      },
    };
  }

  public parseComment = (v: unknown) => optionalString(v, 'comment', 500);
}

export const requestsService = new RequestsService();
