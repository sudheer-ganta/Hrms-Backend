export interface EmployeeOtAdjustment {
  otHours?: number;
  totalWorkHours?: number;
  multiplier?: number;
  /** HR override of the days worked on a weekly off / paid holiday. Absent = use what the attendance resolver recognized. */
  weeklyOffWorkDays?: number;
  holidayWorkDays?: number;
  /** @deprecated legacy name for weeklyOffWorkDays; still read so saved adjustments keep working. */
  sundayDays?: number;
}

export interface IPayrollAdjustment {
  month: string;
  adjustments: Record<string, EmployeeOtAdjustment>;
  updatedBy?: string;
  updatedAt?: Date;
}
