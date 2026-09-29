export interface EmployeeProfile {
  empCode: string;
  name: string;
  email?: string;
  phone?: string;
  dob?: string; // YYYY-MM-DD
  doj?: string; // YYYY-MM-DD (Date of Joining)
  joiningDate?: string; // Compatibility alias
  department?: string;
  designation?: string;
  location?: string;
  operationsCategory?: string; // e.g. "Office Staff (3)"
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: string;
  emergencyContact?: string;
  managerEmpCode?: string;
  managerName?: string;
  shiftName?: string;
  
  // Annexure K — ColorMyles CTC & Salary Structure
  monthlyCtc?: number; // Total Gross CTC (L) PM (e.g. 30,000)
  annualCtc?: number; // Total Gross CTC (L) PA (e.g. 360,000)
  basicSalary?: number; // Basic (A) PM (e.g. 15,000)
  da?: number; // Dearness Allowance PM — used only as part of the OT wage base (Basic + DA)
  fixedSalary?: number; // Fixed Salary (B) PM (e.g. 15,000)
  hra?: number; // HRA (C1) PM (e.g. 6,000)
  specialAllowance?: number; // Special Allowance (C2) PM (e.g. 7,000)
  otherAllowance?: number; // Others / Other Allowance PM — part of Gross
  allowances?: number; // Optional allowances total
  grossSalary?: number; // Gross Salary (D) PM (e.g. 28,000)
  employeePf?: number; // Employee PF (E) PM (e.g. 1,800)
  employeeEsic?: number; // Employee ESIC (F) PM (e.g. 0)
  totalNetSalary?: number; // Total Net Salary (G) PM (e.g. 26,200)
  employerPf?: number; // Employer PF (H) PM (e.g. 1,800)
  employerEsic?: number; // Employer ESIC (I) PM (e.g. 0)
  professionalTax?: number; // PT (J) PM (e.g. 200)
  minimumBonus?: number; // Minimum Bonus (K) PM (e.g. 0)

  // Overtime (OT) Policy
  otEligible: boolean; // default true
  otRatePerHour?: number;
  
  // Bank & Statutory Details
  bankAccount?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  bankName?: string;
  panNumber?: string;
  aadhaarNumber?: string;
  uanNumber?: string;
  
  status: 'active' | 'inactive' | 'resigned';
  notes?: string;
  updatedAt?: string;
}

export interface EmployeeProfileUpdateInput {
  name?: string;
  email?: string;
  phone?: string;
  dob?: string;
  doj?: string;
  department?: string;
  designation?: string;
  location?: string;
  operationsCategory?: string;
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: string;
  emergencyContact?: string;
  
  monthlyCtc?: number;
  annualCtc?: number;
  basicSalary?: number;
  da?: number;
  fixedSalary?: number;
  hra?: number;
  specialAllowance?: number;
  otherAllowance?: number;
  grossSalary?: number;
  employeePf?: number;
  employeeEsic?: number;
  totalNetSalary?: number;
  employerPf?: number;
  employerEsic?: number;
  professionalTax?: number;
  minimumBonus?: number;

  otEligible?: boolean;
  otRatePerHour?: number;
  bankAccount?: string;
  ifscCode?: string;
  bankName?: string;
  panNumber?: string;
  aadhaarNumber?: string;
  status?: 'active' | 'inactive' | 'resigned';
  notes?: string;
}
