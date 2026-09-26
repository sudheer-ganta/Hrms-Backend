import { Request, Response } from 'express';
import { getAllSources } from '../../config/env.js';
import { SyncLogModel } from '../sync/sync.model.js';
import { localStore } from '../../config/localStore.js';
import mongoose from 'mongoose';

export class SourcesController {
  public static async getSources(req: Request, res: Response): Promise<void> {
    try {
      const sources = getAllSources();
      const isDbConnected = mongoose.connection.readyState === 1;

      const results = await Promise.all(
        sources.map(async (src) => {
          let status = 'configured';
          let lastSync = null;

          if (!src.corporateId || !src.username || !src.password) {
            status = 'credentials_missing';
          } else if (isDbConnected) {
            const lastLog = await SyncLogModel.findOne({ sourceId: src.id })
              .sort({ startedAt: -1 })
              .lean();
            if (lastLog) {
              lastSync = lastLog.completedAt || lastLog.startedAt;
              status = lastLog.status === 'SUCCESS' ? 'connected' : lastLog.status.toLowerCase();
            } else {
              status = 'connected';
            }
          } else {
            const allLogs = localStore.getSyncLogs();
            const lastLog = allLogs.find((l) => l.sourceId === src.id);
            if (lastLog) {
              lastSync = lastLog.completedAt || lastLog.startedAt;
              status = lastLog.status === 'SUCCESS' ? 'connected' : lastLog.status.toLowerCase();
            } else {
              status = 'connected';
            }
          }

          return {
            id: src.id,
            name: src.displayName,
            internalName: src.name,
            status,
            lastSync,
          };
        })
      );

      res.json({
        success: true,
        data: results,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch sources',
      });
    }
  }
}
