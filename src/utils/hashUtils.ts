import crypto from 'crypto';

/**
 * Deterministic idempotency key of a raw punch, built ONLY from canonical business values
 * (IST date + time, no server-timezone-dependent instant). The same vendor punch always
 * produces the same hash on any machine, so re-syncs never duplicate it.
 */
export const createRawPunchHash = (parts: {
  origin: string;
  sourceId: string;
  employeeCode: string;
  entryDate: string; // YYYY-MM-DD IST
  entryTime: string; // HH:mm:ss IST
  machineId?: string | null;
}): string => {
  const raw = [
    parts.origin.trim().toUpperCase(),
    parts.sourceId.trim().toLowerCase(),
    parts.employeeCode.trim().toUpperCase(),
    parts.entryDate,
    parts.entryTime,
    String(parts.machineId ?? '0').trim(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
};
