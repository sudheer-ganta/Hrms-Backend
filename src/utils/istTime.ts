/**
 * HRMS time contract
 *  - Instants (punch timestamps) are stored in UTC.
 *  - Business dates are "YYYY-MM-DD" in Asia/Kolkata.
 *  - Business months are "YYYY-MM" in Asia/Kolkata.
 * Never use server-local time for HRMS business logic.
 */
const IST_OFFSET_MIN = 330; // Asia/Kolkata has no DST

const pad = (n: number) => String(n).padStart(2, '0');

const toIstParts = (instant: Date) => {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
  };
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidBusinessDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const isValidBusinessMonth = (s: unknown): s is string => typeof s === 'string' && MONTH_RE.test(s);

/** The IST calendar date of an instant. */
export const businessDateFromInstant = (instant: Date): string => {
  const p = toIstParts(instant);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

/** "HH:mm" (IST wall clock) of an instant. */
export const istTimeFromInstant = (instant: Date): string => {
  const p = toIstParts(instant);
  return `${pad(p.hh)}:${pad(p.mm)}`;
};

export const istTimeWithSecondsFromInstant = (instant: Date): string => {
  const p = toIstParts(instant);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
};

export const istToday = (now: Date = new Date()): string => businessDateFromInstant(now);
export const istMonth = (now: Date = new Date()): string => istToday(now).slice(0, 7);

/** Converts an IST wall-clock date + time ("YYYY-MM-DD","HH:mm[:ss]") to a UTC instant. */
export const instantFromIst = (date: string, time: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss || 0) - IST_OFFSET_MIN * 60_000);
};

/** Day name ("SUNDAY"…) of a business date, independent of server timezone. */
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type DayName = (typeof DAY_NAMES)[number];
export const DAY_NAME_LIST: readonly DayName[] = DAY_NAMES;

export const dayNameOf = (businessDate: string): DayName => {
  const [y, m, d] = businessDate.split('-').map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

export const addDays = (businessDate: string, days: number): string => {
  const [y, m, d] = businessDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

export const daysInMonth = (month: string): string[] => {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`);
};

export const monthOf = (businessDate: string): string => businessDate.slice(0, 7);

/** Months (YYYY-MM) touched by an inclusive date range. */
export const monthsInRange = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cur = from.slice(0, 7);
  const end = to.slice(0, 7);
  while (cur <= end) {
    out.push(cur);
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  return out;
};

/** "HH:mm" → minutes since midnight, or null. */
export const hhmmToMinutes = (t?: string | null): number | null => {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const minutesToHhmm = (minutes: number): string => {
  const mm = Math.max(0, Math.round(minutes));
  return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
};

/**
 * The ONE duration helper. Handles overnight (22:00 → 06:00 = 480 min).
 * A span longer than 20h is treated as invalid and returns 0.
 */
export const durationMinutes = (inTime?: string | null, outTime?: string | null): number => {
  const a = hhmmToMinutes(inTime);
  const b = hhmmToMinutes(outTime);
  if (a === null || b === null) return 0;
  let d = b - a;
  if (d < 0) d += 24 * 60;
  return d > 20 * 60 ? 0 : d;
};

/** Every business date in [from, to], inclusive. */
export const datesBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
