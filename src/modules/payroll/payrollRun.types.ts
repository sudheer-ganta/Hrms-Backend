import { EmployeePayrollSummary } from './payroll.types.js';

export type PayrollRunStatus = 'CLOSED' | 'REOPENED';

export interface PayrollRunHistoryEntry {
  action: 'CLOSED' | 'REOPENED';
  byUser: string;
  at: Date;
}

export interface IPayrollRun {
  month: string; // YYYY-MM
  status: PayrollRunStatus;
  snapshot: EmployeePayrollSummary[];
  employeeCount: number;
  totalNetPaid: number;
  closedAt: Date;
  closedBy: string;
  reopenedAt?: Date;
  reopenedBy?: string;
  history: PayrollRunHistoryEntry[];
  createdAt?: Date;
  updatedAt?: Date;
}
