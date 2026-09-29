export interface EmployeeOtAdjustment {
  otHours?: number;
  totalWorkHours?: number;
  multiplier?: number;
  sundayDays?: number; // Sundays worked (fractional allowed, e.g. 1.5)
}

export interface IPayrollAdjustment {
  month: string;
  adjustments: Record<string, EmployeeOtAdjustment>;
  updatedBy?: string;
  updatedAt?: Date;
}
