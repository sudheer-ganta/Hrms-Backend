import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { attendanceService } from './attendance.service.js';
import { attendanceDayService } from './attendanceDay.service.js';
import { AttendanceAdjustmentModel } from './attendanceAdjustment.model.js';
import { punchService } from './punch.service.js';
import { ATTENDANCE_STATUSES, AttendanceStatus } from './attendanceStatus.js';
import { payrollRunService } from '../payroll/payrollRun.service.js';
import { handle, ApiError } from '../../utils/apiError.js';
import { dateRange, optionalDate, optionalEnum, optionalMonth, optionalTime, pagination, requireDate, requireEnum, requireNonEmptyString, requireObject, safeSort, asString } from '../../utils/validate.js';
import { isValidEmpCode, normalizeEmpCode } from '../../utils/empCode.js';
import { daysInMonth, istMonth, monthsInRange, addDays } from '../../utils/istTime.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { policyService } from '../settings/policy.service.js';
import { istToday } from '../../utils/istTime.js';
import { AttendanceDayDTO } from './attendanceDay.types.js';


const parseEmp = (v: unknown): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (!isValidEmpCode(v)) throw ApiError.validation('Invalid employee code.', [{ field: 'employeeCode', issue: 'Invalid' }]);
  return normalizeEmpCode(v);
};

export class AttendanceController {
  /** GET /attendance/raw-swipes: immutable raw punches (admin). */
  public getRawPunches = handle(async (req: AuthRequest, res: Response) => {
    const { from, to } = dateRange(req.query.fromDate, req.query.toDate);
    const { page, limit } = pagination(req.query.page, req.query.limit);
    const origin = optionalEnum(req.query.origin, ['DEVICE', 'ESS_WEB'] as const, 'origin');
    const result = await attendanceService.getRawPunches({
      sourceId: asString(req.query.sourceId), fromDate: from, toDate: to, employeeCode: parseEmp(req.query.employeeCode),
      search: asString(req.query.search)?.slice(0, 80), machineId: asString(req.query.machineId), origin, page, limit,
      sortBy: safeSort(req.query.sortBy, ['punchDateTime', 'entryDate', 'employeeCode'], 'punchDateTime'),
      sortOrder: req.query.sortOrder === 'asc' ? 'asc' : 'desc',
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  });

  /** GET /attendance/days: one resolved row per employee per business date. */
  public getDays = handle(async (req: AuthRequest, res: Response) => {
    const { from, to } = dateRange(req.query.fromDate, req.query.toDate);
    const { page, limit } = pagination(req.query.page, req.query.limit);
    const status = optionalEnum<AttendanceStatus>(req.query.status, ATTENDANCE_STATUSES, 'status');
    const rows = await attendanceDayService.listResolved({
      fromDate: from, toDate: to, employeeCode: parseEmp(req.query.employeeCode),
      siteId: asString(req.query.siteId ?? req.query.sourceId), search: asString(req.query.search)?.slice(0, 80),
    });
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    // Summary describes exactly the rows that matched the filters (never wider than the caller's scope).
    const summary = attendanceDayService.summarize(filtered);
    const total = filtered.length;
    res.json({
      success: true,
      data: filtered.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
      summary,
    });
  });

  /** GET /attendance/calendar?month=YYYY-MM&employeeCode=: every date of the month resolved (incl. offs/absences). */
  public getCalendar = handle(async (req: AuthRequest, res: Response) => {
    const month = optionalMonth(req.query.month) ?? istMonth();
    const code = parseEmp(req.query.employeeCode ?? req.query.empCode);
    if (!code) throw ApiError.validation('employeeCode is required.', [{ field: 'employeeCode', issue: 'Required' }]);
    const dates = daysInMonth(month);
    const out: AttendanceDayDTO[] = await attendanceDayService.calendar(code, dates[0], dates[dates.length - 1]);
    res.json({ success: true, data: { month, employeeCode: code, days: out } });
  });

  /** GET /attendance/timesheet (admin): one row per employee. */
  public getTimesheet = handle(async (req: AuthRequest, res: Response) => {
    const { from, to } = dateRange(req.query.fromDate, req.query.toDate, 62);
    const today = istToday();
    const result = await attendanceDayService.timesheet({
      fromDate: from ?? to ?? today, toDate: to ?? from ?? today,
      siteId: asString(req.query.siteId ?? req.query.sourceId), search: asString(req.query.search)?.slice(0, 80),
    });
    res.json({ success: true, data: result });
  });

  public getDashboardStats = handle(async (req: AuthRequest, res: Response) => {
    const date = optionalDate(req.query.date, 'date');
    res.json({ success: true, data: await attendanceService.getDashboardStats(date, asString(req.query.siteId ?? req.query.sourceId)) });
  });

  public getTodayPunchStatus = handle(async (req: AuthRequest, res: Response) => {
    const code = req.user!.role === 'EMPLOYEE' ? req.user!.empCode : parseEmp(req.query.empCode);
    if (!code) throw ApiError.validation('Employee code is required.', [{ field: 'empCode', issue: 'Required' }]);
    res.json({ success: true, data: await punchService.getTodayStatus(code) });
  });

  public recordPunch = handle(async (req: AuthRequest, res: Response) => {
    const u = req.user!;
    const result = await punchService.recordPunch(
      { ...requireObject(req.body ?? {}), userAgent: req.headers['user-agent'] },
      { id: u.id, role: u.role, empCode: u.empCode, name: u.name }
    );
    res.json({ success: true, data: result });
  });

  /**
   * POST /attendance/recompute: the ONLY way to re-derive stored attendance days (admin).
   * Reading attendance never writes. Closed payroll months are refused.
   */
  public recompute = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const from = requireDate(body.fromDate, 'fromDate');
    const to = requireDate(body.toDate, 'toDate');
    const { from: f, to: t } = dateRange(from, to, 62);
    await payrollRunService.assertDatesOpen([f!, t!], 'Recomputing attendance');
    const code = parseEmp(body.employeeCode);
    const codes = code ? [code] : (await employeeMasterService.getAllProfiles()).map((p) => p.empCode);
    const keys = [] as { employeeCode: string; businessDate: string }[];
    for (let d = f!; d <= t!; d = addDays(d, 1)) for (const c of codes) keys.push({ employeeCode: c, businessDate: d });
    const n = await attendanceDayService.recomputeMany(keys);
    res.json({ success: true, data: { recomputed: n, months: monthsInRange(f!, t!) } });
  });

