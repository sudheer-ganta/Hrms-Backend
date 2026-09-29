import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSunday, isSaturday } from 'date-fns';
import mongoose from 'mongoose';
import { localStore } from '../../config/localStore.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { policyService } from '../settings/policy.service.js';
import { EmployeePayrollSummary } from './payroll.types.js';
import { numberToWordsIndian } from './numberToWords.js';
import { EmployeeProfile } from '../employees/employeeMaster.types.js';
import { InOutModel } from '../attendance/inOut.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { HRMSPolicySettings } from '../settings/policy.types.js';
import { getShiftStandardHours } from '../settings/policy.service.js';
import { payrollRunService } from './payrollRun.service.js';
import { payrollAdjustmentService } from './payrollAdjustment.service.js';
import { EmployeeOtAdjustment } from './payrollAdjustment.types.js';

// Standard statutory overtime rate (time-and-a-half) applied when neither a
// monthly OT Calculator adjustment nor a per-employee custom OT rate is set.
const DEFAULT_OT_RATE_MULTIPLIER = 1.5;

// Late-arrival cutoff = configured shift start time + grace period, expressed in
// minutes-since-midnight, so it reflects Settings instead of a hardcoded time.
function getLateThresholdMinutes(policy: HRMSPolicySettings): number {
  const [startHour, startMin] = (policy.shift?.startTime || '09:00').split(':').map(Number);
  const graceMinutes = policy.shift?.gracePeriodMinutes ?? 15;
  return (startHour || 9) * 60 + (startMin || 0) + graceMinutes;
}

// How long a computed "all employees" payroll snapshot stays valid before being
// recomputed. Attendance data itself only changes as often as the biometric
// sync scheduler runs (5 minutes by default), so serving a short-lived cached
// result avoids paying MongoDB Atlas round-trip latency on every page visit.
// Any adjustment save/clear or month close/reopen invalidates it immediately
// via invalidateAllPayrollCache(), so this window is a safety-net ceiling, not
// the normal staleness a user will see.
const ALL_PAYROLL_CACHE_TTL_MS = 20_000;

class PayrollService {
  private allPayrollCache = new Map<string, { data: EmployeePayrollSummary[]; expiresAt: number }>();

  /**
   * Drops the cached "all employees" snapshot for a month (or every month, if
   * none given) so the next request recomputes from live data immediately.
   */
  public invalidateAllPayrollCache(monthKey?: string): void {
    if (monthKey) {
      this.allPayrollCache.delete(monthKey);
    } else {
      this.allPayrollCache.clear();
    }
  }

