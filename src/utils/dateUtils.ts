import { instantFromIst, isValidBusinessDate as isValidDateGuard, istToday } from './istTime.js';

const isValidBusinessDate = (x: string): boolean => isValidDateGuard(x);

/**
 * Vendor (e-TimeOffice) date helpers. Everything is pure string arithmetic on IST wall-clock
 * values; nothing depends on the server timezone.
 */

/** "YYYY-MM-DD" → "dd/MM/yyyy_HH:mm" (API 2 request format). */
export const formatForETimeofficeRequest = (date: string, time: string = '00:00'): string => {
  const iso = toIsoDate(date);
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}_${time}`;
};

/** "YYYY-MM-DD" → "dd/MM/yyyy" (API 3 request format). */
export const formatForETimeofficeInOutRequest = (date: string): string => {
  const iso = toIsoDate(date);
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const toIsoDate = (date: string): string => {
  const s = String(date || '').trim();
  if (isValidBusinessDate(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (isValidBusinessDate(iso)) return iso;
  }
  throw new Error(`Invalid date provided for e-Timeoffice request: ${date}`);
};

/** "dd/MM/yyyy" (or ISO) → "YYYY-MM-DD". Returns '' when unparseable. */
export const convertDateStringToISO = (dateStr: string): string => {
  const s = String(dateStr || '').trim();
  if (isValidBusinessDate(s)) return s;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidBusinessDate(iso) ? iso : '';
  }
  return '';
};

export interface ParsedPunchDate {
  punchDateTime: Date; // UTC instant
  entryDate: string;   // YYYY-MM-DD IST
  entryTime: string;   // HH:mm:ss IST
}

/**
 * Parses the vendor PunchDate (IST wall clock) into a UTC instant plus IST business date/time.
 * Accepted: dd/MM/yyyy HH:mm[:ss], dd-MM-yyyy HH:mm[:ss], yyyy-MM-dd HH:mm[:ss], yyyy/MM/dd HH:mm[:ss].
 */
export const parseVendorPunchDate = (punchDateStr: string): ParsedPunchDate => {
  if (!punchDateStr || typeof punchDateStr !== 'string') throw new Error('PunchDate is required and must be a string');
  const s = punchDateStr.trim();
  let date = '';
  let time = '';
  let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    time = `${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}`;
  } else {
    m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      time = `${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}`;
    }
  }
  if (!date || !isValidBusinessDate(date) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) {
    throw new Error(`Unable to parse vendor PunchDate: "${punchDateStr}"`);
  }
  return { punchDateTime: instantFromIst(date, time), entryDate: date, entryTime: time };
};

/** "HH:MM" → minutes. Returns 0 for empty / "--:--" / "00:00". */
export const parseWorkTimeToMinutes = (timeStr?: string): number => {
  if (!timeStr || timeStr === '--:--' || timeStr === '00:00') return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
  return 0;
};

export const formatMinutesToHours = (minutes: number): string => {
  const mm = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};

/** Current IST business date. */
export const getTodayDateString = (): string => istToday();
