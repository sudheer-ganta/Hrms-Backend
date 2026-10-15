import { EmployeePayrollSummary } from './payroll.types.js';

export type PayrollRunStatus = 'CLOSED' | 'REOPENED';

export interface PayrollRunHistoryEntry {
  action: 'CLOSED' | 'REOPENED';
  byUser: string;
  at: Date;
  version?: number;
  reason?: string;
}

/** One immutable, versioned freeze of a month. Never edited after creation. */
export interface IPayrollSnapshot {
  month: string;
  version: number;
  snapshot: EmployeePayrollSummary[];
  employeeCount: number;
  totalNetPaid: number;
  closedAt: Date;
  closedBy: string;
  rulesVersion: string;
  policyVersion: number;
  policy: unknown;          // full policy used for the calculation
  calcMeta: { generatedAt: string; source: string; monthDays: number };
}

export interface IPayrollRun {
  month: string; // YYYY-MM
  status: PayrollRunStatus;
  currentVersion: number;
  employeeCount: number;
  totalNetPaid: number;
  closedAt: Date;
  closedBy: string;
  reopenedAt?: Date;
  reopenedBy?: string;
  reopenReason?: string;
  history: PayrollRunHistoryEntry[];
  /** LEGACY (pre-versioning) top-level snapshot; read-only. */
  snapshot?: EmployeePayrollSummary[];
  createdAt?: Date;
  updatedAt?: Date;
}
