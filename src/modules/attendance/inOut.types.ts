import { Document } from 'mongoose';

/**
 * Vendor daily summary (e-TimeOffice API 3). This is STAGING input only: the vendor's own
 * view of one employee-day at one source. It is never shown or paid directly: the attendance
 * day service merges it with raw punches and adjustments, and resolveDay() produces the verdict.
 */
export interface IInOutRecord {
  sourceId: string;
  sourceName: string;
  employeeCode: string;        // canonical code
  vendorEmployeeCode?: string;
  employeeName: string;
  date: string;                // YYYY-MM-DD IST
  inTime: string;              // "08:56" or "--:--"
  outTime: string;
  workTime: string;
  workMinutes: number;
  overTime: string;
  breakTime: string;
  lateIn: string;
  earlyOut: string;
  status: string;              // raw vendor status (P, P/2, A, W, H, ...)
  remark: string;
  syncedAt: Date;
  recordKey: string;           // sourceId_employeeCode_date
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InOutRecordDocument extends IInOutRecord, Document {}
