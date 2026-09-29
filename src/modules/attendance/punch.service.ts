import { InOutModel } from './inOut.model.js';
import { AttendanceModel } from './attendance.model.js';
import { localStore } from '../../config/localStore.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { policyService } from '../settings/policy.service.js';
import { IInOutRecord } from './inOut.types.js';
import { IAttendanceRecord } from './attendance.types.js';
import mongoose from 'mongoose';

// Known Office Coordinates for Automatic Geofence Matching (Bangalore/ColorMyles Units)
const KNOWN_OFFICE_LOCATIONS = [
  { name: 'ColorMyles HQ', lat: 12.9716, lng: 77.5946, radiusMeters: 800 },
  { name: 'Budigere Unit', lat: 13.0673, lng: 77.7420, radiusMeters: 800 },
  { name: 'Bidarahalli Unit', lat: 13.0310, lng: 77.7080, radiusMeters: 800 },
];

/**
 * Calculates distance between two GPS coordinates in meters using Haversine formula
 */
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export interface PunchInput {
  empCode: string;
  empName?: string;
  punchType?: 'IN' | 'OUT' | 'AUTO';
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  address?: string;
  deviceInfo?: string;
}

export interface PunchResult {
  success: boolean;
  action: 'CHECKED_IN' | 'CHECKED_OUT';
  empCode: string;
  empName: string;
  serverISTDate: string;
  serverISTTime: string;
  inTime: string;
  outTime: string;
  workTime: string;
  workMinutes: number;
  status: string;
  statusLabel: string;
  locationTag: string;
  message: string;
}

export class PunchService {
  /**
   * Strictly resolves the authoritative current Date and Time in Indian Standard Time (IST)
   */
  public getServerISTNow(): { isoDate: string; timeStr: string; fullTimeStr: string; timestamp: Date } {
    const now = new Date();

    // Indian Standard Time (UTC+5:30)
    const istDateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const istTimeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    const istFullTimeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    return {
      isoDate: istDateFormatter.format(now), // "YYYY-MM-DD"
      timeStr: istTimeFormatter.format(now), // "HH:mm"
      fullTimeStr: istFullTimeFormatter.format(now), // "HH:mm:ss"
      timestamp: now,
    };
  }

  /**
   * Resolves location description based on GPS coordinates and office geofences
   */
  public resolveLocationTag(latitude?: number, longitude?: number, accuracy?: number, customAddress?: string): string {
    if (latitude !== undefined && longitude !== undefined && !isNaN(latitude) && !isNaN(longitude)) {
      for (const office of KNOWN_OFFICE_LOCATIONS) {
        const dist = calculateDistanceMeters(latitude, longitude, office.lat, office.lng);
        if (dist <= office.radiusMeters) {
          return `${office.name} (On-Premises • ${Math.round(dist)}m from center)`;
        }
      }

      const accText = accuracy ? ` ±${Math.round(accuracy)}m` : '';
      if (customAddress && customAddress.trim()) {
        return `${customAddress.trim()} (${latitude.toFixed(4)}, ${longitude.toFixed(4)}${accText})`;
      }
      return `Field / Remote Location (${latitude.toFixed(4)}° N, ${longitude.toFixed(4)}° E${accText})`;
    }

    return 'Web ESS Portal (Manual Geolocation Unavailable)';
  }

