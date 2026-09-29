import fs from 'fs';
import path from 'path';
import { IAttendanceRecord } from '../modules/attendance/attendance.types.js';
import { IInOutRecord } from '../modules/attendance/inOut.types.js';
import { ISyncLog } from '../modules/sync/sync.types.js';

interface StorageData {
  records: IAttendanceRecord[];
  inOutRecords: IInOutRecord[];
  syncLogs: (ISyncLog & { _id: string })[];
  adjustments: Record<string, Record<string, { otHours?: number; totalWorkHours?: number; multiplier?: number; sundayDays?: number }>>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'attendance_store.json');

const ensureDataFile = (): StorageData => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const initial: StorageData = { records: [], inOutRecords: [], syncLogs: [], adjustments: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.records) parsed.records = [];
    if (!parsed.inOutRecords) parsed.inOutRecords = [];
    if (!parsed.syncLogs) parsed.syncLogs = [];
    if (!parsed.adjustments) parsed.adjustments = {};
    return parsed;
  } catch {
    const fallback: StorageData = { records: [], inOutRecords: [], syncLogs: [], adjustments: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(fallback, null, 2), 'utf-8');
    return fallback;
  }
};

const saveData = (data: StorageData): void => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write local store file:', err);
  }
};

export const localStore = {
  getRecords: (): IAttendanceRecord[] => {
    return ensureDataFile().records;
  },

  upsertRecords: (records: IAttendanceRecord[]): { inserted: number; duplicates: number } => {
    const data = ensureDataFile();
    const existingHashes = new Set(data.records.map((r) => r.vendorRecordHash));
    let inserted = 0;
    let duplicates = 0;

    for (const rec of records) {
      if (existingHashes.has(rec.vendorRecordHash)) {
        duplicates++;
      } else {
        existingHashes.add(rec.vendorRecordHash);
        data.records.unshift(rec);
        inserted++;
      }
    }

    if (inserted > 0) {
      saveData(data);
    }
    return { inserted, duplicates };
  },

  getInOutRecords: (): IInOutRecord[] => {
    return ensureDataFile().inOutRecords;
  },

  upsertInOutRecords: (records: IInOutRecord[]): { inserted: number; updated: number } => {
    const data = ensureDataFile();
    const map = new Map<string, number>();
    data.inOutRecords.forEach((r, idx) => map.set(r.recordKey, idx));

    let inserted = 0;
    let updated = 0;

    for (const rec of records) {
      if (map.has(rec.recordKey)) {
        const idx = map.get(rec.recordKey)!;
        data.inOutRecords[idx] = rec;
        updated++;
      } else {
        map.set(rec.recordKey, data.inOutRecords.length);
        data.inOutRecords.unshift(rec);
        inserted++;
      }
    }

    saveData(data);
    return { inserted, updated };
  },

  addSyncLog: (log: ISyncLog): ISyncLog & { _id: string } => {
    const data = ensureDataFile();
    const withId = {
      ...log,
      _id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date(),
    };
    data.syncLogs.unshift(withId);
    saveData(data);
    return withId;
  },

  updateSyncLog: (id: string, updates: Partial<ISyncLog>): void => {
    const data = ensureDataFile();
    const idx = data.syncLogs.findIndex((l) => l._id === id);
    if (idx !== -1) {
      data.syncLogs[idx] = { ...data.syncLogs[idx], ...updates };
      saveData(data);
    }
  },

  getSyncLogs: (): (ISyncLog & { _id: string })[] => {
    return ensureDataFile().syncLogs;
  },

  getAdjustments: (month: string): Record<string, { otHours?: number; totalWorkHours?: number; multiplier?: number }> => {
    const data = ensureDataFile();
    return data.adjustments?.[month] || {};
  },

  saveAdjustments: (
    month: string,
    adjustments: Record<string, { otHours?: number; totalWorkHours?: number; multiplier?: number }>
  ): void => {
    const data = ensureDataFile();
    if (!data.adjustments) data.adjustments = {};
    data.adjustments[month] = adjustments;
    saveData(data);
  },

  clearAdjustments: (month: string): void => {
    const data = ensureDataFile();
    if (data.adjustments && data.adjustments[month]) {
      delete data.adjustments[month];
      saveData(data);
    }
  },
};
