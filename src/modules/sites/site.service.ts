import { SiteModel, ISite } from './site.model.js';
import { getAllSources, getSourceById } from '../../config/env.js';
import { requireDb } from '../../config/db.js';
import { ApiError } from '../../utils/apiError.js';
import { requireObject, optionalNumber } from '../../utils/validate.js';

export interface Distance {
  site: ISite;
  distanceM: number;
}

export const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLam = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Pure: which configured site (if any) contains the coordinate. */
export const matchSiteByGeo = (sites: ISite[], lat: number, lng: number): Distance | null => {
  let best: Distance | null = null;
  for (const s of sites) {
    if (!s.active || !s.geo || s.geo.lat === undefined || s.geo.lng === undefined || !s.geo.radiusM) continue;
    const d = haversineMeters(lat, lng, s.geo.lat, s.geo.lng);
    if (d <= s.geo.radiusM && (!best || d < best.distanceM)) best = { site: s, distanceM: d };
  }
  return best;
};

class SiteService {
  /** Creates missing sites from configured vendor accounts. Never overwrites admin edits. */
  public async ensureSites(): Promise<void> {
    requireDb();
    for (const src of getAllSources()) {
      await SiteModel.updateOne(
        { siteId: src.siteId },
        { $setOnInsert: { siteId: src.siteId, name: src.name, displayName: src.displayName, active: true } },
        { upsert: true }
      );
    }
  }

  public async getSites(): Promise<ISite[]> {
    requireDb();
    const docs = await SiteModel.find({}).sort({ siteId: 1 }).lean();
    return docs.map((d: any) => ({ siteId: d.siteId, name: d.name, displayName: d.displayName, active: d.active, geo: d.geo?.lat !== undefined ? d.geo : undefined }));
  }

  public async getSite(siteId: string): Promise<ISite | null> {
    const sites = await this.getSites();
    return sites.find((s) => s.siteId === String(siteId).toLowerCase()) || null;
  }

  /** The site a vendor account belongs to (accounts map 1:1 to a site today). */
  public siteIdForSource(sourceId: string): string {
    return getSourceById(sourceId)?.siteId || String(sourceId).toLowerCase();
  }

  public async updateSite(siteId: string, input: unknown): Promise<ISite> {
    requireDb();
    const b = requireObject(input);
    const $set: Record<string, unknown> = {};
    if (b.displayName !== undefined) {
      const dn = String(b.displayName).trim();
      if (!dn || dn.length > 80) throw ApiError.validation('displayName is invalid.', [{ field: 'displayName', issue: 'Invalid' }]);
      $set.displayName = dn;
    }
    if (b.active !== undefined) $set.active = Boolean(b.active);
    if (b.geo !== undefined) {
      if (b.geo === null) {
        $set.geo = undefined;
      } else {
        const g = requireObject(b.geo, 'geo');
        const lat = optionalNumber(g.lat, 'geo.lat', { min: -90, max: 90 });
        const lng = optionalNumber(g.lng, 'geo.lng', { min: -180, max: 180 });
        const radiusM = optionalNumber(g.radiusM, 'geo.radiusM', { min: 10, max: 50000 });
        if (lat === undefined || lng === undefined || radiusM === undefined) {
          throw ApiError.validation('geo requires lat, lng and radiusM.', [{ field: 'geo', issue: 'Incomplete' }]);
        }
        $set.geo = { lat, lng, radiusM };
      }
    }
    const res = await SiteModel.findOneAndUpdate({ siteId: siteId.toLowerCase() }, { $set }, { new: true }).lean();
    if (!res) throw ApiError.notFound('Site not found.');
    return this.getSite(siteId) as Promise<ISite>;
  }
}

export const siteService = new SiteService();
