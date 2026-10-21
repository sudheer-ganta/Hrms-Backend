import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { computeSalaryBreakdown, SalaryInputs } from '../employees/salary.js';
import { EmployeeProfile } from '../employees/employeeMaster.types.js';
import { policyService, pfPolicy, pctToRate, pfSalaryTerms } from '../settings/policy.service.js';
import { HRMSPolicySettings } from '../settings/policy.types.js';
import { attendanceDayService } from '../attendance/attendanceDay.service.js';
import { ResolvedDay } from '../attendance/attendanceResolver.js';
import { EmployeePayrollSummary, PayslipBreakdown, PayslipLine } from './payroll.types.js';
import { numberToWordsIndian } from './numberToWords.js';
import { payrollRunService } from './payrollRun.service.js';
import { payrollAdjustmentService } from './payrollAdjustment.service.js';
import { EmployeeOtAdjustment } from './payrollAdjustment.types.js';
import { PAYROLL_RULES as R } from './payroll.config.js';
import { pfWagesForMonth } from './pfRule.js';
import { salaryAsOf } from '../employees/salaryRevisions.js';
import { employedDuring, outsideEmployment } from '../employees/employment.js';
import { ApiError } from '../../utils/apiError.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { istMonth, istToday, isValidBusinessMonth } from '../../utils/istTime.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Stored profile → salary inputs. Zero/blank values for basic/gross mean "not set" (as before); HRA 0 is a real zero. */
export const profileSalaryInputs = (p: EmployeeProfile): SalaryInputs => ({
  monthlyCtc: p.monthlyCtc,
  basicSalary: p.basicSalary || undefined,
  da: p.da,
  hra: p.hra ?? undefined, // an explicit 0 is honored (no HRA in the salary); blank = derive from CTC
  specialAllowance: p.specialAllowance,
  otherAllowance: p.otherAllowance,
  employeePf: p.employeePf,
  employerPf: p.employerPf,
  employeeEsic: p.employeeEsic,
  employerEsic: p.employerEsic,
  professionalTax: p.professionalTax,
  minimumBonus: p.minimumBonus,
  grossSalary: p.grossSalary || undefined,
});

export interface ComputeArgs {
  profile: EmployeeProfile;
  month: string;
  days: ResolvedDay[]; // every date of the month, from the attendance resolver
  policy: HRMSPolicySettings;
  adjustment?: EmployeeOtAdjustment;
}

/**
 * PURE payroll formula for one employee-month. No I/O. The ONLY place salary math lives.
 * (Statutory constants: payroll.config.ts. Salary structure: employees/salary.ts.)
 */
