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
import { payrollRunService } from './payrollRun.service.js';

// Late-arrival cutoff = configured shift start time + grace period, expressed in
// minutes-since-midnight, so it reflects Settings instead of a hardcoded time.
function getLateThresholdMinutes(policy: HRMSPolicySettings): number {
  const [startHour, startMin] = (policy.shift?.startTime || '09:00').split(':').map(Number);
  const graceMinutes = policy.shift?.gracePeriodMinutes ?? 15;
  return (startHour || 9) * 60 + (startMin || 0) + graceMinutes;
}

class PayrollService {
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

    const profile = (await employeeMasterService.getProfile(empCode)) || {
      empCode,
      name: `Employee ${empCode}`,
      otEligible: true,
      status: 'active' as const
    };

    const targetDate = monthStr ? new Date(`${monthStr}-01`) : new Date();
    const mStart = startOfMonth(targetDate);
    const mEnd = endOfMonth(targetDate);
    const formattedMonth = format(mStart, 'yyyy-MM');
    const daysInMonth = eachDayOfInterval({ start: mStart, end: mEnd });
    const totalMonthDays = daysInMonth.length;

    // Holidays & Policies
    const policy = policyService.getSettings();
    const holidays = policy.holidays || [];
    const holidayDates = new Set(holidays.map(h => h.date));
    const weeklyOffList = policy.weeklyOffDays || ['Sunday'];
    const standardDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 8.0);
    const minFullDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 8.0);
    const minHalfDayHours = (policy.shift?.halfDayThresholdMinutes ? policy.shift.halfDayThresholdMinutes / 60 : 4.0);
    const otRateMultiplier = policy.overtime?.defaultRateMultiplier || 1.5;
    const lateThresholdMinutes = getLateThresholdMinutes(policy);

    // Filter in-out records and raw punches — reads from MongoDB when connected
    // (the source of truth going forward) and only falls back to the local JSON
    // store when Mongo is unavailable, matching the rest of the app.
    const isDbConnected = mongoose.connection.readyState === 1;
    const inOutList = isDbConnected
      ? await InOutModel.find({ employeeCode: empCode }).lean()
      : localStore.getInOutRecords().filter(r => r.employeeCode === empCode);
    const inOutMap = new Map<string, typeof inOutList[0]>();
    for (const r of inOutList) {
      if (r.date) inOutMap.set(r.date, r);
    }

    const punchesList = isDbConnected
      ? await AttendanceModel.find({ employeeCode: empCode }).lean()
      : localStore.getRecords().filter(p => p.employeeCode === empCode);
    const punchesMap = new Map<string, typeof punchesList>();
    for (const p of punchesList) {
      const dStr = p.entryDate || (p.punchDateTime ? new Date(p.punchDateTime).toISOString().substring(0, 10) : '');
      if (dStr) {
        if (!punchesMap.has(dStr)) punchesMap.set(dStr, []);
        punchesMap.get(dStr)!.push(p);
      }
    }

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
      otRateMultiplier,
      lateThresholdMinutes,
      inOutMap,
      punchesMap
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

    const allProfiles = await employeeMasterService.getAllProfiles();
    const isDbConnected = mongoose.connection.readyState === 1;

    const targetDate = monthStr ? new Date(`${monthStr}-01`) : new Date();
    const mStart = startOfMonth(targetDate);
    const mEnd = endOfMonth(targetDate);
    const formattedMonth = format(mStart, 'yyyy-MM');
    const daysInMonth = eachDayOfInterval({ start: mStart, end: mEnd });
    const totalMonthDays = daysInMonth.length;

    // Load policy ONCE
    const policy = policyService.getSettings();
    const holidays = policy.holidays || [];
    const holidayDates = new Set(holidays.map(h => h.date));
    const weeklyOffList = policy.weeklyOffDays || ['Sunday'];
    const standardDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 8.0);
    const minFullDayHours = (policy.shift?.fullDayThresholdMinutes ? policy.shift.fullDayThresholdMinutes / 60 : 8.0);
    const minHalfDayHours = (policy.shift?.halfDayThresholdMinutes ? policy.shift.halfDayThresholdMinutes / 60 : 4.0);
    const otRateMultiplier = policy.overtime?.defaultRateMultiplier || 1.5;
    const lateThresholdMinutes = getLateThresholdMinutes(policy);

    // Pre-index InOut records by [empCode -> [date -> record]]
    const allInOut = isDbConnected ? await InOutModel.find({}).lean() : localStore.getInOutRecords();
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
    const allPunches = isDbConnected ? await AttendanceModel.find({}).lean() : localStore.getRecords();
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

    // Instant O(1) computation loop
    return allProfiles.map((profile) => {
      const empInOutMap = inOutIndex.get(profile.empCode) || emptyInOutMap;
      const empPunchesMap = punchesIndex.get(profile.empCode) || emptyPunchesMap;

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
        otRateMultiplier,
        lateThresholdMinutes,
        empInOutMap,
        empPunchesMap
      );
    });
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
    otRateMultiplier: number,
    lateThresholdMinutes: number,
    inOutByDate: Map<string, any>,
    punchesByDate: Map<string, any[]>
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
        if (ioRec.status === 'P') presentDays++;
        else if (ioRec.status === 'P/2') halfDays++;
        else if (ioRec.status === 'W' || ioRec.status === 'WO') weeklyOffs++;
        else if (ioRec.status === 'HL' || ioRec.status === 'H') holidayCount++;
        else if (ioRec.status === 'A') absentDays++;
        else {
          if (ioRec.workMinutes && ioRec.workMinutes >= 480) presentDays++;
          else if (ioRec.workMinutes && ioRec.workMinutes >= 240) halfDays++;
          else absentDays++;
        }

        const hrs = (ioRec.workMinutes || 0) / 60;
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

        totalWorkHours += durationHours;

        if (profile.otEligible && durationHours > standardDayHours) {
          totalOtHours += (durationHours - standardDayHours);
        }

        if (durationHours >= minFullDayHours) {
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
        halfDays++;
        totalWorkHours += 4.0;
      } else {
        absentDays++;
      }
    }

    // Month-to-Date (MTD) Payable Days Math
    const payableDays = Number((presentDays + (halfDays * 0.5) + weeklyOffs + holidayCount).toFixed(1));
    const lopDays = Math.max(0, Number((elapsedDays - payableDays).toFixed(1)));

    // Compensation & Salary Engine (Annexure K Breakdown)
    const hasSalarySet = profile.monthlyCtc !== undefined && profile.monthlyCtc !== null && Number(profile.monthlyCtc) > 0;
    const monthlyCtc = hasSalarySet ? Number(profile.monthlyCtc) : 0;
    const basicSalary = hasSalarySet ? (profile.basicSalary || Math.round(monthlyCtc * 0.50)) : 0;
    const hra = hasSalarySet ? (profile.hra || Math.round(monthlyCtc * 0.20)) : 0;
    const specialAllowance = hasSalarySet ? (profile.specialAllowance ?? (profile.allowances !== undefined ? profile.allowances : Math.max(0, (profile.grossSalary || (monthlyCtc - 2000)) - basicSalary - hra))) : 0;

    const grossSalary = hasSalarySet ? (profile.grossSalary || (basicSalary + hra + specialAllowance)) : 0;
    const pfDeduction = hasSalarySet ? (profile.employeePf ?? Math.min(1800, Math.round(basicSalary * 0.12))) : 0;
    const esiDeduction = hasSalarySet ? (profile.employeeEsic ?? (monthlyCtc <= 21000 ? Math.round(monthlyCtc * 0.0075) : 0)) : 0;
    const ptDeduction = hasSalarySet ? (profile.professionalTax ?? (monthlyCtc >= 15000 ? 200 : 0)) : 0;

    const standardHourlyWage = hasSalarySet ? monthlyCtc / (26 * standardDayHours) : 0;
    // profile.otRatePerHour lets a specific employee's OT rate be defined individually;
    // otherwise it falls back to the company-wide multiplier set in Settings.
    const otRatePerHour = profile.otRatePerHour || Math.round(standardHourlyWage * otRateMultiplier);
    const otEarnings = (profile.otEligible && hasSalarySet) ? Math.round(totalOtHours * otRatePerHour) : 0;

    const dailyWage = hasSalarySet ? grossSalary / totalMonthDays : 0;
    const lopDeduction = Math.round(lopDays * dailyWage);
    const totalDeductions = lopDeduction + pfDeduction + esiDeduction + ptDeduction;

    // Earnings are scaled to the days that have actually elapsed so far this month
    // (elapsedDays), not the full month — crediting days that haven't happened yet
    // as if already worked would overstate mid-month take-home pay. Basic/HRA/Special
    // Allowance above stay as the full monthly salary structure (Annexure reference
    // figures); only the earnings actually paid out are prorated here.
    const elapsedEarnings = hasSalarySet ? Math.round(dailyWage * elapsedDays) : 0;
    const grossEarnings = elapsedEarnings + otEarnings;
    const netPayable = hasSalarySet ? Math.max(0, grossEarnings - totalDeductions) : 0;
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
      monthDays: elapsedDays || totalMonthDays,
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
      otRatePerHour,
      otEarnings,
      grossEarnings,
      lopDeduction,
      pfDeduction,
      esiDeduction,
      ptDeduction,
      totalDeductions,
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