  /**
   * Calculates monthly payroll & overtime summary for a single employee
   */
  public async calculateEmployeePayroll(empCode: string, monthStr?: string): Promise<EmployeePayrollSummary> {
    // A closed month is a locked, permanent record — never recompute it live,
    // even if attendance data for that month changes afterward.
    const targetMonthKey = monthStr || format(new Date(), 'yyyy-MM');
    const closedRun = await payrollRunService.getClosedRun(targetMonthKey);
    if (closedRun) {
      const locked = closedRun.snapshot.find((s) => s.empCode === empCode);
      if (locked) return locked;
    }

    const targetDate = monthStr ? new Date(`${monthStr}-01`) : new Date();
    const mStart = startOfMonth(targetDate);
    const mEnd = endOfMonth(targetDate);
    const formattedMonth = format(mStart, 'yyyy-MM');
    const daysInMonth = eachDayOfInterval({ start: mStart, end: mEnd });
    const totalMonthDays = daysInMonth.length;
    const dateFrom = format(mStart, 'yyyy-MM-01');
    const dateTo = format(mEnd, 'yyyy-MM-dd');

    const isDbConnected = mongoose.connection.readyState === 1;

    // These lookups are independent of each other, so run them together
    // instead of one after another — each round trip to MongoDB Atlas costs
    // roughly the same fixed latency regardless of how small the query is.
    const [profileResult, adjustments, mongoRecords] = await Promise.all([
      employeeMasterService.getProfile(empCode),
      payrollAdjustmentService.getAdjustments(targetMonthKey),
      isDbConnected
        ? Promise.all([
            InOutModel.find({ employeeCode: empCode, date: { $gte: dateFrom, $lte: dateTo } })
              .select('employeeCode date inTime outTime workMinutes status overTime lateIn')
              .maxTimeMS(3000)
              .lean(),
            AttendanceModel.find({ employeeCode: empCode, entryDate: { $gte: dateFrom, $lte: dateTo } })
              .select('entryDate punchDateTime employeeCode')
              .maxTimeMS(3000)
              .lean(),
          ]).catch((err) => {
            console.warn('MongoDB query in calculateEmployeePayroll failed/timed out, using local store:', err);
            return [[], []] as [any[], any[]];
          })
        : Promise.resolve([[], []] as [any[], any[]]),
    ]);

    const profile = profileResult || {
      empCode,
      name: `Employee ${empCode}`,
      otEligible: true,
      status: 'active' as const
    };

    let [inOutList, punchesList] = mongoRecords;

    // Holidays & Policies
    const policy = policyService.getSettings();
    const holidays = policy.holidays || [];
    const holidayDates = new Set(holidays.map(h => h.date));
    const weeklyOffList = policy.weeklyOffDays || ['Sunday'];
    // Standard work-day length for wage-rate & OT math comes from the configured
    // shift start/end time — NOT the attendance-marking thresholds below, which
    // are deliberately more lenient (e.g. checkout after 6h still counts as a
    // full day present, even on an 8.5h shift).
    const standardDayHours = getShiftStandardHours(policy.shift);
    const minFullDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 6.0);
    const minHalfDayHours = (policy.shift?.halfDayThresholdMinutes ? policy.shift.halfDayThresholdMinutes / 60 : 3.0);
    const minCheckoutForFullDay = policy.shift?.minCheckoutForFullDay || '16:00';
    const otRateMultiplier = DEFAULT_OT_RATE_MULTIPLIER;
    const lateThresholdMinutes = getLateThresholdMinutes(policy);

    if (inOutList.length === 0 && punchesList.length === 0) {
      inOutList = localStore.getInOutRecords().filter(r => r.employeeCode === empCode && r.date >= dateFrom && r.date <= dateTo);
      punchesList = localStore.getRecords().filter(p => p.employeeCode === empCode && p.entryDate >= dateFrom && p.entryDate <= dateTo);
    }

    const inOutMap = new Map<string, typeof inOutList[0]>();
    for (const r of inOutList) {
      if (r.date) inOutMap.set(r.date, r);
    }

    const punchesMap = new Map<string, typeof punchesList>();
    for (const p of punchesList) {
      const dStr = p.entryDate || (p.punchDateTime ? new Date(p.punchDateTime).toISOString().substring(0, 10) : '');
      if (dStr) {
        if (!punchesMap.has(dStr)) punchesMap.set(dStr, []);
        punchesMap.get(dStr)!.push(p);
      }
    }

    const empAdj = adjustments[empCode];

