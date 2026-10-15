import { EmployeeSourceMappingModel } from './employeeSourceMapping.model.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { isDbConnected } from '../../config/db.js';

const TTL_MS = 60_000;

/**
 * Resolves a vendor employee code at a source to the canonical employee code.
 * With no explicit mapping the normalized vendor code IS the canonical code
 * (identity mapping), so existing data keeps working. Explicit mappings let
 * "00132" at one site and "A132" at another be the same person.
 */
class IdentityService {
  private cache = new Map<string, string>();
  private loadedAt = 0;

  private async load(): Promise<void> {
    if (Date.now() - this.loadedAt < TTL_MS || !isDbConnected()) return;
    const rows = await EmployeeSourceMappingModel.find({}).lean();
    this.cache = new Map(rows.map((r: any) => [`${r.sourceId}|${r.vendorEmployeeCode}`, r.employeeCode]));
    this.loadedAt = Date.now();
  }

  public async canonicalCode(sourceId: string, vendorCode: unknown): Promise<string> {
    await this.load();
    const vendor = normalizeEmpCode(vendorCode);
    return this.cache.get(`${String(sourceId).toLowerCase()}|${vendor}`) || vendor;
  }

  /** Records that this vendor code belongs to this employee (idempotent, never reassigns). */
  public async ensureMapping(sourceId: string, vendorCode: unknown, employeeCode: string): Promise<void> {
    const vendor = normalizeEmpCode(vendorCode);
    const src = String(sourceId).toLowerCase();
    await EmployeeSourceMappingModel.updateOne(
      { sourceId: src, vendorEmployeeCode: vendor },
      { $setOnInsert: { sourceId: src, vendorEmployeeCode: vendor, employeeCode: normalizeEmpCode(employeeCode) } },
      { upsert: true }
    );
    this.cache.set(`${src}|${vendor}`, normalizeEmpCode(employeeCode));
  }

  public async setMapping(sourceId: string, vendorCode: unknown, employeeCode: string): Promise<void> {
    const vendor = normalizeEmpCode(vendorCode);
    const src = String(sourceId).toLowerCase();
    await EmployeeSourceMappingModel.updateOne(
      { sourceId: src, vendorEmployeeCode: vendor },
      { $set: { employeeCode: normalizeEmpCode(employeeCode) }, $setOnInsert: { sourceId: src, vendorEmployeeCode: vendor } },
      { upsert: true }
    );
    this.loadedAt = 0;
  }

  public async listMappings(employeeCode?: string) {
    const q = employeeCode ? { employeeCode: normalizeEmpCode(employeeCode) } : {};
    return EmployeeSourceMappingModel.find(q).sort({ employeeCode: 1, sourceId: 1 }).lean();
  }
}

export const identityService = new IdentityService();
