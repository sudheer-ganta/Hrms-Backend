import { EmployeeModel } from './employeeMaster.model.js';
import {
  EmployeeProfile, EMPLOYEE_STATUSES, PERSONAL_FIELDS, EMPLOYMENT_FIELDS, SALARY_FIELDS, BANK_FIELDS,
} from './employeeMaster.types.js';
import { computeSalaryBreakdown, SalaryBreakdown } from './salary.js';
import { siteService } from '../sites/site.service.js';
import { ApiError } from '../../utils/apiError.js';
import { normalizeEmpCode, isValidEmpCode } from '../../utils/empCode.js';
import { isValidBusinessDate, isValidBusinessMonth } from '../../utils/istTime.js';
import { requireDb } from '../../config/db.js';
import { requireObject, optionalNumber } from '../../utils/validate.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_MAX: Record<string, number> = {
  name: 120, email: 254, phone: 20, bloodGroup: 5, emergencyContact: 40, department: 80, designation: 80,
  operationsCategory: 80, managerName: 120, shiftName: 80, notes: 1000, bankName: 80, bankAccount: 34,
  ifscCode: 11, panNumber: 10, aadhaarNumber: 12, uanNumber: 12, esiNumber: 20,
};

const ALLOWED = new Set<string>([...PERSONAL_FIELDS, ...EMPLOYMENT_FIELDS, ...SALARY_FIELDS, ...BANK_FIELDS]);

export const maskTail = (v?: string, keep = 4): string | undefined => {
  if (!v) return v;
  return v.length <= keep ? '*'.repeat(v.length) : `${'*'.repeat(v.length - keep)}${v.slice(-keep)}`;
};

/** Canonical DTO: strips internals, merges legacy duplicate fields. */
export function toProfile(doc: any): EmployeeProfile {
  const { _id, __v, createdAt, joiningDate, bankAccountNumber, allowances, ...rest } = doc;
  return {
    ...rest,
    employeeId: String(_id),
    doj: rest.doj || joiningDate || undefined,
    bankAccount: rest.bankAccount || bankAccountNumber || undefined,
    otEligible: rest.otEligible !== false,
    status: rest.status || 'active',
    updatedAt: rest.updatedAt ? (typeof rest.updatedAt === 'string' ? rest.updatedAt : new Date(rest.updatedAt).toISOString()) : undefined,
  } as EmployeeProfile;
}

/** Roster views never need full identity numbers. */
export const maskProfile = (p: EmployeeProfile): EmployeeProfile => ({
  ...p,
  aadhaarNumber: maskTail(p.aadhaarNumber),
  bankAccount: maskTail(p.bankAccount),
});