    return this.computeSingleEmployee(
      profile,
      formattedMonth,
      totalMonthDays,
      daysInMonth,
      holidayDates,
      weeklyOffList,
      standardDayHours,
      minFullDayHours,
      minHalfDayHours,
      minCheckoutForFullDay,
      otRateMultiplier,
      lateThresholdMinutes,
      inOutMap,
      punchesMap,
      empAdj
    );
  }

  /**
   * Fast Batch Payroll Calculation for all employees with O(1) in-memory indexing
   */
  public async calculateAllEmployeesPayroll(monthStr?: string): Promise<EmployeePayrollSummary[]> {
    // A closed month is a locked, permanent record — never recompute it live,
    // even if attendance data for that month changes afterward.
    const targetMonthKey = monthStr || format(new Date(), 'yyyy-MM');
    const closedRun = await payrollRunService.getClosedRun(targetMonthKey);
    if (closedRun) {
      return closedRun.snapshot;
    }

    const cached = this.allPayrollCache.get(targetMonthKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const targetDate = monthStr ? new Date(`${monthStr}-01`) : new Date();
    const mStart = startOfMonth(targetDate);
    const mEnd = endOfMonth(targetDate);
    const formattedMonth = format(mStart, 'yyyy-MM');
    const daysInMonth = eachDayOfInterval({ start: mStart, end: mEnd });
    const totalMonthDays = daysInMonth.length;
    const dateFrom = format(mStart, 'yyyy-MM-01');
    const dateTo = format(mEnd, 'yyyy-MM-dd');

    const isDbConnected = mongoose.connection.readyState === 1;

    // These three lookups are independent of each other, so run them together
    // instead of one after another — each round trip to MongoDB Atlas costs
    // roughly the same fixed latency regardless of how small the query is,
    // so serializing them was paying that latency multiple times over.
    const [allProfiles, adjustments, mongoRecords] = await Promise.all([
      employeeMasterService.getAllProfiles(),
      payrollAdjustmentService.getAdjustments(targetMonthKey),
      isDbConnected
        ? Promise.all([
            InOutModel.find({ date: { $gte: dateFrom, $lte: dateTo } })
              .select('employeeCode date inTime outTime workMinutes status overTime lateIn')
              .maxTimeMS(4000)
              .lean(),
            AttendanceModel.find({ entryDate: { $gte: dateFrom, $lte: dateTo } })
              .select('employeeCode entryDate punchDateTime')
              .maxTimeMS(4000)
              .lean(),
          ]).catch((err) => {
            console.warn('MongoDB query in calculateAllEmployeesPayroll failed/timed out, using local store:', err);
            return [[], []] as [any[], any[]];
          })
        : Promise.resolve([[], []] as [any[], any[]]),
    ]);

    let [allInOut, allPunches] = mongoRecords;

    // Load policy ONCE
    const policy = policyService.getSettings();
    const holidays = policy.holidays || [];
    const holidayDates = new Set(holidays.map(h => h.date));
    const weeklyOffList = policy.weeklyOffDays || ['Sunday'];
    const standardDayHours = getShiftStandardHours(policy.shift);
    const minFullDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 6.0);
    const minHalfDayHours = (policy.shift?.halfDayThresholdMinutes ? policy.shift.halfDayThresholdMinutes / 60 : 3.0);
    const minCheckoutForFullDay = policy.shift?.minCheckoutForFullDay || '16:00';
    const otRateMultiplier = DEFAULT_OT_RATE_MULTIPLIER;
    const lateThresholdMinutes = getLateThresholdMinutes(policy);

    if (allInOut.length === 0 && allPunches.length === 0) {
      allInOut = localStore.getInOutRecords().filter(r => r.date >= dateFrom && r.date <= dateTo);
      allPunches = localStore.getRecords().filter(p => p.entryDate >= dateFrom && p.entryDate <= dateTo);
    }

    // Pre-index InOut records by [empCode -> [date -> record]]
    const inOutIndex = new Map<string, Map<string, typeof allInOut[0]>>();
    for (const r of allInOut) {
      if (r.employeeCode && r.date) {
        if (!inOutIndex.has(r.employeeCode)) {
          inOutIndex.set(r.employeeCode, new Map());
        }
        inOutIndex.get(r.employeeCode)!.set(r.date, r);
      }
    }

    // Pre-index raw punches by [empCode -> [date -> punchList]]
    const punchesIndex = new Map<string, Map<string, typeof allPunches>>();
    for (const p of allPunches) {
      if (p.employeeCode) {
        const dStr = p.entryDate || (p.punchDateTime ? new Date(p.punchDateTime).toISOString().substring(0, 10) : '');
        if (dStr) {
          if (!punchesIndex.has(p.employeeCode)) {
            punchesIndex.set(p.employeeCode, new Map());
          }
          const empDates = punchesIndex.get(p.employeeCode)!;
          if (!empDates.has(dStr)) {
            empDates.set(dStr, []);
          }
          empDates.get(dStr)!.push(p);
        }
      }
    }

    const emptyInOutMap = new Map<string, any>();
    const emptyPunchesMap = new Map<string, any>();

    const result = allProfiles.map((profile) => {
      const empInOutMap = inOutIndex.get(profile.empCode) || emptyInOutMap;
      const empPunchesMap = punchesIndex.get(profile.empCode) || emptyPunchesMap;
      const empAdj = adjustments[profile.empCode];

      return this.computeSingleEmployee(
        profile,
        formattedMonth,
        totalMonthDays,
        daysInMonth,
        holidayDates,
        weeklyOffList,
        standardDayHours,
        minFullDayHours,
        minHalfDayHours,
        minCheckoutForFullDay,
        otRateMultiplier,
        lateThresholdMinutes,
        empInOutMap,
        empPunchesMap,
        empAdj
      );
    });

    this.allPayrollCache.set(targetMonthKey, { data: result, expiresAt: Date.now() + ALL_PAYROLL_CACHE_TTL_MS });
    return result;
  }

  /**
   * Internal pure math calculator
   */
  private computeSingleEmployee(
    profile: EmployeeProfile,
    formattedMonth: string,
    totalMonthDays: number,
    daysInMonth: Date[],
    holidayDates: Set<string>,
    weeklyOffList: string[],
    standardDayHours: number,
    minFullDayHours: number,
    minHalfDayHours: number,
    minCheckoutForFullDay: string,
    otRateMultiplier: number,
    lateThresholdMinutes: number,
    inOutByDate: Map<string, any>,
    punchesByDate: Map<string, any[]>,
    adjustment?: EmployeeOtAdjustment
  ): EmployeePayrollSummary {
    let presentDays = 0;
    let halfDays = 0;
    let absentDays = 0;
    let weeklyOffs = 0;
    let holidayCount = 0;
    let totalWorkHours = 0;
    let totalOtHours = 0;
    let lateArrivals = 0;

    const todayStr = format(new Date(), 'yyyy-MM-dd');
    let elapsedDays = 0;

    for (const d of daysInMonth) {
      const dateKey = format(d, 'yyyy-MM-dd');
      const isSun = isSunday(d);
      const isSat = isSaturday(d);
      const isOff = (isSun && weeklyOffList.includes('Sunday')) || (isSat && weeklyOffList.includes('Saturday'));
      const isHol = holidayDates.has(dateKey);
      const isFuture = dateKey > todayStr;

      // Option 1 (Month-to-Date): only evaluate elapsed days up to today
      if (isFuture) {
        continue;
      }
      elapsedDays++;

      const ioRec = inOutByDate.get(dateKey);
      const dayPunches = punchesByDate.get(dateKey) || [];

      if (isHol) {
        holidayCount++;
      } else if (isOff) {
        weeklyOffs++;
      } else if (ioRec) {
        const hasIn = Boolean(ioRec.inTime && ioRec.inTime !== '--:--');
        const hasOut = Boolean(ioRec.outTime && ioRec.outTime !== '--:--');
        const isSingleSwipe = (hasIn !== hasOut);
        const workMin = ioRec.workMinutes || 0;
        const outTimeStr = (ioRec.outTime && ioRec.outTime !== '--:--') ? ioRec.outTime.slice(0, 5) : '';
        const meetsCheckoutCutoff = Boolean(minCheckoutForFullDay && outTimeStr && outTimeStr >= minCheckoutForFullDay && workMin >= (minHalfDayHours * 60));
        const isFullDayWork = workMin >= (minFullDayHours * 60) || meetsCheckoutCutoff;

        if (ioRec.status === 'W' || ioRec.status === 'WO') {
          weeklyOffs++;
        } else if (ioRec.status === 'HL' || ioRec.status === 'H') {
          holidayCount++;
        } else if (ioRec.status === 'P' || isFullDayWork || isSingleSwipe) {
          presentDays++;
        } else if (ioRec.status === 'P/2' || ioRec.status === 'HALF' || workMin >= (minHalfDayHours * 60)) {
          halfDays++;
        } else {
          // Explicit vendor "Absent" status, or a record with no recognized
          // status and insufficient worked minutes — an unexplained absence.
          absentDays++;
        }

        const hrs = (ioRec.workMinutes || (isSingleSwipe ? standardDayHours * 60 : 0)) / 60;
        totalWorkHours += hrs;

        if (ioRec.overTime && ioRec.overTime !== '00:00' && ioRec.overTime !== '--:--') {
          const [oH, oM] = ioRec.overTime.split(':').map(Number);
          const otDuration = (oH || 0) + ((oM || 0) / 60);
          totalOtHours += otDuration;
        }

        if (ioRec.lateIn && ioRec.lateIn !== '00:00' && ioRec.lateIn !== '--:--') {
          lateArrivals++;
        }
      } else if (dayPunches.length >= 2) {
        const sorted = [...dayPunches].sort((a, b) => new Date(a.punchDateTime).getTime() - new Date(b.punchDateTime).getTime());
        const firstIn = new Date(sorted[0].punchDateTime).getTime();
        const lastOut = new Date(sorted[sorted.length - 1].punchDateTime).getTime();
        const durationHours = Math.max(0, (lastOut - firstIn) / (1000 * 60 * 60));
        const durationMinutes = Math.round(durationHours * 60);
        const lastDate = new Date(sorted[sorted.length - 1].punchDateTime);
        const lastPunchTimeStr = `${String(lastDate.getHours()).padStart(2, '0')}:${String(lastDate.getMinutes()).padStart(2, '0')}`;

        totalWorkHours += durationHours;

        if (profile.otEligible && durationHours > standardDayHours) {
          totalOtHours += (durationHours - standardDayHours);
        }

        const meetsCheckoutCutoff = Boolean(minCheckoutForFullDay && lastPunchTimeStr >= minCheckoutForFullDay && durationMinutes >= (minHalfDayHours * 60));

        if (durationHours >= minFullDayHours || meetsCheckoutCutoff) {
          presentDays++;
        } else if (durationHours >= minHalfDayHours) {
          halfDays++;
        } else {
          absentDays++;
        }

        const inHour = new Date(sorted[0].punchDateTime).getHours();
        const inMin = new Date(sorted[0].punchDateTime).getMinutes();
        if (inHour * 60 + inMin > lateThresholdMinutes) {
          lateArrivals++;
        }
      } else if (dayPunches.length === 1) {
        // Single swipe recorded (e.g. forgot to punch out): credit as present,
        // there is direct evidence the employee was at work that day.
        presentDays++;
        totalWorkHours += standardDayHours;
      } else {
        // No InOut record and no raw punches at all for a working day — an
        // unexplained absence, deducted as Loss of Pay below.
        absentDays++;
      }
    }

    // Apply saved adjustments if any
    if (adjustment) {
      if (adjustment.totalWorkHours !== undefined && adjustment.totalWorkHours >= 0) {
        totalWorkHours = adjustment.totalWorkHours;
      }
      if (adjustment.otHours !== undefined && adjustment.otHours >= 0) {
        totalOtHours = adjustment.otHours;
      }
      if (adjustment.multiplier !== undefined && adjustment.multiplier >= 0) {
        otRateMultiplier = adjustment.multiplier;
      }
    }

    // Month-to-Date (MTD) Payable Days Math — absences deduct Loss of Pay;
    // present/half-day/holiday/weekly-off days remain fully paid.
    const lopDays = absentDays;
    const payableDays = Math.max(0, elapsedDays - lopDays);

    // Compensation & Salary Engine (Annexure K Breakdown)
    const hasSalarySet = profile.monthlyCtc !== undefined && profile.monthlyCtc !== null && Number(profile.monthlyCtc) > 0;
    const monthlyCtc = hasSalarySet ? Number(profile.monthlyCtc) : 0;
    const basicSalary = hasSalarySet ? (profile.basicSalary || Math.round(monthlyCtc * 0.50)) : 0;
    const hra = hasSalarySet ? (profile.hra || Math.round(monthlyCtc * 0.20)) : 0;
    const pfDeduction = hasSalarySet ? (profile.employeePf ?? Math.min(1800, Math.round(basicSalary * 0.12))) : 0;
    const employerPf = hasSalarySet ? (profile.employerPf ?? Math.min(1800, Math.round(basicSalary * 0.12))) : 0;
    const esiDeduction = hasSalarySet ? (profile.employeeEsic ?? (monthlyCtc <= 21000 ? Math.round(monthlyCtc * 0.0075) : 0)) : 0;
    const employerEsic = hasSalarySet ? (profile.employerEsic ?? 0) : 0;
    const ptDeduction = hasSalarySet ? (profile.professionalTax ?? (monthlyCtc >= 15000 ? 200 : 0)) : 0;

    const specialAllowance = hasSalarySet ? (profile.specialAllowance ?? (profile.allowances !== undefined ? profile.allowances : Math.max(0, monthlyCtc - basicSalary - hra - employerPf - ptDeduction))) : 0;
    const grossSalary = hasSalarySet ? (profile.grossSalary || (basicSalary + hra + specialAllowance)) : 0;
    const totalNetSalary = hasSalarySet ? Math.max(0, grossSalary - pfDeduction - esiDeduction) : 0;

    const standardHourlyWage = hasSalarySet ? monthlyCtc / (26 * standardDayHours) : 0;
    
    // Determine effective multiplier and rate
    let effectiveMultiplier = otRateMultiplier;
    if (adjustment?.multiplier !== undefined && adjustment.multiplier > 0) {
      effectiveMultiplier = adjustment.multiplier;
    } else if (profile.otRatePerHour !== undefined && profile.otRatePerHour > 0 && profile.otRatePerHour <= 10) {
      // Profile value was entered as a multiplier (e.g. 1.5, 2, 3)
      effectiveMultiplier = profile.otRatePerHour;
    }

    let otRatePerHour = Math.round(standardHourlyWage * effectiveMultiplier * 100) / 100;
    if (profile.otRatePerHour && profile.otRatePerHour > 10 && adjustment?.multiplier === undefined) {
      // Absolute custom rupee rate per hour (if > 10)
      otRatePerHour = profile.otRatePerHour;
    }
    const otEarnings = (profile.otEligible && hasSalarySet) ? Math.round(totalOtHours * otRatePerHour) : 0;

    const dailyWage = hasSalarySet ? grossSalary / totalMonthDays : 0;
    const lopDeduction = Math.round(lopDays * dailyWage);
    // Employee deductions from Gross Salary (Annexure K Row E: Employee PF)
    const totalDeductions = lopDeduction + pfDeduction + esiDeduction;

    // Live Month-to-Date (MTD) Accrued Earnings (scaled dynamically to elapsed days)
    const elapsedEarnings = hasSalarySet ? Math.round(dailyWage * elapsedDays) : 0;
    const grossEarnings = elapsedEarnings + otEarnings;
    const netPayable = hasSalarySet ? Math.max(0, elapsedEarnings - totalDeductions + otEarnings) : 0;
    const netPayableWords = hasSalarySet ? numberToWordsIndian(netPayable) : 'Salary Not Configured';

    return {
      empCode: profile.empCode,
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      dob: profile.dob,
      doj: profile.doj,
      department: profile.department || 'Operations',
      designation: profile.designation || 'Staff',
      location: profile.location || 'Budigere',
      month: formattedMonth,
      monthDays: totalMonthDays,
      elapsedDays,
      presentDays,
      halfDays,
      absentDays,
      lopDays,
      payableDays,
      weeklyOffs,
      holidays: holidayCount,
      totalWorkHours: Number(totalWorkHours.toFixed(1)),
      totalOtHours: Number(totalOtHours.toFixed(1)),
      lateArrivals,
      monthlyCtc,
      basicSalary,
      hra,
      allowances: specialAllowance,
      grossSalary,
      employerPf,
      employerEsic,
      otRatePerHour,
      otEarnings,
      grossEarnings,
      lopDeduction,
      pfDeduction,
      esiDeduction,
      ptDeduction,
      totalDeductions,
      totalNetSalary,
      netPayable,
      netPayableWords,
      bankAccount: profile.bankAccount,
      ifscCode: profile.ifscCode,
      bankName: profile.bankName,
      panNumber: profile.panNumber
    };
  }
}

export const payrollService = new PayrollService();