  /**
   * Fetch today's punch status for an employee
   */
  public async getTodayStatus(empCode: string): Promise<any> {
    const { isoDate, timeStr, fullTimeStr } = this.getServerISTNow();
    const cleanCode = empCode.trim().toUpperCase();
    const isDbConnected = mongoose.connection.readyState === 1;

    let existingRecord: any = null;
    if (isDbConnected) {
      try {
        existingRecord = await InOutModel.findOne({
          employeeCode: cleanCode,
          date: isoDate,
        }).lean();
      } catch (err) {
        console.warn('DB error fetching today punch status:', err);
      }
    }

    if (!existingRecord) {
      const localRecords = localStore.getInOutRecords();
      existingRecord = localRecords.find((r) => r.employeeCode === cleanCode && r.date === isoDate);
    }

    const inTime = existingRecord?.inTime && existingRecord.inTime !== '--:--' ? existingRecord.inTime : null;
    const outTime = existingRecord?.outTime && existingRecord.outTime !== '--:--' ? existingRecord.outTime : null;

    const checkedIn = Boolean(inTime);
    const checkedOut = Boolean(outTime && outTime !== inTime);

    return {
      empCode: cleanCode,
      serverISTDate: isoDate,
      serverISTTime: timeStr,
      serverISTFullTime: fullTimeStr,
      checkedIn,
      checkedOut,
      inTime: inTime || '--:--',
      outTime: outTime || '--:--',
      workTime: existingRecord?.workTime || '00:00',
      workMinutes: existingRecord?.workMinutes || 0,
      status: existingRecord?.status || (checkedIn ? 'P' : 'A'),
      statusLabel: existingRecord?.statusLabel || (checkedIn ? 'Present' : 'Not Punched Today'),
      remark: existingRecord?.remark || '',
      sourceName: existingRecord?.sourceName || 'Web / Mobile ESS',
    };
  }