export function computeEmployeePayroll({ profile: currentProfile, month, days, policy, adjustment }: ComputeArgs): EmployeePayrollSummary {
  // Each month is priced with the salary that was in force for THAT month (see employees/salaryRevisions.ts).
  const profile = salaryAsOf(currentProfile, month);
  const monthDays = days.length;
  let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, unpaidLeaveDays = 0, weeklyOffs = 0, holidayCount = 0;
  let missedPunchDays = 0, wfhDays = 0, onDutyDays = 0, elapsedDays = 0, lateArrivals = 0, notEmployedDays = 0;
  let workMinutes = 0, otMinutes = 0, weeklyOffWorkAuto = 0, holidayWorkAuto = 0;

  for (const d of days) {
    if (d.isFuture || !d.status) continue;
    elapsedDays++;
    // Before joining / after the last working day the person was not employed: not an absence, not paid, not loss of pay.
    if (outsideEmployment(profile, d.businessDate)) { notEmployedDays++; continue; }
    switch (d.status) {
      case 'PRESENT': presentDays++; break;
      case 'WORK_FROM_HOME': presentDays++; wfhDays++; break;
      case 'ON_DUTY': presentDays++; onDutyDays++; break;
      case 'MISSED_PUNCH': presentDays++; missedPunchDays++; break;
      // An approved paid half-day leave (the resolver sets leaveFraction 0.5) is leave, not a shortfall: the leave
      // balance already pays for that half, so it must not also cost loss of pay.
      case 'HALF_DAY': if (d.leaveFraction > 0) leaveDays += d.leaveFraction; else halfDays++; break;
      case 'ABSENT': absentDays++; break;
      case 'LEAVE_PAID': leaveDays++; break;
      // An unpaid half-day leave loses half a day of pay, not the whole day.
      case 'LEAVE_UNPAID': unpaidLeaveDays += d.leaveFraction > 0 ? d.leaveFraction : 1; break;
      case 'WEEKLY_OFF': weeklyOffs++; break;
      case 'HOLIDAY': holidayCount++; break;
    }
    if (d.offDayWorkFraction > 0) { if (d.status === 'HOLIDAY') holidayWorkAuto += d.offDayWorkFraction; else weeklyOffWorkAuto += d.offDayWorkFraction; }
    workMinutes += d.creditedWorkMinutes;
    otMinutes += d.overtimeMinutes;
    if (d.isLate && (d.status === 'PRESENT' || d.status === 'HALF_DAY' || d.status === 'MISSED_PUNCH')) lateArrivals++;
  }

  const totalWorkHours = workMinutes / 60;
  // Overtime hours come from the punches (time inside each shift's OT windows), unless HR typed an explicit figure.
  const totalOtHours = adjustment?.otHours !== undefined && adjustment.otHours >= 0
    ? adjustment.otHours
    : policy.overtime?.enabled !== false
    ? otMinutes / 60
    : 0;

  const lopDays = absentDays + unpaidLeaveDays + halfDays * R.halfDayLopFraction;
  const payableDays = Math.max(0, elapsedDays - notEmployedDays - lopDays);

  // ---- salary structure: ONE formula (employees/salary.ts) ----
  const sal = computeSalaryBreakdown(profileSalaryInputs(profile), pfSalaryTerms(policy, `${month}-31`));
  const hasSalary = !!sal;
  const monthlyCtc = sal?.monthlyCtc ?? 0;
  const basic = sal?.basicSalary ?? 0;
  const da = sal?.da ?? 0;
  const hra = sal?.hra ?? 0;
  const special = sal?.specialAllowance ?? 0;
  const other = sal?.otherAllowance ?? 0;
  const gross = sal?.grossSalary ?? 0;

  // ---- overtime & Sunday work ----
  const otWageBase = basic + da;
  const hoursPerDay = policy.overtime.hoursPerDay > 0 ? policy.overtime.hoursPerDay : 8;
  const hourlyWage = hasSalary ? otWageBase / R.otWageDivisorDays / hoursPerDay : 0;

  const profMult = profile.otMultiplier && profile.otMultiplier > 0 ? profile.otMultiplier : undefined;
  // One OT rate: hourly wage x multiplier (this month's HR override, else the employee's, else the company default).
  const adjMult = adjustment?.multiplier !== undefined && adjustment.multiplier > 0 ? adjustment.multiplier : undefined;
  const effectiveMultiplier = adjMult ?? profMult ?? R.defaultOtMultiplier;
  const exactOtRate = hourlyWage * effectiveMultiplier;

  const otEligible = profile.otEligible !== false;
  const otEarnings = otEligible && hasSalary ? r2(totalOtHours * exactOtRate) : 0;
  // The resolver (under policy.offDayWork) decides what was worked; an explicit, audited HR adjustment may replace
  // either number. Payroll only prices the days: it never re-derives them from punches.
  const pick = (override: number | undefined, auto: number) => (override !== undefined && override >= 0 ? override : auto);
  const weeklyOffWorkDays = pick(adjustment?.weeklyOffWorkDays ?? adjustment?.sundayDays, weeklyOffWorkAuto);
  const holidayWorkDays = pick(adjustment?.holidayWorkDays, holidayWorkAuto);
  const offDayDaily = hasSalary ? otWageBase / R.otWageDivisorDays : 0;
  const weeklyOffWorkEarnings = otEligible && hasSalary ? r2(offDayDaily * R.weeklyOffWorkMultiplier * weeklyOffWorkDays) : 0;
  const holidayWorkEarnings = otEligible && hasSalary ? r2(offDayDaily * R.holidayWorkMultiplier * holidayWorkDays) : 0;
  const offDayWorkEarnings = r2(weeklyOffWorkEarnings + holidayWorkEarnings);
  const offDayWorkOverridden = weeklyOffWorkDays !== weeklyOffWorkAuto || holidayWorkDays !== holidayWorkAuto;

  // ---- pay ----
  const dailyWage = hasSalary ? gross / monthDays : 0;
  const lopDeduction = Math.round(lopDays * dailyWage);
  const accruedEarnings = hasSalary ? Math.round(dailyWage * elapsedDays) : 0; // every elapsed calendar day
  const elapsedEarnings = hasSalary ? Math.round(dailyWage * (elapsedDays - notEmployedDays)) : 0; // employed days only
  const notEmployedAmount = accruedEarnings - elapsedEarnings;

  // ---- statutory deductions: the company's statement method (payroll.config.ts, 2026.10-4) ----
  // Earned fixed pay = the salary for the payable days only; PF / ESI wages leave out HRA, OT and weekly-off/holiday pay.
  const earnedFixed = dailyWage * payableDays;
  const nonHraFixed = Math.max(0, gross - hra);
  const earnedNonHra = monthDays > 0 ? (nonHraFixed / monthDays) * payableDays : 0;
  // PF wages follow the ceiling in force on each day of the month (15,000, then 25,000 from 17 Sep 2026): pfRule.ts.
  // The PF rates and ceilings are the policy's (Settings → PF), so a change in the law is an edit, not a deploy.
  const pfRules = pfPolicy(policy);
  const pfCalc = pfWagesForMonth(month, monthDays, hasSalary ? Math.round(earnedNonHra) : 0, pfRules.ceilings);
  const pfWages = pfCalc.wages;
  const pf = Math.round(pfWages * pctToRate(pfRules.employeeRatePct));
  const erPf = pf; // the employer pays the same share as the employee
  const erEps = Math.min(erPf, Math.round(pfWages * pctToRate(pfRules.epsRatePct)));
  const erEpf = erPf - erEps;
  // Admin charge and EDLI are a % of the PF wages, worked out from the rounded PF (pf / PF rate = the wages).
  const erPfAdmin = Math.round((pf * pfRules.adminRatePct) / pfRules.employeeRatePct);
  const erEdli = Math.round((pf * pfRules.edliRatePct) / pfRules.employeeRatePct);
  const esiEligible = hasSalary && nonHraFixed <= R.esiWageCeiling;
  const esiWages = esiEligible ? r2(earnedNonHra) : 0;
  const esi = esiEligible ? Math.ceil(r2(esiWages * R.esiEmployeeRate)) : 0; // rounded UP, as the statement does
  const erEsic = esiEligible ? Math.round(esiWages * R.esiEmployerRate) : 0;
  // PT is worked out on the earned gross including OT and weekly-off / holiday pay.
  const earnedGross = Math.round(earnedFixed + otEarnings + offDayWorkEarnings);
  const pt = hasSalary && earnedGross >= R.ptGrossThreshold ? R.ptMonthly : 0;
  const ptInDeductions = R.ptDeductedFromNet ? pt : 0;

  // ---- pay items HR types each month (OT Calculator) ----
  const item = (v: number | undefined) => (v !== undefined && v > 0 ? r2(v) : 0);
  const salaryAdvance = hasSalary ? item(adjustment?.salaryAdvance) : 0;
  const otherDeduction = hasSalary ? item(adjustment?.otherDeduction) : 0;
  const lwfDeduction = hasSalary ? item(adjustment?.lwf) : 0;
  const attendanceBonus = hasSalary ? item(adjustment?.attendanceBonus) : 0;
  const incrementAmount = hasSalary ? item(adjustment?.increment) : 0;

  const totalDeductions = lopDeduction + pf + esi + ptInDeductions + salaryAdvance + otherDeduction + lwfDeduction;
  const statementDeductions = pf + esi + ptInDeductions + salaryAdvance + otherDeduction + lwfDeduction;
  // Net pay = (earned gross rounded) - deductions, plus the bonus / reimbursement items; never below zero.
  const exactNet = hasSalary ? earnedGross - statementDeductions + attendanceBonus + incrementAmount : 0;
  const netPayable = hasSalary ? Math.max(0, Math.round(exactNet)) : 0;
  const grossEarnings = Math.round(elapsedEarnings + otEarnings + offDayWorkEarnings);

  // ---- payslip: lines foot to net pay by construction ----
  const earnings: PayslipLine[] = [];
  const deductions: PayslipLine[] = [];
  if (hasSalary) {
    earnings.push({ code: 'BASIC', label: 'Basic', amount: basic });
    if (da) earnings.push({ code: 'DA', label: 'Dearness Allowance', amount: da });
    earnings.push({ code: 'HRA', label: 'HRA', amount: hra });
    earnings.push({ code: 'SPECIAL', label: 'Special Allowance', amount: special });
    if (other) earnings.push({ code: 'OTHER', label: 'Other Allowance', amount: other });
    const componentSum = basic + da + hra + special + other;
    if (Math.abs(gross - componentSum) >= 0.005) {
      earnings.push({ code: 'RECON', label: 'Salary structure adjustment', amount: r2(gross - componentSum) });
    }
    if (otEarnings > 0) earnings.push({ code: 'OT', label: 'Overtime', amount: otEarnings, note: `${r2(totalOtHours)}h @ ₹${r2(exactOtRate)}/h` });
    if (weeklyOffWorkEarnings > 0) earnings.push({ code: 'WEEKLY_OFF_WORK', label: 'Weekly-off Working', amount: weeklyOffWorkEarnings, note: `${weeklyOffWorkDays} day(s) @ ${R.weeklyOffWorkMultiplier}x` });
    if (holidayWorkEarnings > 0) earnings.push({ code: 'HOLIDAY_WORK', label: 'Paid-holiday Working', amount: holidayWorkEarnings, note: `${holidayWorkDays} day(s) @ ${R.holidayWorkMultiplier}x` });
    if (attendanceBonus > 0) earnings.push({ code: 'ATTN_BONUS', label: 'Other / Attendance Bonus', amount: attendanceBonus });
    if (incrementAmount > 0) earnings.push({ code: 'INCREMENT', label: 'Increments / Reimbursements', amount: incrementAmount });
    const notAccrued = gross - accruedEarnings;
    if (Math.abs(notAccrued) >= 0.005) deductions.push({ code: 'NOT_ACCRUED', label: 'Days not yet accrued', amount: r2(notAccrued), note: `${monthDays - elapsedDays} day(s)` });
    if (notEmployedAmount > 0) deductions.push({ code: 'NOT_EMPLOYED', label: 'Days outside employment', amount: notEmployedAmount, note: `${notEmployedDays} day(s)` });
    if (lopDeduction > 0) deductions.push({ code: 'LOP', label: 'Loss of Pay', amount: lopDeduction, note: `${r2(lopDays)} day(s)` });
    // Each statutory line says what it was worked out on, so the employee can see why it was cut.
    const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    const pfNote = pfCalc.segments.length > 1
      ? `${pfRules.employeeRatePct}% of ${inr(pfWages)} PF wages (${pfCalc.segments.map((s) => `${inr(s.ceiling)} ceiling for ${s.days} day(s)`).join(' + ')})`
      : `${pfRules.employeeRatePct}% of ${inr(pfWages)} PF wages`;
    if (pf > 0) deductions.push({ code: 'PF', label: 'Employee PF', amount: pf, note: pfNote });
    if (esi > 0) deductions.push({ code: 'ESI', label: 'Employee ESIC', amount: esi, note: `0.75% of ${inr(esiWages)} wages, rounded up` });
    if (ptInDeductions > 0) deductions.push({ code: 'PT', label: 'Professional Tax', amount: ptInDeductions, note: `earned gross ${inr(earnedGross)} is ${inr(R.ptGrossThreshold)} or more` });
    if (salaryAdvance > 0) deductions.push({ code: 'ADVANCE', label: 'Salary Advance', amount: salaryAdvance });
    if (otherDeduction > 0) deductions.push({ code: 'OTHER_DEDUCTION', label: 'Other Deduction', amount: otherDeduction });
    if (lwfDeduction > 0) deductions.push({ code: 'LWF', label: 'Labour Welfare Fund', amount: lwfDeduction });
  }
  const sum = (ls: PayslipLine[]) => r2(ls.reduce((a, l) => a + l.amount, 0));
  let totalEarnings = sum(earnings);
  let totalDed = sum(deductions);
  if (hasSalary) {
    const residual = r2(netPayable - (totalEarnings - totalDed)); // rounding and the zero floor
    if (residual > 0) { earnings.push({ code: 'ROUNDING', label: 'Rounding / minimum-pay adjustment', amount: residual }); totalEarnings = sum(earnings); }
    else if (residual < 0) { deductions.push({ code: 'ROUNDING', label: 'Rounding adjustment', amount: -residual }); totalDed = sum(deductions); }
  }
  const employerBorne: PayslipLine[] = [];
  if (hasSalary) {
    employerBorne.push({ code: 'ER_PF', label: 'Employer PF', amount: erPf });
    if (erPfAdmin > 0) employerBorne.push({ code: 'ER_PF_ADMIN', label: 'Employer PF Admin Charge', amount: erPfAdmin });
    if (erEdli > 0) employerBorne.push({ code: 'ER_EDLI', label: 'Employer EDLI', amount: erEdli });
    if (erEsic > 0) employerBorne.push({ code: 'ER_ESIC', label: 'Employer ESIC', amount: erEsic });
    if (!R.ptDeductedFromNet && pt > 0) employerBorne.push({ code: 'PT', label: 'Professional Tax (included in CTC, not deducted)', amount: pt });
  }
  const payslip: PayslipBreakdown = { earnings, deductions, employerBorne, totalEarnings, totalDeductions: totalDed, netPay: netPayable };

  return {
    empCode: profile.empCode,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    dob: profile.dob,
    doj: profile.doj,
    department: profile.department,
    designation: profile.designation,
    location: profile.location,
    siteId: profile.location,
    payrollStatus: 'LIVE',
    isProvisional: true,
    rulesVersion: R.version,
    month,
    monthDays,
    elapsedDays,
    presentDays,
    halfDays,
    absentDays,
    leaveDays,
    unpaidLeaveDays,
    missedPunchDays,
    wfhDays,
    onDutyDays,
    lopDays,
    payableDays,
    notEmployedDays,
    weeklyOffs,
    holidays: holidayCount,
    totalWorkHours: Number(totalWorkHours.toFixed(1)),
    totalOtHours: Number(totalOtHours.toFixed(1)),
    otMinutes: Math.round(totalOtHours * 60), // the exact overtime counted (after any HR override), shown as hours and minutes
    lateArrivals,
    monthlyCtc,
    basicSalary: basic,
    hra,
    allowances: special,
    grossSalary: gross,
    da,
    otherAllowance: other,
    otWageBase,
    otDailyWage: hasSalary ? r2(otWageBase / R.otWageDivisorDays) : 0,
    otHourlyWage: r2(hourlyWage),
    otHoursPerDay: hoursPerDay,
    otEligible,
    otMultiplier: effectiveMultiplier,
    otRatePerHour: r2(exactOtRate),
    otEarnings,
    weeklyOffWorkDays,
    holidayWorkDays,
    weeklyOffWorkAutoDays: weeklyOffWorkAuto,
    holidayWorkAutoDays: holidayWorkAuto,
    offDayWorkOverridden,
    weeklyOffWorkEarnings,
    holidayWorkEarnings,
    grossEarnings,
    employerPf: erPf,
    employerEsic: erEsic,
    employerPfAdmin: erPfAdmin,
    employerEdli: erEdli,
    employerEps: erEps,
    employerEpf: erEpf,
    pfSegments: pfCalc.segments,
    pfWages,
    esiWages,
    salaryStructure: sal
      ? {
          employeePf: sal.employeePf, employerPf: sal.employerPf, employeeEsic: sal.employeeEsic,
          employerEsic: sal.employerEsic, professionalTax: sal.professionalTax, minimumBonus: sal.minimumBonus,
        }
      : undefined,
    attendanceBonus,
    incrementAmount,
    salaryAdvance,
    otherDeduction,
    lwfDeduction,
    lopDeduction,
    pfDeduction: pf,
    esiDeduction: esi,
    ptDeduction: pt,
    ptDeductedFromNet: R.ptDeductedFromNet,
    totalDeductions,
    totalNetSalary: sal?.totalNetSalary ?? 0,
    netPayable,
    netPayableWords: hasSalary ? numberToWordsIndian(netPayable) : 'Salary Not Configured',
    payslip,
    bankAccount: profile.bankAccount,
    ifscCode: profile.ifscCode,
    bankName: profile.bankName,
    panNumber: profile.panNumber,
    uanNumber: profile.uanNumber,
    esiNumber: profile.esiNumber,
  };
}

