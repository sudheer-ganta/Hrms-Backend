import { Document } from 'mongoose';

export type SyncStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';

export type SyncType = 'RAW' | 'INOUT';

export interface ISyncLog {
  sourceId: string;
  sourceName: string;
  startedAt: Date;
  completedAt?: Date;
  status: SyncStatus;
  recordsFetched: number;
  recordsInserted: number;
  recordsSkipped: number;
  errorMessage?: string;
  requestFromDate?: string;
  requestToDate?: string;
  triggeredBy: 'MANUAL' | 'SCHEDULED';
  syncType: SyncType;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SyncLogDocument extends ISyncLog, Document {}

export interface SyncSummaryResult {
  success: boolean;
  sourceId: string;
  source: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  status: SyncStatus;
  logId?: string;
  durationMs: number;
  error?: string;
}
