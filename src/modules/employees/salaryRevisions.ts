import { EmployeeProfile, SALARY_FIELDS, SalaryRevision } from './employeeMaster.types.js';

/**
 * Month-correct salary. A salary change is a REVISION that takes effect from a month; every month of payroll
 * reads the revision in force for THAT month, so a raise in October never rewrites September.
 *
 * Profiles that were never revised have no revisions and behave exactly as before (their stored salary applies
 * to every month). The profile's top-level salary fields always mirror the latest revision, so screens that show
 * "the current salary" keep working.
 */

/** Everything the salary formula stores on a profile (inputs and derived values). */
export const SALARY_STORED_FIELDS = [...SALARY_FIELDS, 'annualCtc', 'fixedSalary', 'grossSalary', 'totalNetSalary'] as const;
export type SalaryValues = Partial<Record<(typeof SALARY_STORED_FIELDS)[number], number>>;

/** Applies to every month. Used for a profile's first-ever salary and for the baseline captured before the first change. */
export const FROM_THE_BEGINNING = '0000-00';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isRevisionMonth = (m: unknown): m is string => typeof m === 'string' && MONTH_RE.test(m);

export const pickSalary = (src: object): SalaryValues => {
  const out: SalaryValues = {};
  for (const k of SALARY_STORED_FIELDS) {
    const v = (src as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
};

export const hasSalary = (src: { monthlyCtc?: number | null; grossSalary?: number | null }): boolean =>
  Number(src.monthlyCtc ?? 0) > 0 || Number(src.grossSalary ?? 0) > 0;

const byEffective = (a: SalaryRevision, b: SalaryRevision) =>
  a.effectiveFrom === b.effectiveFrom ? a.changedAt.localeCompare(b.changedAt) : a.effectiveFrom.localeCompare(b.effectiveFrom);

/** The revision in force for `month`, or undefined when the profile has none for it. */
export function revisionFor(revisions: SalaryRevision[] | undefined, month: string): SalaryRevision | undefined {
  const sorted = [...(revisions ?? [])].sort(byEffective);
  let found: SalaryRevision | undefined;
  for (const r of sorted) if (r.effectiveFrom <= month) found = r;
  return found;
}

/** The profile as it stood for `month`: salary fields come from the revision in force, everything else is untouched. */
export function salaryAsOf<T extends EmployeeProfile>(profile: T, month: string): T {
  if (!profile.salaryRevisions?.length) return profile;
  const rev = revisionFor(profile.salaryRevisions, month);
  const cleared: Record<string, undefined> = {};
  for (const k of SALARY_STORED_FIELDS) cleared[k] = undefined;
  return { ...profile, ...cleared, ...(rev?.values ?? {}) };
}

/**
 * The revision list after saving `values` from `effectiveFrom`.
 *  - First revision of a profile that already had a salary: that salary is first kept as the baseline (all earlier months).
 *  - A profile with no salary yet gets its first salary from the beginning (nothing earlier to protect).
 *  - Saving again for the same month corrects that revision instead of stacking another one.
 */
export function withRevision(
  existing: EmployeeProfile, values: SalaryValues, effectiveFrom: string, changedBy: string, now: string
): { revisions: SalaryRevision[]; effectiveFrom: string } {
  const revisions: SalaryRevision[] = [...(existing.salaryRevisions ?? [])];
  const priorSalary = hasSalary(existing);
  let from = effectiveFrom;
  if (!revisions.length) {
    if (priorSalary) revisions.push({ effectiveFrom: FROM_THE_BEGINNING, values: pickSalary(existing), changedBy: 'baseline', changedAt: now });
    else from = FROM_THE_BEGINNING;
  }
  const i = revisions.findIndex((r) => r.effectiveFrom === from);
  const next: SalaryRevision = { effectiveFrom: from, values, changedBy, changedAt: now };
  if (i >= 0) revisions[i] = next;
  else revisions.push(next);
  revisions.sort(byEffective);
  return { revisions, effectiveFrom: from };
}

/** What the top-level salary fields should show: the revision with the latest effective month. */
export const latestValues = (revisions: SalaryRevision[]): SalaryValues =>
  [...revisions].sort(byEffective).at(-1)?.values ?? {};