/** Rows frozen before payslip lines existed get a best-effort footing breakdown. */
function withPayslip(row: EmployeePayrollSummary): EmployeePayrollSummary {
  if (row.payslip) return row;
  const earnings: PayslipLine[] = [
    { code: 'BASIC', label: 'Basic', amount: row.basicSalary || 0 },
    { code: 'HRA', label: 'HRA', amount: row.hra || 0 },
    { code: 'SPECIAL', label: 'Special Allowance', amount: row.allowances || 0 },
  ];
  const deductions: PayslipLine[] = [];
  if (row.otEarnings > 0) earnings.push({ code: 'OT', label: 'Overtime', amount: row.otEarnings });
  if ((row.weeklyOffWorkEarnings ?? 0) > 0) earnings.push({ code: 'WEEKLY_OFF_WORK', label: 'Weekly-off Working', amount: row.weeklyOffWorkEarnings! });
  if ((row.holidayWorkEarnings ?? 0) > 0) earnings.push({ code: 'HOLIDAY_WORK', label: 'Paid-holiday Working', amount: row.holidayWorkEarnings! });
  if ((row.sundayEarnings ?? 0) > 0) earnings.push({ code: 'SUNDAY', label: 'Weekly-off / Holiday Working (legacy)', amount: row.sundayEarnings! });
  if (row.lopDeduction > 0) deductions.push({ code: 'LOP', label: 'Loss of Pay', amount: row.lopDeduction });
  if (row.pfDeduction > 0) deductions.push({ code: 'PF', label: 'Employee PF', amount: row.pfDeduction });
  if (row.esiDeduction > 0) deductions.push({ code: 'ESI', label: 'Employee ESIC', amount: row.esiDeduction });
  const te = r2(earnings.reduce((a, l) => a + l.amount, 0));
  const td = r2(deductions.reduce((a, l) => a + l.amount, 0));
  const gap = r2(row.netPayable - (te - td));
  if (gap > 0) earnings.push({ code: 'ROUNDING', label: 'Adjustment (legacy snapshot)', amount: gap });
  else if (gap < 0) deductions.push({ code: 'ROUNDING', label: 'Adjustment (legacy snapshot)', amount: -gap });
  const employerBorne: PayslipLine[] = [];
  if ((row.employerPf ?? 0) > 0) employerBorne.push({ code: 'ER_PF', label: 'Employer PF', amount: row.employerPf! });
  if ((row.employerEsic ?? 0) > 0) employerBorne.push({ code: 'ER_ESIC', label: 'Employer ESIC', amount: row.employerEsic! });
  if (row.ptDeduction > 0) employerBorne.push({ code: 'PT', label: 'Professional Tax (not deducted)', amount: row.ptDeduction });
  const sum = (ls: PayslipLine[]) => r2(ls.reduce((a, l) => a + l.amount, 0));
  return { ...row, payslip: { earnings, deductions, employerBorne, totalEarnings: sum(earnings), totalDeductions: sum(deductions), netPay: row.netPayable } };
}