/** Validates and normalizes a client profile payload against the explicit whitelist. */
export async function validateProfileInput(input: unknown): Promise<Record<string, unknown>> {
  const body = requireObject(input);
  const unknown = Object.keys(body).filter((k) => !ALLOWED.has(k));
  // System / derived fields sent by older clients are ignored silently; truly unknown keys are rejected.
  const derived = new Set(['empCode', 'employeeId', 'annualCtc', 'fixedSalary', 'grossSalary', 'totalNetSalary', 'updatedAt', 'createdAt', '_id']);
  const rejected = unknown.filter((k) => !derived.has(k));
  if (rejected.length) {
    throw ApiError.validation('Unknown or non-editable fields.', rejected.map((f) => ({ field: f, issue: 'Not editable' })));
  }

  const out: Record<string, unknown> = {};
  const details: { field: string; issue: string }[] = [];
  const fail = (field: string, issue: string) => details.push({ field, issue });

  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED.has(k) || v === undefined) continue;
    if ((SALARY_FIELDS as readonly string[]).includes(k) || k === 'otMultiplier' || k === 'otRatePerHour') {
      if (v === null || v === '') { out[k] = null; continue; }
      const num = optionalNumber(v, k, { min: 0, max: 100_000_000 });
      out[k] = num;
      continue;
    }
    if (k === 'otEligible') { out[k] = Boolean(v); continue; }
    if (k === 'status') {
      if (!(EMPLOYEE_STATUSES as readonly string[]).includes(String(v))) fail('status', 'Invalid status');
      else out[k] = v;
      continue;
    }
    if (k === 'gender') {
      if (v !== '' && !['Male', 'Female', 'Other'].includes(String(v))) fail('gender', 'Invalid gender');
      else out[k] = v === '' ? undefined : v;
      continue;
    }
    if (k === 'dob' || k === 'doj') {
      if (v === '' || v === null) out[k] = undefined;
      else if (!isValidBusinessDate(v)) fail(k, 'Must be YYYY-MM-DD');
      else out[k] = v;
      continue;
    }
    if (k === 'email') {
      if (v === '' || v === null) out[k] = undefined;
      else if (typeof v !== 'string' || !EMAIL_RE.test(v)) fail('email', 'Invalid email');
      else out[k] = v.trim().toLowerCase();
      continue;
    }
    if (k === 'managerEmpCode') {
      if (v === '' || v === null) out[k] = undefined;
      else if (!isValidEmpCode(v)) fail(k, 'Invalid employee code');
      else out[k] = normalizeEmpCode(v);
      continue;
    }
    if (k === 'location') {
      if (v === '' || v === null) { out[k] = undefined; continue; }
      const wanted = String(v).trim().toLowerCase();
      const sites = await siteService.getSites();
      const match = sites.find((s) => [s.siteId, s.name, s.displayName].some((x) => x.toLowerCase() === wanted));
      if (!match) fail('location', `Unknown site. Use one of: ${sites.map((s) => s.siteId).join(', ')}`);
      else out[k] = match.siteId;
      continue;
    }
    if (typeof v !== 'string') { fail(k, 'Must be text'); continue; }
    const trimmed = v.trim();
    if (!trimmed) { out[k] = undefined; continue; }
    if (trimmed.length > (TEXT_MAX[k] ?? 200)) { fail(k, `Max ${TEXT_MAX[k] ?? 200} characters`); continue; }
    if (k === 'panNumber' || k === 'ifscCode') {
      out[k] = trimmed.toUpperCase();
      continue;
    }
    out[k] = trimmed;
  }
  if (details.length) throw ApiError.validation('Profile validation failed.', details);
  return out;
}

class EmployeeMasterService {
  private inactiveCache: { codes: Set<string>; expiresAt: number } | null = null;

  /** Profile or null. Read-only: NEVER creates anything. */
  public async findProfile(empCode: string): Promise<EmployeeProfile | null> {
    requireDb();
    const doc = await EmployeeModel.findOne({ empCode: normalizeEmpCode(empCode) }).lean();
    return doc ? toProfile(doc) : null;
  }

  public async requireProfile(empCode: string): Promise<EmployeeProfile> {
    const p = await this.findProfile(empCode);
    if (!p) throw ApiError.notFound(`Employee ${normalizeEmpCode(empCode)} not found.`);
    return p;
  }

  public async getAllProfiles(): Promise<EmployeeProfile[]> {
    requireDb();
    const docs = await EmployeeModel.find({}).sort({ empCode: 1 }).lean();
    return docs.map(toProfile);
  }

  /** Codes of employees no longer active (excluded from rosters/dashboards). */
  public async getInactiveCodes(): Promise<Set<string>> {
    if (this.inactiveCache && this.inactiveCache.expiresAt > Date.now()) return this.inactiveCache.codes;
    requireDb();
    const docs = await EmployeeModel.find({ status: { $in: ['inactive', 'resigned'] } }).select('empCode').lean();
    const codes = new Set(docs.map((d: any) => normalizeEmpCode(d.empCode)));
    this.inactiveCache = { codes, expiresAt: Date.now() + 30_000 };
    return codes;
  }

  public invalidateCaches(): void {
    this.inactiveCache = null;
  }

  /** Pure salary preview for the edit form: same formula as save, nothing persisted. */
  public async previewSalary(input: unknown): Promise<SalaryBreakdown> {
    const body = requireObject(input);
    const parsed = await validateProfileInput(
      Object.fromEntries(Object.entries(body).filter(([k]) => (SALARY_FIELDS as readonly string[]).includes(k)))
    );
    const breakdown = computeSalaryBreakdown(parsed as any);
    if (!breakdown) throw ApiError.rule('Monthly CTC must be greater than zero to compute a salary breakdown.');
    return breakdown;
  }

