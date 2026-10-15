import { HRMSPolicySettings } from '../settings/policy.types.js';
import { getShiftStandardHours, isOvernightShift, lateThresholdMinutes, shiftStartMinutes, shiftEndMinutes } from '../settings/policy.service.js';
import { dayNameOf, hhmmToMinutes, durationMinutes } from '../../utils/istTime.js';
import { AttendanceStatus, mapVendorStatus, STATUS_LABELS } from './attendanceStatus.js';

/**
 * THE single authority that decides what a day is. Payroll, the dashboard, the timesheet,
 * the attendance grid, the ESS portal and the employee drawer ALL consume its output.
 * It is a pure function: facts + policy in, verdict out. No database, no clock.
 */

export type AdjustmentKind = 'MISSED_PUNCH' | 'LEAVE' | 'WORK_FROM_HOME' | 'ON_DUTY';

export interface ActiveAdjustment {
  id: string;
  requestId: string;
  kind: AdjustmentKind;
  inTime?: string;   // MISSED_PUNCH
  outTime?: string;  // MISSED_PUNCH
  paid?: boolean;    // LEAVE (default true)
  fraction?: number; // LEAVE: 1 or 0.5
}

/** Facts gathered from raw punches, vendor daily summaries and approved adjustments. */
export interface DayFacts {
  firstIn?: string | null;   // HH:mm IST
  lastOut?: string | null;   // HH:mm IST
  punchCount?: number;
  workMinutes?: number;      // measured (punch span, else vendor)
  vendorStatus?: string | null;
  vendorOvertimeMinutes?: number | null;
  vendorLateMinutes?: number | null;
  adjustments?: ActiveAdjustment[];
}

export interface ResolveContext {
  policy: HRMSPolicySettings;
  /** Current IST business date; days after it are "future" and have no status. */
  today: string;
}

export type ResolutionSource = 'POLICY' | 'ADJUSTMENT' | 'VENDOR' | 'PUNCHES' | 'NONE';

export interface ResolvedDay {
  businessDate: string;
  /** null only for future days. */
  status: AttendanceStatus | null;
  statusLabel: string;
  firstIn: string | null;
  lastOut: string | null;
  workMinutes: number;
  /** Minutes payroll credits as worked (single swipe / WFH / OD credit a standard day). */
  creditedWorkMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  lateMinutes: number;
  /** Minutes left before the shift end when the employee checked out (0 for overnight shifts / full shifts). */
  earlyCheckoutMinutes: number;
  /** Calendar facts from policy, independent of the verdict. */
  isWeeklyOff: boolean;
  isHoliday: boolean;
  isPaidHoliday: boolean;
  holidayName: string | null;
  /** Days of work recognized on this weekly off / paid holiday (policy.offDayWork.<kind>). 0 unless AUTOMATIC. The kind is the day's status. */
  offDayWorkFraction: number;
  /** Version of the policy this verdict was computed under. */
  policyVersion: number;
  vendorStatus: string | null;
  source: ResolutionSource;
  adjustmentId: string | null;
  requestId: string | null;
  /** Fractional paid leave (0.5 for half-day leave). */
  leaveFraction: number;
  /** Today and only one punch so far: the employee is simply checked in. */
  inProgress: boolean;
  isFuture: boolean;
}

export const standardDayMinutes = (policy: HRMSPolicySettings): number =>
  Math.round(getShiftStandardHours(policy.shift) * 60);

export const isHolidayDate = (businessDate: string, policy: HRMSPolicySettings): boolean =>
  policy.holidays.some((h) => h.date === businessDate && h.paid !== false);

export const isWeeklyOffDate = (businessDate: string, policy: HRMSPolicySettings): boolean =>
  policy.weeklyOffDays.includes(dayNameOf(businessDate));