class PayrollService {
  private normalizeAdjustments(map: Record<string, EmployeeOtAdjustment>): Record<string, EmployeeOtAdjustment> {
    const out: Record<string, EmployeeOtAdjustment> = {};
    for (const [k, v] of Object.entries(map || {})) out[normalizeEmpCode(k)] = v;
    return out;
  }

  private assertReady(): void {
    if (!policyService.isLoaded()) throw ApiError.unavailable('Policy settings are not loaded yet. Payroll cannot be calculated.');
  }

  private resolveMonthArg(month?: string): string {
    const m = month ?? istMonth();
    if (!isValidBusinessMonth(m)) throw ApiError.validation('Month must be YYYY-MM.', [{ field: 'month', issue: 'Invalid format' }]);
    return m;
  }

  /**
   * Payroll for every employee. CLOSED month => the frozen snapshot, verbatim.
   * Otherwise computed live. `adjustmentsOverride` prices UNSAVED OT edits (preview only).
   * `forceLive` is used by the close operation to compute the figures that will be frozen.
   */
  public async calculateAllEmployeesPayroll(
    monthStr?: string,
    opts: { adjustmentsOverride?: Record<string, EmployeeOtAdjustment>; forceLive?: boolean } = {}
  ): Promise<EmployeePayrollSummary[]> {
    const month = this.resolveMonthArg(monthStr);
    const isPreview = opts.adjustmentsOverride !== undefined;

    if (!isPreview && !opts.forceLive) {
      const closed = await payrollRunService.getClosedRun(month);
      if (closed) {
        return closed.snapshot.map((row) => withPayslip({ ...row, payrollStatus: 'CLOSED', isProvisional: false, snapshotVersion: closed.version }));
      }
    }
    this.assertReady();

    const policy = policyService.getSettings();
    const [profiles, rawAdj] = await Promise.all([
      employeeMasterService.getAllProfiles(),
      isPreview ? Promise.resolve(opts.adjustmentsOverride!) : payrollAdjustmentService.getAdjustments(month),
    ]);
    const adjustments = this.normalizeAdjustments(rawAdj);
    const resolved = await attendanceDayService.resolveMonth(profiles.map((p) => p.empCode), month, policy, istToday());

    return profiles.filter((profile) => employedDuring(profile, month)).map((profile) =>
      computeEmployeePayroll({
        profile,
        month,
        days: resolved.get(profile.empCode) || [],
        policy,
        adjustment: adjustments[profile.empCode],
      })
    );
  }

