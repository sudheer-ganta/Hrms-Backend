import { format, parse, isValid } from 'date-fns';

/**
 * Format a Date object or date string into e-Timeoffice request format:
 * dd/MM/yyyy_HH:mm  (e.g., "25/09/2026_00:00")
 */
export const formatForETimeofficeRequest = (date: Date | string, time: string = '00:00'): string => {
  let d: Date;
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, day] = date.split('-').map(Number);
      d = new Date(year, month - 1, day);
    } else {
      d = new Date(date);
    }
  } else {
    d = date;
  }

  if (!isValid(d)) {
    throw new Error(`Invalid date provided for e-Timeoffice request: ${date}`);
  }

  const dayStr = String(d.getDate()).padStart(2, '0');
  const monthStr = String(d.getMonth() + 1).padStart(2, '0');
  const yearStr = d.getFullYear();

  return `${dayStr}/${monthStr}/${yearStr}_${time}`;
};

/**
 * Format a Date object or date string into e-Timeoffice API 3 format:
 * dd/MM/yyyy (e.g., "25/09/2026")
 */
export const formatForETimeofficeInOutRequest = (date: Date | string): string => {
  let d: Date;
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, day] = date.split('-').map(Number);
      d = new Date(year, month - 1, day);
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      return date;
    } else {
      d = new Date(date);
    }
  } else {
    d = date;
  }

  if (!isValid(d)) {
    throw new Error(`Invalid date provided for e-Timeoffice request: ${date}`);
  }

  const dayStr = String(d.getDate()).padStart(2, '0');
  const monthStr = String(d.getMonth() + 1).padStart(2, '0');
  const yearStr = d.getFullYear();

  return `${dayStr}/${monthStr}/${yearStr}`;
};

/**
 * Converts a date string in format "dd/MM/yyyy" to "YYYY-MM-DD"
 */
export const convertDateStringToISO = (dateStr: string): string => {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const d = new Date(trimmed);
  if (isValid(d)) {
    return format(d, 'yyyy-MM-dd');
  }
  return dateStr;
};

/**
 * Parses vendor PunchDate string into normalized Date, entryDate (YYYY-MM-DD) and entryTime (HH:mm:ss).
 */
export interface ParsedPunchDate {
  punchDateTime: Date;
  entryDate: string; // YYYY-MM-DD
  entryTime: string; // HH:mm:ss
}

export const parseVendorPunchDate = (punchDateStr: string): ParsedPunchDate => {
  if (!punchDateStr || typeof punchDateStr !== 'string') {
    throw new Error('PunchDate is required and must be a string');
  }

  const trimmed = punchDateStr.trim();
  let parsedDate: Date | null = null;

  const formatsToTry = [
    'dd/MM/yyyy HH:mm:ss',
    'dd/MM/yyyy HH:mm',
    'dd-MM-yyyy HH:mm:ss',
    'dd-MM-yyyy HH:mm',
    'yyyy-MM-dd HH:mm:ss',
    'yyyy/MM/dd HH:mm:ss',
  ];

  for (const fmt of formatsToTry) {
    const candidate = parse(trimmed, fmt, new Date());
    if (isValid(candidate)) {
      parsedDate = candidate;
      break;
    }
  }

  if (!parsedDate || !isValid(parsedDate)) {
    const fallback = new Date(trimmed);
    if (isValid(fallback)) {
      parsedDate = fallback;
    }
  }

  if (!parsedDate || !isValid(parsedDate)) {
    throw new Error(`Unable to parse vendor PunchDate: "${punchDateStr}"`);
  }

  const entryDate = format(parsedDate, 'yyyy-MM-dd');
  const entryTime = format(parsedDate, 'HH:mm:ss');

  return {
    punchDateTime: parsedDate,
    entryDate,
    entryTime,
  };
};

/**
 * Converts HH:MM string to total minutes or hours
 */
export const parseWorkTimeToMinutes = (timeStr?: string): number => {
  if (!timeStr || timeStr === '--:--' || timeStr === '00:00') return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
};

export const formatMinutesToHours = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const getTodayDateString = (): string => {
  return format(new Date(), 'yyyy-MM-dd');
};
