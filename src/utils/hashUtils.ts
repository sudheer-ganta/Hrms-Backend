import crypto from 'crypto';

/**
 * Creates a deterministic SHA-256 hash representing a biometric punch.
 * Uses: sourceId + employeeCode + punchTimestamp + machineId
 */
export const createVendorRecordHash = (
  sourceId: string,
  employeeCode: string,
  punchDateTime: Date | string,
  machineId?: string | null
): string => {
  const timestamp = typeof punchDateTime === 'string' 
    ? new Date(punchDateTime).toISOString() 
    : punchDateTime.toISOString();

  const normalizedSource = (sourceId || '').trim().toLowerCase();
  const normalizedEmp = (employeeCode || '').trim().toUpperCase();
  const normalizedMachine = (machineId || '0').toString().trim();

  const rawString = `${normalizedSource}|${normalizedEmp}|${timestamp}|${normalizedMachine}`;
  return crypto.createHash('sha256').update(rawString).digest('hex');
};
