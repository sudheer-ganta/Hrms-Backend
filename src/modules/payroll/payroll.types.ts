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
  halfDays: number;        // attendance half days (a paid half-day leave is counted in leaveDays, not here)
  absentDays: number;      // ABSENT
  leaveDays: number;       // paid leave (0.5 for a paid half-day leave)
  unpaidLeaveDays: number; // unpaid leave (0.5 for an unpaid half-day leave)
  missedPunchDays: number;
  wfhDays: number;
  onDutyDays: number;
  lopDays: number;         // absent + unpaid leave + halfDays * halfDayLopFraction
  payableDays: number;
  notEmployedDays?: number;  // elapsed days before the joining date / after the last working day (not absence, not paid)
  weeklyOffs: number;
  holidays: number;
  totalWorkHours: number;
  totalOtHours: number;
  /** Overtime counted this month in whole minutes (totalOtHours is the same figure rounded to one decimal). Absent on older rows. */
  otMinutes?: number;
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
  /** Employer PF admin charge and EDLI (information; not in net pay). Absent on rows frozen before 2026.10-4. */
  employerPfAdmin?: number;
  employerEdli?: number;
  /** Employer's 12% split into the pension scheme (8.33%) and the employer's EPF account (the rest). Absent on older rows. */
  employerEps?: number;
  employerEpf?: number;
  /** The stretches of the month that had a different PF wage ceiling (one stretch in an ordinary month). Absent on older rows. */
  pfSegments?: { fromDay: number; toDay: number; days: number; ceiling: number; wages: number }[];
  /** Wages the PF / ESI were worked out on (earned, without HRA / OT / weekly-off pay). Absent on older rows. */
  pfWages?: number;
  esiWages?: number;

  /**
   * The salary structure (Annexure K) as designed for this month: the contributions that sit inside CTC for a FULL month.
   * Not what was deducted this month (that is pfDeduction / esiDeduction / ptDeduction, prorated by attendance). Absent on older rows.
   */
  salaryStructure?: {
    employeePf: number;
    employerPf: number;
    employeeEsic: number;
    employerEsic: number;
    professionalTax: number;
    minimumBonus: number;
  };

  // Monthly pay items typed by HR (OT Calculator); absent on rows frozen before 2026.10-4
  attendanceBonus?: number;  // added to net
  incrementAmount?: number;  // added to net
  salaryAdvance?: number;    // recovered from net
  otherDeduction?: number;   // recovered from net
  lwfDeduction?: number;     // recovered from net

  // Deductions (₹)
  lopDeduction: number;
  pfDeduction: number;
  esiDeduction: number;
  ptDeduction: number;       // PT amount for the month (employer-borne unless payroll rules say otherwise)
  ptDeductedFromNet: boolean;
  totalDeductions: number;   // lop + pf + esi (+ pt when ptDeductedFromNet) + advance + other deduction + LWF

  // Final pay
  totalNetSalary: number;
  netPayable: number;
  netPayableWords: string;

  payslip: PayslipBreakdown;

  bankAccount?: string;
  ifscCode?: string;
  bankName?: string;
  panNumber?: string;
  uanNumber?: string;
  esiNumber?: string;
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
