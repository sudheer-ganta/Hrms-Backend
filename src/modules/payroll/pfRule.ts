import { PAYROLL_RULES as R } from './payroll.config.js';

/** One stretch of a month that has a single PF wage ceiling. */
export interface PfSegment {
  fromDay: number;
  toDay: number;
  days: number;
  ceiling: number;
  /** PF wages for this stretch: min(ceiling, earned wages) x days / days in the month (a later stretch is rounded up to the rupee). */
  wages: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The PF wage ceiling in force on an ISO date (YYYY-MM-DD). `ceilings` is the policy's list (ascending by date). */
export function pfCeilingOn(isoDate: string, ceilings: readonly { from: string; ceiling: number }[] = R.pfCeilings): number {
  let ceiling: number = ceilings[0].ceiling;
  for (const row of ceilings) if (row.from <= isoDate) ceiling = row.ceiling;
  return ceiling;
}

/**
 * PF wages for a month. `earnedWages` is the month's earned fixed wages without HRA, OT and weekly-off / holiday pay.
 * A month with one ceiling gives min(ceiling, earned). A month the ceiling changes in is split at the change and each part
 * is prorated over the days of the month, which is how the EPFO worked example does it; the parts after the first are
 * rounded up to a whole rupee, as in the company's own statement.
 */
export function pfWagesForMonth(
  month: string,
  monthDays: number,
  earnedWages: number,
  ceilings: readonly { from: string; ceiling: number }[] = R.pfCeilings,
): { wages: number; segments: PfSegment[] } {
  const segments: PfSegment[] = [];
  if (monthDays <= 0 || earnedWages <= 0) return { wages: 0, segments };
  for (let day = 1; day <= monthDays; day++) {
    const ceiling = pfCeilingOn(`${month}-${String(day).padStart(2, '0')}`, ceilings);
    const last = segments[segments.length - 1];
    if (last && last.ceiling === ceiling) { last.toDay = day; last.days++; }
    else segments.push({ fromDay: day, toDay: day, days: 1, ceiling, wages: 0 });
  }
  // The company's statement keeps the first stretch exact and rounds every later stretch UP to the next whole rupee
  // (September 2026: 7,068.80 + ROUNDUP(13,254 x 14/30) = 7,068.80 + 6,186). A month with a single ceiling is never rounded.
  segments.forEach((s, i) => {
    const exact = r2((Math.min(s.ceiling, earnedWages) * s.days) / monthDays);
    s.wages = i === 0 ? exact : Math.ceil(exact);
  });
  return { wages: r2(segments.reduce((a, s) => a + s.wages, 0)), segments };
}
