import { Request, Response } from 'express';
import { syncService } from './sync.service.js';
import { SyncLogModel } from './sync.model.js';
import { localStore } from '../../config/localStore.js';
import mongoose from 'mongoose';

export class SyncController {
  /**
   * POST /api/sync/:sourceId
   * Trigger manual sync for a specific source
   */
  public static async syncSingleSource(req: Request, res: Response): Promise<void> {
    try {
      const sourceIdParam = req.params.sourceId;
      const sourceId = Array.isArray(sourceIdParam) ? sourceIdParam[0] : String(sourceIdParam);
      const { fromDate, toDate, empCode } = req.body || {};

      if (!sourceId || sourceId === 'undefined') {
        res.status(400).json({ success: false, error: 'Source ID is required' });
        return;
      }

      const result = await syncService.syncSource(sourceId, {
        fromDate,
        toDate,
        empCode,
        triggeredBy: 'MANUAL',
      });

      if (!result.success) {
        res.status(400).json({
          success: false,
          source: result.source,
          error: result.error || 'Failed to sync with e-Timeoffice API',
          fetched: result.fetched,
          inserted: result.inserted,
          duplicates: result.duplicates,
        });
        return;
      }

      res.json({
        success: true,
        source: result.source,
        sourceId: result.sourceId,
        fetched: result.fetched,
        inserted: result.inserted,
        duplicates: result.duplicates,
        durationMs: result.durationMs,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Internal error during synchronization',
      });
    }
  }

  /**
   * POST /api/sync/all
   * Trigger sync for all 3 configured sources
   */
  public static async syncAllSources(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate, empCode } = req.body || {};

      const results = await syncService.syncAllSources({
        fromDate,
        toDate,
        empCode,
        triggeredBy: 'MANUAL',
      });

      const totalFetched = results.reduce((acc, r) => acc + r.fetched, 0);
      const totalInserted = results.reduce((acc, r) => acc + r.inserted, 0);
      const totalDuplicates = results.reduce((acc, r) => acc + r.duplicates, 0);
      const hasErrors = results.some((r) => !r.success);

      res.json({
        success: !hasErrors,
        results,
        totals: {
          fetched: totalFetched,
          inserted: totalInserted,
          duplicates: totalDuplicates,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Error triggering sync all',
      });
    }
  }

  /**
   * GET /api/sync/logs
   * Fetch historical sync logs
   */
  public static async getSyncLogs(req: Request, res: Response): Promise<void> {
    try {
      const { sourceId, status, page = 1, limit = 50 } = req.query;
      const isDbConnected = mongoose.connection.readyState === 1;

      if (!isDbConnected) {
        let allLogs = localStore.getSyncLogs();
        if (sourceId && sourceId !== 'all') {
          allLogs = allLogs.filter((l) => l.sourceId === String(sourceId).toLowerCase().trim());
        }
        if (status) {
          allLogs = allLogs.filter((l) => l.status === String(status).toUpperCase());
        }
        const total = allLogs.length;
        const currentPage = Math.max(1, Number(page));
        const pageSize = Math.max(1, Math.min(100, Number(limit)));
        const skip = (currentPage - 1) * pageSize;
        const paginated = allLogs.slice(skip, skip + pageSize);

        res.json({
          success: true,
          data: paginated,
          pagination: {
            page: currentPage,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize) || 1,
          },
        });
        return;
      }

      const query: any = {};

      if (sourceId && sourceId !== 'all') {
        query.sourceId = String(sourceId).toLowerCase().trim();
      }

      if (status) {
        query.status = String(status).toUpperCase();
      }

      const currentPage = Math.max(1, Number(page));
      const pageSize = Math.max(1, Math.min(100, Number(limit)));
      const skip = (currentPage - 1) * pageSize;

      const [total, logs] = await Promise.all([
        SyncLogModel.countDocuments(query),
        SyncLogModel.find(query)
          .sort({ startedAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .lean(),
      ]);

      res.json({
        success: true,
        data: logs,
        pagination: {
          page: currentPage,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize) || 1,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch sync logs',
      });
    }
  }

  /**
   * GET /api/sync/scheduler/status
   */
  public static async getSchedulerStatus(req: Request, res: Response): Promise<void> {
    try {
      const { syncScheduler } = await import('./syncScheduler.js');
      const status = syncScheduler.getStatus();
      res.json({ success: true, data: status });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to get scheduler status' });
    }
  }

  /**
   * POST /api/sync/scheduler/toggle
   */
  public static async toggleScheduler(req: Request, res: Response): Promise<void> {
    try {
      const { syncScheduler } = await import('./syncScheduler.js');
      const { policyService } = await import('../settings/policy.service.js');
      const { enabled, intervalMinutes } = req.body || {};

      const current = policyService.getSettings();
      const updatedEnabled = enabled !== undefined ? Boolean(enabled) : !current.scheduler.enabled;
      const updatedInterval = intervalMinutes ? Math.max(1, Number(intervalMinutes)) : current.scheduler.intervalMinutes;

      policyService.updateSettings({
        scheduler: {
          enabled: updatedEnabled,
          intervalMinutes: updatedInterval,
        },
      });

      if (updatedEnabled) {
        syncScheduler.start(updatedInterval);
      } else {
        syncScheduler.stop();
      }

      res.json({ success: true, data: syncScheduler.getStatus(), message: `Scheduler ${updatedEnabled ? 'started' : 'paused'}` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to toggle scheduler' });
    }
  }

  /**
   * POST /api/sync/scheduler/trigger-now
   */
  public static async triggerSchedulerNow(req: Request, res: Response): Promise<void> {
    try {
      const { syncScheduler } = await import('./syncScheduler.js');
      const result = await syncScheduler.triggerNow();
      res.json({ success: true, data: result, message: 'Immediate auto-sync cycle triggered' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Immediate sync cycle failed' });
    }
  }
}