/** Classifies hours worked against policy thresholds. */
export const classifyWork = (
  workMinutes: number,
  lastOut: string | null | undefined,
  policy: HRMSPolicySettings
): 'PRESENT' | 'HALF_DAY' | 'ABSENT' => {
  const { fullDayThresholdMinutes: full, halfDayThresholdMinutes: half, minCheckoutForFullDay } = policy.shift;
  const outMin = hhmmToMinutes(lastOut);
  const minOut = hhmmToMinutes(minCheckoutForFullDay);
  const meetsCheckout = !isOvernightShift(policy.shift) && minOut !== null && outMin !== null && outMin >= minOut && workMinutes >= half;
  if (workMinutes >= full || meetsCheckout) return 'PRESENT';
  if (workMinutes >= half) return 'HALF_DAY';
  return 'ABSENT';
};

export function resolveDay(businessDate: string, facts: DayFacts | undefined, ctx: ResolveContext): ResolvedDay {
  const { policy, today } = ctx;
  const f = facts || {};
  const standard = standardDayMinutes(policy);
  const holiday = policy.holidays.find((h) => h.date === businessDate);

  const base: ResolvedDay = {
    businessDate,
    status: null,
    statusLabel: '',
    firstIn: f.firstIn || null,
    lastOut: f.lastOut || null,
    workMinutes: 0,
    creditedWorkMinutes: 0,
    overtimeMinutes: 0,
    isLate: false,
    lateMinutes: 0,
    earlyCheckoutMinutes: 0,
    isWeeklyOff: isWeeklyOffDate(businessDate, policy),
    isHoliday: !!holiday,
    isPaidHoliday: !!holiday && holiday.paid !== false,
    holidayName: holiday?.name ?? null,
    offDayWorkFraction: 0,
    policyVersion: policy.version,
    vendorStatus: f.vendorStatus || null,
    source: 'NONE',
    adjustmentId: null,
    requestId: null,
    leaveFraction: 0,
    inProgress: false,
    isFuture: false,
  };
  const done = (patch: Partial<ResolvedDay>): ResolvedDay => {
    const r = { ...base, ...patch };
    r.statusLabel = r.status ? STATUS_LABELS[r.status] : '';
    return r;
  };

  // 0. Future days have no verdict.
  if (businessDate > today) return done({ isFuture: true });

  const hasIn = !!f.firstIn;
  const hasOut = !!f.lastOut && f.lastOut !== f.firstIn;
  const measured = f.workMinutes && f.workMinutes > 0 ? f.workMinutes : hasIn && hasOut ? durationMinutes(f.firstIn, f.lastOut) : 0;

  // 1. Approved adjustments (regularization / leave / WFH / on-duty) override measured and calendar data.
  const adj = (f.adjustments || [])[0];
  if (adj) {
    const common = { adjustmentId: adj.id, requestId: adj.requestId, source: 'ADJUSTMENT' as const };
    if (adj.kind === 'LEAVE') {
      const fraction = adj.fraction === 0.5 ? 0.5 : 1;
      const paid = adj.paid !== false;
      if (fraction === 0.5 && paid) {
        return done({ ...common, status: 'HALF_DAY', leaveFraction: 0.5, workMinutes: measured, creditedWorkMinutes: measured });
      }
      return done({ ...common, status: paid ? 'LEAVE_PAID' : 'LEAVE_UNPAID', leaveFraction: fraction });
    }
    if (adj.kind === 'MISSED_PUNCH') {
      const inT = adj.inTime || f.firstIn || policy.shift.startTime;
      const outT = adj.outTime || f.lastOut || policy.shift.endTime;
      const w = durationMinutes(inT, outT);
      return done({ ...common, status: 'PRESENT', firstIn: inT, lastOut: outT, workMinutes: w, creditedWorkMinutes: w });
    }
    const w = measured > 0 ? measured : standard;
    return done({
      ...common,
      status: adj.kind === 'WORK_FROM_HOME' ? 'WORK_FROM_HOME' : 'ON_DUTY',
      workMinutes: w,
      creditedWorkMinutes: w,
    });
  }

  // 2. Company off-days win over unadjusted punches. Work done on one is recognized
  //    by policy.offDayWork: AUTOMATIC credits it from punches (or OT calculator).
  const offDay = (status: 'HOLIDAY' | 'WEEKLY_OFF', source: ResolutionSource): ResolvedDay => {
    const rule = status === 'HOLIDAY' ? policy.offDayWork.paidHoliday : policy.offDayWork.weeklyOff;
    const verdict = rule.recognition === 'AUTOMATIC' && measured > 0 ? classifyWork(measured, f.lastOut, policy) : 'ABSENT';
    const offDayWorkFraction = verdict === 'PRESENT' ? 1 : verdict === 'HALF_DAY' ? 0.5 : 0;
    return done({ status, source, offDayWorkFraction, workMinutes: offDayWorkFraction > 0 ? measured : 0 });
  };
  if (isHolidayDate(businessDate, policy)) return offDay('HOLIDAY', 'POLICY');
  if (isWeeklyOffDate(businessDate, policy)) return offDay('WEEKLY_OFF', 'POLICY');


  // 3. Late / overtime (shared by every worked status below).
  const firstInMin = hhmmToMinutes(f.firstIn);
  const lateCut = lateThresholdMinutes(policy.shift);
  const startMin = shiftStartMinutes(policy.shift);
  const policyLate = firstInMin !== null && firstInMin > lateCut;
  const isLate = firstInMin !== null ? policyLate : (f.vendorLateMinutes ?? 0) > 0;
  const lateMinutes = firstInMin !== null ? Math.max(0, firstInMin - startMin) : f.vendorLateMinutes ?? 0;

  const derivedOt = Math.max(0, measured - standard);
  const overtimeMinutes = !policy.overtime.enabled
    ? 0
    : f.vendorOvertimeMinutes !== undefined && f.vendorOvertimeMinutes !== null
    ? f.vendorOvertimeMinutes
    : derivedOt;

  const outMin = hhmmToMinutes(f.lastOut);
  const earlyCheckoutMinutes = hasOut && outMin !== null && !isOvernightShift(policy.shift) ? Math.max(0, shiftEndMinutes(policy.shift) - outMin) : 0;

  const worked = (status: AttendanceStatus, source: ResolutionSource, credited: number, extra: Partial<ResolvedDay> = {}) =>
    done({ status, source, workMinutes: measured, creditedWorkMinutes: credited, overtimeMinutes, isLate, lateMinutes, earlyCheckoutMinutes, ...extra });

  // 4. Vendor verdicts that carry a business meaning.
  const vendor = mapVendorStatus(f.vendorStatus);
  if (vendor === 'WEEKLY_OFF' || vendor === 'HOLIDAY') {
    // The device roster declared an off-day the policy does not know about; honored as before.
    return offDay(vendor, 'VENDOR');
  }
  if (vendor === 'LEAVE_PAID') return done({ status: 'LEAVE_PAID', source: 'VENDOR', leaveFraction: 1 });
  if (vendor === 'PRESENT') return worked('PRESENT', 'VENDOR', measured);
  if (vendor === 'HALF_DAY') return worked('HALF_DAY', 'VENDOR', measured);

  // 5. Derive from punches / vendor times with the policy thresholds.
  if (!hasIn && !hasOut && !(f.punchCount && f.punchCount > 0) && measured === 0) {
    return done({ status: 'ABSENT', source: f.vendorStatus ? 'VENDOR' : 'NONE' });
  }
  const singleSwipe = !(hasIn && hasOut);
  if (singleSwipe && measured === 0) {
    // One swipe only: evidence the employee was at work, so the day is paid (as before) but flagged.
    return worked('MISSED_PUNCH', 'PUNCHES', standard, { inProgress: businessDate === today });
  }
  const verdict = classifyWork(measured, f.lastOut, policy);
  if (verdict === 'ABSENT') return done({ status: 'ABSENT', source: 'PUNCHES', workMinutes: measured });
  return worked(verdict, 'PUNCHES', measured);
}
