export interface PayslipLine {
  code: string;
  label: string;
  amount: number;
  /** Informational detail (e.g. "3 days"). */
  note?: string;
}

/**
 * The payslip is produced by the backend and rendered as-is by the UI:
 *   sum(earnings) - sum(deductions) = netPay      (always, by construction)
 * `employerBorne` lines are shown for information only and are NOT part of the equation.
 */
export interface PayslipBreakdown {
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  employerBorne: PayslipLine[];
  totalEarnings: number;
  totalDeductions: number;
  netPay: number;
}

export interface EmployeePayrollSummary {
  empCode: string;
  name: string;
  email?: string;
  phone?: string;
  dob?: string;
  doj?: string;
  department?: string;
  designation?: string;
  location?: string; // canonical siteId
  siteId?: string;

  // Lifecycle
  payrollStatus: 'LIVE' | 'CLOSED';
  isProvisional: boolean; // true while the month is still open (figures can change)
  snapshotVersion?: number;
  rulesVersion: string;

  // Attendance & time breakdown (all from the attendance resolver)
  month: string; // YYYY-MM
  monthDays: number;
  elapsedDays: number;
  presentDays: number;     // PRESENT + WFH + OD + MISSED_PUNCH
  halfDays: number;
  absentDays: number;      // ABSENT
  leaveDays: number;       // paid leave
  unpaidLeaveDays: number;
  missedPunchDays: number;
  wfhDays: number;
  onDutyDays: number;
  lopDays: number;         // absent + unpaid leave + halfDays * halfDayLopFraction
  payableDays: number;
  weeklyOffs: number;
  holidays: number;
  totalWorkHours: number;
  totalOtHours: number;
  lateArrivals: number;

  // Earnings (₹)
  monthlyCtc: number;
  basicSalary: number;
  hra: number;
  allowances: number; // special allowance
  grossSalary: number;
  da: number;
  otherAllowance: number;
  otWageBase: number;
  otDailyWage: number;
  otHourlyWage: number;
  otHoursPerDay: number;
  otEligible: boolean;
  otMultiplier: number;
  otRatePerHour: number;
  otEarnings: number;
  /** Days worked on a weekly off / paid holiday that payroll prices (effective = HR override if present, else the resolver's). */
  weeklyOffWorkDays: number;
  holidayWorkDays: number;
  /** What the attendance resolver recognized under policy.offDayWork, before any HR override. */
  weeklyOffWorkAutoDays: number;
  holidayWorkAutoDays: number;
  offDayWorkOverridden: boolean;
  weeklyOffWorkEarnings: number;
  holidayWorkEarnings: number;
  /** @deprecated only present on rows frozen before the weekly-off / holiday split. */
  sundayDays?: number;
  sundayEarnings?: number;
  grossEarnings: number; // accrued earnings for elapsed days + OT + weekly-off / holiday work

  // Statutory & employer contributions (₹)
  employerPf: number;
  employerEsic: number;

  // Deductions (₹)
  lopDeduction: number;
  pfDeduction: number;
  esiDeduction: number;
  ptDeduction: number;       // PT amount for the month (employer-borne unless payroll rules say otherwise)
  ptDeductedFromNet: boolean;
  totalDeductions: number;   // lop + pf + esi (+ pt when ptDeductedFromNet)

  // Final pay
  totalNetSalary: number;
  netPayable: number;
  netPayableWords: string;

  payslip: PayslipBreakdown;

  bankAccount?: string;
  ifscCode?: string;
  bankName?: string;
  panNumber?: string;
}

export interface SendPayslipRequest {
  empCode: string;
  month: string;
  recipientEmail?: string;
}

export interface SendPayslipResponse {
  success: boolean;
  message: string;
  sentTo: string;
  previewHtml?: string;
}
