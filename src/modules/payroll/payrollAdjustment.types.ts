export interface EmployeeOtAdjustment {
  otHours?: number;
  totalWorkHours?: number;
  multiplier?: number;
}

export interface IPayrollAdjustment {
  month: string;
  adjustments: Record<string, EmployeeOtAdjustment>;
  updatedBy?: string;
  updatedAt?: Date;
}
