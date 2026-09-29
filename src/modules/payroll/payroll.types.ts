export interface EmployeePayrollSummary {
  empCode: string;
  name: string;
  email?: string;
  phone?: string;
  dob?: string;
  doj?: string;
  department?: string;
  designation?: string;
  location?: string;
  
  // Attendance & Time Breakdown
  month: string; // YYYY-MM
  monthDays: number; // Total calendar days in the target month (e.g. 30 for September)
  elapsedDays: number; // Days elapsed so far this month (equals monthDays for a past/closed month)
  presentDays: number;
  halfDays: number;
  absentDays: number;
  lopDays: number;
  payableDays: number;
  weeklyOffs: number;
  holidays: number;
  totalWorkHours: number;
  totalOtHours: number; // Overtime hours (hours beyond standard 8h/day)
  lateArrivals: number;

  // Earnings Breakdown (₹)
  monthlyCtc: number;
  basicSalary: number;
  hra: number;
  allowances: number;
  grossSalary?: number; // Gross Monthly Salary (D) = Basic + HRA + Special Allowance
  da?: number; // Dearness Allowance (OT wage base component only)
  otWageBase?: number; // Basic + DA — base for OT and Sunday pay
  otDailyWage?: number; // otWageBase / 26 (display)
  otHourlyWage?: number; // otWageBase / 26 / hoursPerDay (display, before multiplier)
  otHoursPerDay?: number; // Global OT policy standard hours/day (default 8)
  otEligible?: boolean;
  otMultiplier?: number; // Effective OT multiplier applied
  otRatePerHour: number;
  otEarnings: number; // Calculated Overtime pay
  sundayDays?: number; // Sundays worked (fractional allowed)
  sundayEarnings?: number; // (Basic + DA) / 26 x 2 x sundayDays
  grossEarnings: number; // Basic + HRA + Allowances + OT

  // Statutory & Company Contributions (₹)
  employerPf?: number; // Employer Contribution to PF (H) (e.g. ₹1,800)
  employerEsic?: number; // Employer Contribution to ESIC (I)

  // Deductions Breakdown (₹)
  lopDeduction: number; // Deducted for absent/unpaid days
  pfDeduction: number; // Employee Provident Fund (E)
  esiDeduction: number; // Employee ESI (F)
  ptDeduction: number; // Professional Tax (J)
  totalDeductions: number;

  // Final Net Pay (₹)
  totalNetSalary?: number; // Net Salary before PT (G) = Gross - Employee PF/ESI
  netPayable: number;
  netPayableWords: string;

  // Payment Channel
  bankAccount?: string;
  ifscCode?: string;
  bankName?: string;
  panNumber?: string;
}

export interface SendPayslipRequest {
  empCode: string;
  month: string; // YYYY-MM
  recipientEmail?: string;
  customMessage?: string;
}

export interface SendPayslipResponse {
  success: boolean;
  message: string;
  previewUrl?: string;
  sentTo: string;
}