  /**
   * Records an employee check-in or check-out with server-enforced IST time and Geolocation
   */
  public async recordPunch(input: PunchInput): Promise<PunchResult> {
    const { isoDate, timeStr, fullTimeStr, timestamp } = this.getServerISTNow();
    const cleanCode = input.empCode.trim().toUpperCase();

    // 1. Resolve employee name — a brief DB hiccup shouldn't block check-in/out,
    // so fall back to a generic label rather than let a lookup failure here
    // fail the whole punch.
    let empName = input.empName?.trim();
    if (!empName) {
      try {
        const profile = await employeeMasterService.getProfile(cleanCode);
        empName = profile?.name || `Employee ${cleanCode}`;
      } catch {
        empName = `Employee ${cleanCode}`;
      }
    }

    // 2. Resolve Geolocation Tag
    const locationTag = this.resolveLocationTag(input.latitude, input.longitude, input.accuracy, input.address);

    // 3. Check existing today's InOut record
    const isDbConnected = mongoose.connection.readyState === 1;
    let existingRecord: any = null;

    if (isDbConnected) {
      try {
        existingRecord = await InOutModel.findOne({
          employeeCode: cleanCode,
          date: isoDate,
        }).lean();
      } catch (err) {
        console.warn('DB error fetching existing record for punch:', err);
      }
    }

    if (!existingRecord) {
      const localRecords = localStore.getInOutRecords();
      existingRecord = localRecords.find((r) => r.employeeCode === cleanCode && r.date === isoDate);
    }

    let action: 'CHECKED_IN' | 'CHECKED_OUT' = 'CHECKED_IN';
    let inTime = existingRecord?.inTime && existingRecord.inTime !== '--:--' ? existingRecord.inTime : '--:--';
    let outTime = existingRecord?.outTime && existingRecord.outTime !== '--:--' ? existingRecord.outTime : '--:--';

    // 4. Determine action
    if (input.punchType === 'IN') {
      action = 'CHECKED_IN';
      inTime = timeStr;
    } else if (input.punchType === 'OUT') {
      action = 'CHECKED_OUT';
      outTime = timeStr;
      if (inTime === '--:--') inTime = timeStr; // Fallback if no check-in was recorded
    } else {
      // AUTO mode
      if (inTime === '--:--') {
        action = 'CHECKED_IN';
        inTime = timeStr;
      } else {
        action = 'CHECKED_OUT';
        outTime = timeStr;
      }
    }

    // 5. Calculate work duration
    let workMinutes = 0;
    if (inTime !== '--:--' && outTime !== '--:--') {
      const [inH, inM] = inTime.split(':').map(Number);
      const [outH, outM] = outTime.split(':').map(Number);
      const startTotal = inH * 60 + inM;
      const endTotal = outH * 60 + outM;
      workMinutes = Math.max(0, endTotal - startTotal);
    } else if (inTime !== '--:--') {
      // Ongoing active shift
      const [inH, inM] = inTime.split(':').map(Number);
      const [curH, curM] = timeStr.split(':').map(Number);
      workMinutes = Math.max(0, curH * 60 + curM - (inH * 60 + inM));
    }

    const workHours = Math.floor(workMinutes / 60);
    const workMins = workMinutes % 60;
    const workTime = `${String(workHours).padStart(2, '0')}:${String(workMins).padStart(2, '0')}`;

    // 6. Policy Status Evaluation
    const policy = policyService.getSettings();
    const minCheckoutForFullDay = policy.shift?.minCheckoutForFullDay || '16:00';
    const minMinutesForFullDay = policy.shift?.fullDayThresholdMinutes || 360;
    const minMinutesForHalfDay = policy.shift?.halfDayThresholdMinutes || 180;

    let status = 'P';
    let statusLabel = 'Present';

    if (action === 'CHECKED_OUT') {
      if (outTime >= minCheckoutForFullDay || workMinutes >= minMinutesForFullDay) {
        status = 'P';
        statusLabel = 'Present (Full Day)';
      } else if (workMinutes >= minMinutesForHalfDay) {
        status = 'P/2';
        statusLabel = 'Half Day';
      } else {
        status = 'P';
        statusLabel = 'Present';
      }
    } else {
      status = 'P';
      statusLabel = 'Checked In (Active Shift)';
    }

    const sourceId = 'web-portal';
    const recordKey = `${sourceId}_${cleanCode}_${isoDate}`;

    const normalizedInOut: IInOutRecord = {
      sourceId,
      sourceName: 'Web / Mobile ESS',
      employeeCode: cleanCode,
      employeeName: empName,
      date: isoDate,
      inTime,
      outTime,
      workTime,
      workMinutes,
      overTime: '00:00',
      breakTime: '00:00',
      lateIn: '00:00',
      earlyOut: '00:00',
      status,
      statusLabel,
      remark: `${action === 'CHECKED_IN' ? 'Checked In' : 'Checked Out'} via ESS (${locationTag})`,
      syncedAt: timestamp,
      recordKey,
    };

    // 7. Save InOut Record
    if (isDbConnected) {
      try {
        await InOutModel.findOneAndUpdate({ recordKey }, normalizedInOut, { upsert: true, new: true });
      } catch (dbErr) {
        console.warn('MongoDB InOut upsert failed, falling back to localStore:', dbErr);
        localStore.upsertInOutRecords([normalizedInOut]);
      }
    } else {
      localStore.upsertInOutRecords([normalizedInOut]);
    }

    // 8. Log Raw Punch Swipe
    const rawRecordHash = `${cleanCode}_${isoDate}_${fullTimeStr}_${action}`;
    const rawPunchRecord: IAttendanceRecord = {
      sourceId,
      sourceName: 'Web / Mobile ESS',
      employeeCode: cleanCode,
      employeeName: empName,
      punchDateTime: timestamp,
      entryDate: isoDate,
      entryTime: fullTimeStr,
      machineId: 'ESS_GEO_PORTAL',
      machineFlag: action === 'CHECKED_IN' ? 'IN' : 'OUT',
      vendorRecordHash: rawRecordHash,
      syncedAt: timestamp,
    };

    if (isDbConnected) {
      try {
        await AttendanceModel.findOneAndUpdate({ vendorRecordHash: rawRecordHash }, rawPunchRecord, {
          upsert: true,
          new: true,
        });
      } catch (err) {
        console.warn('MongoDB raw punch log failed:', err);
        localStore.upsertRecords([rawPunchRecord]);
      }
    } else {
      localStore.upsertRecords([rawPunchRecord]);
    }

    const message =
      action === 'CHECKED_IN'
        ? `Successfully Checked In at ${timeStr} IST! Have a productive day.`
        : `Successfully Checked Out at ${timeStr} IST! Today's work duration: ${workTime}.`;

    return {
      success: true,
      action,
      empCode: cleanCode,
      empName,
      serverISTDate: isoDate,
      serverISTTime: timeStr,
      inTime,
      outTime,
      workTime,
      workMinutes,
      status,
      statusLabel,
      locationTag,
      message,
    };
  }
}

export const punchService = new PunchService();