  /**
   * POST /attendance/adjust: Direct HR manual adjustment for an employee-day (e.g. ABSENT -> WFH).
   * Fully audited with reason, changedBy, and timestamp.
   */
  public adjustDay = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const code = parseEmp(body.employeeCode);
    if (!code) throw ApiError.validation('employeeCode is required.', [{ field: 'employeeCode', issue: 'Required' }]);
    const date = requireDate(body.businessDate, 'businessDate');
    const kind = requireEnum(body.kind, ['WORK_FROM_HOME', 'MISSED_PUNCH', 'LEAVE', 'ON_DUTY'] as const, 'kind');
    const reason = requireNonEmptyString(body.reason, 'reason', 500);

    await payrollRunService.assertDatesOpen([date], 'Creating attendance adjustment');

    const requestId = `adj_hr_${Date.now()}`;
    const approvedBy = req.user?.name || req.user?.email || 'HR';
    const approvedAt = new Date();

    // Revoke any existing active adjustment for this employee-day
    await AttendanceAdjustmentModel.updateMany(
      { employeeCode: code, businessDate: date, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedBy: approvedBy, revokedAt: approvedAt, revokeReason: 'Superseded by new adjustment' } }
    );

    await AttendanceAdjustmentModel.create({
      employeeCode: code,
      businessDate: date,
      kind,
      requestId,
      inTime: optionalTime(body.inTime, 'inTime'),
      outTime: optionalTime(body.outTime, 'outTime'),
      leaveType: body.leaveType,
      paid: body.paid !== false,
      fraction: body.fraction === 0.5 ? 0.5 : 1,
      status: 'ACTIVE',
      reason: reason.trim(),
      approvedBy,
      approvedAt,
    });

    await attendanceDayService.recompute(code, date);
    const resolved = await attendanceDayService.resolveOne(code, date);
    res.json({ success: true, data: resolved.day, message: `Day ${date} adjusted to ${kind}.` });
  });

  /**
   * POST /attendance/adjust/:id/revoke or POST /attendance/adjust/revoke: Revokes a manual adjustment and restores the automatic resolver result.
   */
  public revokeAdjustment = handle(async (req: AuthRequest, res: Response) => {
    const id = asString(req.params.id);
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const code = parseEmp(body.employeeCode);
    const date = optionalDate(body.businessDate, 'businessDate');
    const reason = asString(body.reason) || 'Revoked by HR';
    const revokedBy = req.user?.name || req.user?.email || 'HR';
    const revokedAt = new Date();

    if (id && id !== 'revoke') {
      const adj = await AttendanceAdjustmentModel.findById(id);
      if (!adj) throw ApiError.notFound('Adjustment not found.');
      if (adj.status === 'REVOKED') throw ApiError.conflict('Adjustment is already revoked.');

      await payrollRunService.assertDatesOpen([adj.businessDate], 'Revoking attendance adjustment');

      adj.status = 'REVOKED';
      adj.revokedBy = revokedBy;
      adj.revokedAt = revokedAt;
      adj.revokeReason = reason.trim();
      await adj.save();

      await attendanceDayService.recompute(adj.employeeCode, adj.businessDate);
      const resolved = await attendanceDayService.resolveOne(adj.employeeCode, adj.businessDate);
      return res.json({ success: true, data: resolved.day, message: `Adjustment revoked for ${adj.businessDate}.` });
    }

    if (code && date) {
      await payrollRunService.assertDatesOpen([date], 'Revoking attendance adjustment');
      await AttendanceAdjustmentModel.updateMany(
        { employeeCode: code, businessDate: date, status: 'ACTIVE' },
        { $set: { status: 'REVOKED', revokedBy, revokedAt, revokeReason: reason.trim() } }
      );
      await attendanceDayService.recompute(code, date);
      const resolved = await attendanceDayService.resolveOne(code, date);
      return res.json({ success: true, data: resolved.day, message: `Adjustment revoked for ${date}.` });
    }

    throw ApiError.validation('Either adjustment ID or employeeCode + businessDate is required.', [{ field: 'id', issue: 'Required' }]);
  });
}

export const attendanceController = new AttendanceController();