  public async createProfile(input: unknown): Promise<EmployeeProfile> {
    requireDb();
    const body = requireObject(input);
    const empCode = normalizeEmpCode(body.empCode);
    if (!isValidEmpCode(empCode)) throw ApiError.validation('A valid employee code is required.', [{ field: 'empCode', issue: 'Invalid' }]);
    if (await EmployeeModel.exists({ empCode })) throw ApiError.conflict(`Employee ${empCode} already exists.`);
    const { empCode: _ignored, ...rest } = body;
    const fields = await validateProfileInput(rest);
    if (!fields.name) throw ApiError.validation('Employee name is required.', [{ field: 'name', issue: 'Required' }]);
    const salary = computeSalaryBreakdown(fields as any);
    const doc = await EmployeeModel.create({
      ...fields,
      ...(salary ? salary : {}),
      empCode,
      otEligible: fields.otEligible ?? true,
      status: fields.status ?? 'active',
      updatedAt: new Date().toISOString(),
    });
    this.invalidateCaches();
    return toProfile(doc.toObject());
  }

  /** Whitelisted update. Salary fields recompute through the single formula. */
  public async updateProfile(empCode: string, input: unknown): Promise<EmployeeProfile> {
    requireDb();
    const code = normalizeEmpCode(empCode);
    const existing = await EmployeeModel.findOne({ empCode: code }).lean();
    if (!existing) throw ApiError.notFound(`Employee ${code} not found.`);
    const fields = await validateProfileInput(input);

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(fields)) {
      if ((SALARY_FIELDS as readonly string[]).includes(k)) continue;
      if (v === undefined || v === null) $unset[k] = '';
      else $set[k] = v;
    }

    const touchesSalary = Object.keys(fields).some((k) => (SALARY_FIELDS as readonly string[]).includes(k));
    if (touchesSalary) {
      // Merge stored salary inputs with the new ones; derived values are recomputed, not trusted.
      const merged: Record<string, unknown> = {};
      for (const k of SALARY_FIELDS) merged[k] = (existing as any)[k];
      for (const k of SALARY_FIELDS) if (k in fields) merged[k] = (fields as any)[k];
      // A changed CTC invalidates previously derived components that were not explicitly re-sent.
      if ('monthlyCtc' in fields) {
        for (const k of SALARY_FIELDS) if (k !== 'monthlyCtc' && !(k in fields)) merged[k] = undefined;
      }
      const breakdown = computeSalaryBreakdown(merged as any);
      if (!breakdown) {
        for (const k of [...SALARY_FIELDS, 'annualCtc', 'fixedSalary', 'grossSalary', 'totalNetSalary']) $unset[k] = '';
      } else {
        const { rulesVersion: _v, ...vals } = breakdown;
        Object.assign($set, vals);
      }
    }
    $set.updatedAt = new Date().toISOString();

    const update: Record<string, unknown> = { $set };
    if (Object.keys($unset).length) update.$unset = $unset;
    const updated = await EmployeeModel.findOneAndUpdate({ empCode: code }, update, { new: true }).lean();
    this.invalidateCaches();
    return toProfile(updated);
  }

  /**
   * Creates baseline profiles for vendor employees seen during SYNC (never from a GET).
   * Existing profiles are untouched.
   */
  public async ensureProfiles(entries: Array<{ empCode: string; name: string; siteId?: string }>): Promise<number> {
    requireDb();
    const unique = new Map<string, { empCode: string; name: string; siteId?: string }>();
    for (const e of entries) if (e.empCode && isValidEmpCode(e.empCode) && !unique.has(e.empCode)) unique.set(e.empCode, e);
    if (unique.size === 0) return 0;
    const res = await EmployeeModel.bulkWrite(
      Array.from(unique.values()).map((e) => ({
        updateOne: {
          filter: { empCode: e.empCode },
          update: {
            $setOnInsert: {
              empCode: e.empCode,
              name: e.name || `Employee ${e.empCode}`,
              location: e.siteId?.toLowerCase(),
              otEligible: true,
              status: 'active',
              updatedAt: new Date().toISOString(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    if (res.upsertedCount) this.invalidateCaches();
    return res.upsertedCount || 0;
  }

  public isValidMonth = isValidBusinessMonth;
}

export const employeeMasterService = new EmployeeMasterService();
