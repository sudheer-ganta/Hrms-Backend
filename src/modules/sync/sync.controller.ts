import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { syncService } from './sync.service.js';
import { syncScheduler } from './syncScheduler.js';
import { SyncLogModel } from './sync.model.js';
import { policyService } from '../settings/policy.service.js';
import { handle, ApiError, errorBody } from '../../utils/apiError.js';
import { SyncSummaryResult, SyncType } from './sync.types.js';
import { optionalEnum, pagination, requireObject } from '../../utils/validate.js';
import { requireDb } from '../../config/db.js';

const optionsFrom = (body: any) => {
  const b = body && typeof body === 'object' ? body : {};
  return { fromDate: b.fromDate, toDate: b.toDate, empCode: b.empCode, triggeredBy: 'MANUAL' as const };
};

const failure = (results: SyncSummaryResult[]) => {
  const bad = results.filter((r) => !r.success);
  return errorBody(
    'UPSTREAM_FAILED',
    `${results.length - bad.length} of ${results.length} source(s) synced; ${bad.length} failed.`,
    bad.map((r) => ({ field: r.sourceId, issue: r.error || 'failed' }))
  );
};

export class SyncController {
  private one = (type: SyncType) =>
    handle(async (req: AuthRequest, res: Response) => {
      const sourceId = String(req.params.sourceId || '');
      const opts = optionsFrom(req.body);
      const r = type === 'RAW' ? await syncService.syncRaw(sourceId, opts) : await syncService.syncInOut(sourceId, opts);
      if (!r.success) throw ApiError.upstream(r.error || 'Sync failed');
      res.json({ success: true, data: r });
    });

  private all = (type: SyncType) =>
    handle(async (req: AuthRequest, res: Response) => {
      const results = await syncService.syncAll(type, optionsFrom(req.body));
      if (results.some((r) => !r.success)) return res.status(502).json(failure(results));
      res.json({
        success: true,
        data: {
          results,
          totals: {
            fetched: results.reduce((a, r) => a + r.fetched, 0),
            inserted: results.reduce((a, r) => a + r.inserted, 0),
            duplicates: results.reduce((a, r) => a + r.duplicates, 0),
          },
        },
      });
    });

  public syncRawOne = this.one('RAW');
  public syncRawAll = this.all('RAW');
  public syncInOutOne = this.one('INOUT');
  public syncInOutAll = this.all('INOUT');

  public getSyncLogs = handle(async (req: AuthRequest, res: Response) => {
    requireDb();
    const { page, limit } = pagination(req.query.page, req.query.limit, 100);
    const q: any = {};
    if (req.query.sourceId && req.query.sourceId !== 'all') q.sourceId = String(req.query.sourceId).toLowerCase().trim();
    const status = optionalEnum(req.query.status, ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'] as const, 'status');
    if (status) q.status = status;
    const type = optionalEnum(req.query.syncType, ['RAW', 'INOUT'] as const, 'syncType');
    if (type) q.syncType = type;
    const [total, logs] = await Promise.all([
      SyncLogModel.countDocuments(q),
      SyncLogModel.find(q).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ success: true, data: logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
  });

  public getSchedulerStatus = handle(async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: syncScheduler.getStatus() });
  });

  public toggleScheduler = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body ?? {});
    const current = policyService.getSettings().scheduler;
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : !current.enabled;
    const intervalMinutes = body.intervalMinutes !== undefined ? Number(body.intervalMinutes) : current.intervalMinutes;
    await policyService.updateSettings({ scheduler: { enabled, intervalMinutes } });
    if (enabled) syncScheduler.start(policyService.getSettings().scheduler.intervalMinutes);
    else syncScheduler.stop();
    res.json({ success: true, data: syncScheduler.getStatus() });
  });

  public triggerSchedulerNow = handle(async (_req: AuthRequest, res: Response) => {
    const result = await syncScheduler.triggerNow();
    res.json({ success: true, data: result });
  });
}

export const syncController = new SyncController();
