import { getSourceById, getAllSources, ENV } from '../../config/env.js';
import { etimeofficeClient } from '../etimeoffice/etimeoffice.client.js';
import { parseVendorPunchDate } from '../../utils/dateUtils.js';
import { createVendorRecordHash } from '../../utils/hashUtils.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { SyncLogModel } from './sync.model.js';
import { SyncSummaryResult } from './sync.types.js';
import { localStore } from '../../config/localStore.js';
import { IAttendanceRecord } from '../attendance/attendance.types.js';
import mongoose from 'mongoose';

export interface SyncOptions {
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  empCode?: string;
  triggeredBy?: 'MANUAL' | 'SCHEDULED';
}

export class SyncService {
  /**
   * Syncs attendance records for a specific source location from e-Timeoffice
   */
  public async syncSource(sourceId: string, options: SyncOptions = {}): Promise<SyncSummaryResult> {
    const startTime = Date.now();
    const source = getSourceById(sourceId);

    if (!source) {
      throw new Error(`Invalid source location: "${sourceId}".`);
    }

    const { fromDate, toDate, empCode = 'ALL', triggeredBy = 'MANUAL' } = options;

    let syncLogDoc: any = null;
    let localLogId: string | null = null;
    const isDbConnected = mongoose.connection.readyState === 1;

    // 1. Create a RUNNING sync log
    if (isDbConnected) {
      try {
        syncLogDoc = await SyncLogModel.create({
          sourceId: source.id,
          sourceName: source.displayName,
          startedAt: new Date(),
          status: 'RUNNING',
          recordsFetched: 0,
          recordsInserted: 0,
          recordsSkipped: 0,
          requestFromDate: fromDate,
          requestToDate: toDate,
          triggeredBy,
          syncType: 'RAW',
        });
      } catch (err) {
        console.warn('Could not write initial sync log to MongoDB:', err);
      }
    } else {
      const localLog = localStore.addSyncLog({
        sourceId: source.id,
        sourceName: source.displayName,
        startedAt: new Date(),
        status: 'RUNNING',
        recordsFetched: 0,
        recordsInserted: 0,
        recordsSkipped: 0,
        requestFromDate: fromDate,
        requestToDate: toDate,
        triggeredBy,
        syncType: 'RAW',
      });
      localLogId = localLog._id;
    }

    try {
      // 2. Fetch raw punch data from e-Timeoffice API
      const clientResult = await etimeofficeClient.fetchPunchDataMCID({
        sourceId: source.id,
        fromDate,
        toDate,
        empCode,
      });

      const rawRecords = clientResult.records || [];
      const fetchedCount = rawRecords.length;

      let insertedCount = 0;
      let skippedCount = 0;

      // 3. Normalize records
      const normalizedDocs: IAttendanceRecord[] = [];
      for (const record of rawRecords) {
        try {
          if (!record.PunchDate) continue;

          const parsed = parseVendorPunchDate(record.PunchDate);
          const empCode = (record.Empcode || 'UNKNOWN').toString().trim().toUpperCase();
          const empName = (record.Name || 'Unknown Employee').toString().trim();
          const machineId = (record.mcid !== undefined && record.mcid !== null) ? String(record.mcid).trim() : '0';
          const machineFlag = record.M_Flag ? String(record.M_Flag).trim() : null;

          const hash = createVendorRecordHash(
            source.id,
            empCode,
            parsed.punchDateTime,
            machineId
          );

          normalizedDocs.push({
            sourceId: source.id,
            sourceName: source.displayName,
            employeeCode: empCode,
            employeeName: empName,
            punchDateTime: parsed.punchDateTime,
            entryDate: parsed.entryDate,
            entryTime: parsed.entryTime,
            machineId,
            machineFlag,
            syncedAt: new Date(),
            vendorRecordHash: hash,
          });
        } catch (parseErr: any) {
          console.warn(`Error parsing vendor record for ${source.displayName}:`, parseErr.message, record);
          skippedCount++;
        }
      }

      // 4. Save to database or fallback store with deduplication
      if (isDbConnected && normalizedDocs.length > 0) {
        const bulkOps = normalizedDocs.map((doc) => ({
          updateOne: {
            filter: { vendorRecordHash: doc.vendorRecordHash },
            update: { $setOnInsert: doc },
            upsert: true,
          },
        }));

        const bulkResult = await AttendanceModel.bulkWrite(bulkOps, { ordered: false });
        insertedCount = bulkResult.upsertedCount || 0;
        skippedCount += (bulkResult.matchedCount || 0);
      } else {
        const storeResult = localStore.upsertRecords(normalizedDocs);
        insertedCount = storeResult.inserted;
        skippedCount += storeResult.duplicates;
      }

      const durationMs = Date.now() - startTime;
      const status = 'SUCCESS';

      // 5. Update Sync Log
      if (syncLogDoc) {
        syncLogDoc.completedAt = new Date();
        syncLogDoc.status = status;
        syncLogDoc.recordsFetched = fetchedCount;
        syncLogDoc.recordsInserted = insertedCount;
        syncLogDoc.recordsSkipped = skippedCount;
        await syncLogDoc.save();
      } else if (localLogId) {
        localStore.updateSyncLog(localLogId, {
          completedAt: new Date(),
          status,
          recordsFetched: fetchedCount,
          recordsInserted: insertedCount,
          recordsSkipped: skippedCount,
        });
      }

      return {
        success: true,
        sourceId: source.id,
        source: source.displayName,
        fetched: fetchedCount,
        inserted: insertedCount,
        duplicates: skippedCount,
        status,
        logId: syncLogDoc?._id?.toString() || localLogId || undefined,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err?.message || 'Sync failed due to an unexpected error';

      if (syncLogDoc) {
        syncLogDoc.completedAt = new Date();
        syncLogDoc.status = 'FAILED';
        syncLogDoc.errorMessage = errorMessage;
        await syncLogDoc.save();
      } else if (localLogId) {
        localStore.updateSyncLog(localLogId, {
          completedAt: new Date(),
          status: 'FAILED',
          errorMessage,
        });
      }

      return {
        success: false,
        sourceId: source.id,
        source: source.displayName,
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        status: 'FAILED',
        logId: syncLogDoc?._id?.toString() || localLogId || undefined,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Syncs all 3 configured sources (Office, Budigere, Bidarahalli)
   */
  public async syncAllSources(options: SyncOptions = {}): Promise<SyncSummaryResult[]> {
    const sources = getAllSources().filter(s => s.enabled);
    const results: SyncSummaryResult[] = [];

    for (const source of sources) {
      const result = await this.syncSource(source.id, options);
      results.push(result);
    }

    return results;
  }
}

export const syncService = new SyncService();
