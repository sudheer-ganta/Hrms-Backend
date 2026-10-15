import { Request, Response } from 'express';
import { getAllSources } from '../../config/env.js';
import { SyncLogModel } from '../sync/sync.model.js';
import { siteService } from '../sites/site.service.js';
import { handle } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { requireObject } from '../../utils/validate.js';

export type SourceHealth = 'connected' | 'degraded' | 'failed' | 'running' | 'never_synced' | 'credentials_missing' | 'disabled';

const worst = (a: SourceHealth, b: SourceHealth): SourceHealth => {
  const order: SourceHealth[] = ['failed', 'degraded', 'running', 'never_synced', 'connected'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
};

const healthOf = (log?: { status?: string } | null): SourceHealth =>
  !log ? 'never_synced' : log.status === 'SUCCESS' ? 'connected' : log.status === 'PARTIAL' ? 'degraded' : log.status === 'RUNNING' ? 'running' : 'failed';

export class SourcesController {
  /**
   * Source (vendor account) health. Each sync TYPE is judged by its own latest run, so a good
   * IN/OUT sync can no longer hide a failing raw sync (or the other way round).
   */
  public static getSources = handle(async (_req: Request, res: Response) => {
    requireDb();
    const sites = new Map((await siteService.getSites()).map((s) => [s.siteId, s]));
    const data = await Promise.all(
      getAllSources().map(async (src) => {
        const site = sites.get(src.siteId);
        const base = { id: src.id, siteId: src.siteId, name: site?.displayName || src.displayName, internalName: src.name, geoConfigured: !!site?.geo };
        if (!src.enabled) return { ...base, status: 'disabled' as SourceHealth, lastSync: null, lastRawSync: null, lastInOutSync: null };
        if (!src.corporateId || !src.username || !src.password) return { ...base, status: 'credentials_missing' as SourceHealth, lastSync: null, lastRawSync: null, lastInOutSync: null };
        const [raw, inout] = await Promise.all([
          SyncLogModel.findOne({ sourceId: src.id, syncType: 'RAW' }).sort({ startedAt: -1 }).lean(),
          SyncLogModel.findOne({ sourceId: src.id, syncType: 'INOUT' }).sort({ startedAt: -1 }).lean(),
        ]);
        const status = worst(healthOf(raw), healthOf(inout));
        const at = (l: any) => (l ? l.completedAt || l.startedAt : null);
        const latest = [at(raw), at(inout)].filter(Boolean).sort().pop() ?? null;
        return {
          ...base, status, lastSync: latest,
          lastRawSync: raw ? { status: raw.status, at: at(raw), error: raw.errorMessage || null } : null,
          lastInOutSync: inout ? { status: inout.status, at: at(inout), error: inout.errorMessage || null } : null,
        };
      })
    );
    res.json({ success: true, data });
  });

  public static getSites = handle(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await siteService.getSites() });
  });

  public static updateSite = handle(async (req: Request, res: Response) => {
    requireObject(req.body);
    res.json({ success: true, data: await siteService.updateSite(String(req.params.siteId), req.body) });
  });
}
