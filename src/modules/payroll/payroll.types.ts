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
  monthDays: number;
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
  otRatePerHour: number;
  otEarnings: number; // Calculated Overtime pay
  grossEarnings: number; // Basic + HRA + Allowances + OT

  // Deductions Breakdown (₹)
  lopDeduction: number; // Deducted for absent/unpaid days
  pfDeduction: number; // Provident Fund (if configured)
  esiDeduction: number; // ESI (if configured)
  ptDeduction: number; // Professional Tax (if configured)
  totalDeductions: number;

  // Final Net Pay (₹)
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