  public async calculateEmployeePayroll(empCode: string, monthStr?: string): Promise<EmployeePayrollSummary> {
    const month = this.resolveMonthArg(monthStr);
    const code = normalizeEmpCode(empCode);
    const closed = await payrollRunService.getClosedRun(month);
    if (closed) {
      const row = closed.snapshot.find((s) => normalizeEmpCode(s.empCode) === code);
      if (!row) throw ApiError.notFound(`Employee ${code} has no record in the closed ${month} payroll.`);
      // UAN / ESI numbers are identity data, not payroll figures: snapshots frozen before they existed read them from the profile.
      const ids = row.uanNumber !== undefined && row.esiNumber !== undefined ? undefined : await employeeMasterService.findProfile(code);
      return withPayslip({
        ...row,
        uanNumber: row.uanNumber ?? ids?.uanNumber,
        esiNumber: row.esiNumber ?? ids?.esiNumber,
        payrollStatus: 'CLOSED', isProvisional: false, snapshotVersion: closed.version,
      });
    }
    this.assertReady();
    const policy = policyService.getSettings();
    const profile = await employeeMasterService.requireProfile(code);
    const [adj, resolved] = await Promise.all([
      payrollAdjustmentService.getAdjustments(month),
      attendanceDayService.resolveMonth([code], month, policy, istToday()),
    ]);
    return computeEmployeePayroll({
      profile,
      month,
      days: resolved.get(code) ?? [],
      policy,
      adjustment: this.normalizeAdjustments(adj)[code],
    });
  }
}

export const payrollService = new PayrollService();
