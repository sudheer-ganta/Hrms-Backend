export type EmployeeStatus = 'active' | 'inactive' | 'resigned';
export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ['active', 'inactive', 'resigned'];

/**
 * A salary change that takes effect from a month. `values` are the stored salary fields (inputs + derived).
 * The revision in force for a month is the one with the latest `effectiveFrom` <= that month.
 */
export interface SalaryRevision {
  effectiveFrom: string; // YYYY-MM, or '0000-00' = applies to every month
  values: Partial<Record<string, number>>;
  changedBy?: string;
  changedAt: string; // ISO instant
}

/** Canonical employee DTO (backend response and frontend type are identical). */
export interface EmployeeProfile {
  employeeId?: string; // immutable document id
  empCode: string;     // canonical business key (normalized, immutable)
  name: string;
  email?: string;
  phone?: string;
  dob?: string;
  doj?: string; // Date of joining, YYYY-MM-DD
  department?: string;
  designation?: string;
  location?: string; // canonical siteId
  operationsCategory?: string;
  gender?: 'Male' | 'Female' | 'Other';
  bloodGroup?: string;
  emergencyContact?: string;
  managerEmpCode?: string;
  managerName?: string;
  shiftName?: string;

  // Annexure K, all derived by the backend from monthlyCtc unless explicitly overridden
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
  /** Month-by-month salary history; the fields above mirror the latest revision. Absent = never revised. */
  salaryRevisions?: SalaryRevision[];

  // Overtime
  otEligible: boolean;
  otMultiplier?: number;  // e.g. 1.5 / 2 (multiplier of the hourly wage)
  otRatePerHour?: number; // absolute rupee rate per hour; wins over the multiplier when > 0

  // Bank & statutory
  bankName?: string;
  bankAccount?: string;
  ifscCode?: string;
  panNumber?: string;
  aadhaarNumber?: string;
  uanNumber?: string;
  esiNumber?: string; // ESI insurance (IP) number

  status: EmployeeStatus;
  notes?: string;
  updatedAt?: string;
}

/** Fields a client may send. Anything else is rejected, never written. */
export const PERSONAL_FIELDS = ['name', 'email', 'phone', 'dob', 'gender', 'bloodGroup', 'emergencyContact'] as const;
export const EMPLOYMENT_FIELDS = [
  'doj', 'department', 'designation', 'location', 'operationsCategory', 'managerEmpCode', 'managerName',
  'shiftName', 'status', 'otEligible', 'otMultiplier', 'otRatePerHour', 'notes',
] as const;
export const SALARY_FIELDS = [
  'monthlyCtc', 'basicSalary', 'da', 'hra', 'specialAllowance', 'otherAllowance',
  'employeePf', 'employerPf', 'employeeEsic', 'employerEsic', 'professionalTax', 'minimumBonus',
] as const;
/** Not a profile field: the month a salary change takes effect from (sent with salary edits). */
export const SALARY_EFFECTIVE_FIELD = 'salaryEffectiveFrom';
export const BANK_FIELDS = ['bankName', 'bankAccount', 'ifscCode', 'panNumber', 'aadhaarNumber', 'uanNumber', 'esiNumber'] as const;
