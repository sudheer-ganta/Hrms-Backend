export interface EmployeeOtAdjustment {
  otHours?: number;
  multiplier?: number;
  /** HR override of the days worked on a weekly off / paid holiday. Absent = use what the attendance resolver recognized. */
  weeklyOffWorkDays?: number;
  holidayWorkDays?: number;
  /** @deprecated legacy name for weeklyOffWorkDays; still read so saved adjustments keep working. */
  sundayDays?: number;
  /** Monthly pay items typed by HR for one employee (amounts in ₹, never negative). Absent = 0. */
  salaryAdvance?: number;    // recovered from net pay
  otherDeduction?: number;   // recovered from net pay
  lwf?: number;              // Labour Welfare Fund, recovered from net pay
  attendanceBonus?: number;  // "Other / Attn bonus", added to net pay (not part of PF/ESI/PT wages)
  increment?: number;        // "Increments / Reimbursements", added to net pay (not part of PF/ESI/PT wages)
}

export interface IPayrollAdjustment {
  month: string;
  adjustments: Record<string, EmployeeOtAdjustment>;
  updatedBy?: string;
  updatedAt?: Date;
}
