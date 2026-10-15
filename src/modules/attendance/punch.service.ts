import { AttendanceModel } from './attendance.model.js';
import { attendanceDayService } from './attendanceDay.service.js';
import { employeeMasterService } from '../employees/employeeMaster.service.js';
import { policyService, isOvernightShift } from '../settings/policy.service.js';
import { siteService, matchSiteByGeo } from '../sites/site.service.js';
import { payrollRunService } from '../payroll/payrollRun.service.js';
import { ApiError } from '../../utils/apiError.js';
import { requireDb } from '../../config/db.js';
import { normalizeEmpCode } from '../../utils/empCode.js';
import { addDays, businessDateFromInstant, istTimeFromInstant, istTimeWithSecondsFromInstant } from '../../utils/istTime.js';
import { createRawPunchHash } from '../../utils/hashUtils.js';
import { requireObject, optionalNumber, optionalString } from '../../utils/validate.js';
import type { UserRole } from '../auth/auth.types.js';

const MIN_GAP_SECONDS = 60;      // double-tap protection
const MAX_ACCURACY_M = 300;      // GPS fix worse than this is rejected when geofencing is enforced
const OPEN_SESSION_MAX_HOURS = 20;

export type PunchType = 'IN' | 'OUT' | 'AUTO';

export interface PunchStatusDTO {
  empCode: string;
  businessDate: string;
  serverTimeIst: string;
  checkedIn: boolean;
  checkedOut: boolean;
  nextAction: 'IN' | 'OUT';
  firstIn: string | null;
  lastOut: string | null;
  workMinutes: number;
  status: string | null;
  statusLabel: string;
  inProgress: boolean;
  geofence: { mode: 'ENFORCE' | 'OFF'; configured: boolean };
}

export interface PunchResultDTO extends PunchStatusDTO {
  action: 'CHECKED_IN' | 'CHECKED_OUT';
  siteId: string | null;
  geofenceResult: 'INSIDE' | 'OVERRIDDEN' | 'NOT_ENFORCED';
  message: string;
}

class PunchService {
  private async geofenceInfo() {
    const sites = await siteService.getSites();
    return { sites, configured: sites.some((s) => s.active && !!s.geo) };
  }

  /** Raw ESS/device punches for the business date, oldest first. */
  private async punchesOn(empCode: string, businessDate: string) {
    return AttendanceModel.find({ employeeCode: empCode, entryDate: businessDate }).sort({ punchDateTime: 1 }).lean();
  }

  /**
   * Which business date does a punch (or a status lookup) at `now` belong to?
   * Normally the IST calendar date. For an OVERNIGHT shift an OUT after midnight belongs to the
   * business date of the still-open IN from the evening before; a fresh IN starts a new session.
   */
  private async businessDateFor(empCode: string, now: Date, mode: 'STATUS' | PunchType = 'STATUS'): Promise<string> {
    const today = businessDateFromInstant(now);
    if (!isOvernightShift(policyService.getSettings().shift)) return today;
    if ((await this.punchesOn(empCode, today)).length > 0) return today;
    const prev = addDays(today, -1);
    const prevPunches = await this.punchesOn(empCode, prev);
    const last = prevPunches[prevPunches.length - 1] as any;
    if (!last) return today;
    const ageH = (now.getTime() - new Date(last.punchDateTime).getTime()) / 3_600_000;
    if (ageH < 0 || ageH > OPEN_SESSION_MAX_HOURS) return today;
    const open = last.machineFlag === 'IN';
    if (mode === 'IN') return today; // a new IN is always a new session
    if (open) return prev; // OUT / AUTO / status continue the open session
    // session already closed: only an explicit OUT shortly after (a later checkout), or a status lookup, stays on it
    if (mode === 'OUT' && ageH <= 4) return prev;
    if (mode === 'STATUS' && ageH <= 12) return prev;
    return today;
  }

  public async getTodayStatus(empCodeInput: string, now: Date = new Date()): Promise<PunchStatusDTO> {
    requireDb();
    const empCode = normalizeEmpCode(empCodeInput);
    const businessDate = await this.businessDateFor(empCode, now, 'STATUS');
    const punches = await this.punchesOn(empCode, businessDate);
    const { day } = await attendanceDayService.resolveOne(empCode, businessDate);
    const policy = policyService.getSettings();
    const geo = await this.geofenceInfo();
    const count = punches.length;
    return {
      empCode,
      businessDate,
      serverTimeIst: istTimeWithSecondsFromInstant(now),
      checkedIn: count >= 1 || !!day.firstIn,
      checkedOut: !!day.lastOut && day.lastOut !== day.firstIn,
      nextAction: count === 0 ? 'IN' : 'OUT',
      firstIn: day.firstIn,
      lastOut: day.lastOut,
      workMinutes: day.workMinutes,
      status: day.status,
      statusLabel: day.statusLabel || 'Not punched today',
      inProgress: day.inProgress,
      geofence: { mode: policy.ess.geofenceMode, configured: geo.configured },
    };
  }

  public async recordPunch(
    input: unknown,
    actor: { id: string; role: UserRole; empCode?: string; name: string },
    now: Date = new Date() // injectable clock (tests); production always uses the real time
  ): Promise<PunchResultDTO> {
    requireDb();
    const body = requireObject(input);
    // Only SUPER_ADMIN / FOUNDER may punch for someone else or override the location check;
    // every other role (EMPLOYEE, HR) is self-service.
    const isAdmin = actor.role === 'SUPER_ADMIN' || actor.role === 'FOUNDER';
    const empCode = normalizeEmpCode(isAdmin ? body.empCode ?? actor.empCode : actor.empCode);
    if (!empCode) throw ApiError.validation('Employee code is required to record a punch.', [{ field: 'empCode', issue: 'Required' }]);

    const punchType = (body.punchType ?? 'AUTO') as PunchType;
    if (!['IN', 'OUT', 'AUTO'].includes(punchType)) throw ApiError.validation('punchType must be IN, OUT or AUTO.', [{ field: 'punchType', issue: 'Invalid value' }]);
    const lat = optionalNumber(body.latitude, 'latitude', { min: -90, max: 90 });
    const lng = optionalNumber(body.longitude, 'longitude', { min: -180, max: 180 });
    const accuracy = optionalNumber(body.accuracy, 'accuracy', { min: 0, max: 100000 });
    const note = optionalString(body.address ?? body.notes, 'address', 200);
    const override = body.override === true;
    if (override && !isAdmin) throw ApiError.forbidden('Only an administrator can override the location check.');

    const profile = await employeeMasterService.findProfile(empCode);
    if (!profile) throw ApiError.notFound(`Employee ${empCode} not found.`);
    if (profile.status !== 'active') throw ApiError.rule(`Employee ${empCode} is not active.`);

    const businessDate = await this.businessDateFor(empCode, now, punchType);
    await payrollRunService.assertMonthOpen(businessDate.slice(0, 7), 'Recording this punch');

    // ---- geofence: a real rule, with an explicit admin override ----
    const policy = policyService.getSettings();
    const geo = await this.geofenceInfo();
    let siteId: string | null = profile.location || null;
    let geofenceResult: PunchResultDTO['geofenceResult'] = 'NOT_ENFORCED';
    if (policy.ess.geofenceMode === 'ENFORCE' && geo.configured) {
      if (lat === undefined || lng === undefined) {
        if (!override) throw ApiError.rule('Your location is required to punch. Please allow location access and try again.');
        geofenceResult = 'OVERRIDDEN';
      } else {
        if (accuracy !== undefined && accuracy > MAX_ACCURACY_M && !override) {
          throw ApiError.rule(`Location accuracy is too low (±${Math.round(accuracy)}m). Move to an open area and try again.`);
        }
        const match = matchSiteByGeo(geo.sites, lat, lng);
        if (match) { siteId = match.site.siteId; geofenceResult = 'INSIDE'; }
        else if (override) geofenceResult = 'OVERRIDDEN';
        else throw ApiError.rule('You are outside the allowed punch locations. Move to your office/unit, or ask an administrator.');
      }
    }

    // ---- decide IN / OUT from the day's raw punches ----
    const punches = await this.punchesOn(empCode, businessDate);
    const last = punches[punches.length - 1] as any;
    if (last && (now.getTime() - new Date(last.punchDateTime).getTime()) / 1000 < MIN_GAP_SECONDS) {
      throw ApiError.conflict(`A punch was just recorded at ${istTimeFromInstant(new Date(last.punchDateTime))}. Please wait a minute.`);
    }
    let action: 'CHECKED_IN' | 'CHECKED_OUT';
    if (punchType === 'IN') {
      if (punches.length) throw ApiError.conflict(`Already checked in at ${istTimeFromInstant(new Date((punches[0] as any).punchDateTime))}.`);
      action = 'CHECKED_IN';
    } else if (punchType === 'OUT') {
      if (!punches.length) throw ApiError.conflict('You have not checked in today.');
      action = 'CHECKED_OUT';
    } else {
      action = punches.length ? 'CHECKED_OUT' : 'CHECKED_IN';
    }

    const entryDate = businessDateFromInstant(now);
    const entryTime = istTimeWithSecondsFromInstant(now);
    const sourceId = (siteId || 'unassigned').toLowerCase();
    const hash = createRawPunchHash({ origin: 'ESS_WEB', sourceId, employeeCode: empCode, entryDate, entryTime, machineId: `ESS:${action}` });

    // Raw punches are immutable facts: insert-only, idempotent on the hash.
    await AttendanceModel.updateOne(
      { vendorRecordHash: hash },
      {
        $setOnInsert: {
          sourceId, sourceName: 'ESS Web', siteId: siteId || undefined, employeeCode: empCode, vendorEmployeeCode: empCode,
          employeeName: profile.name, punchDateTime: now, entryDate: businessDate, entryTime, machineId: 'ESS',
          machineFlag: action === 'CHECKED_IN' ? 'IN' : 'OUT', origin: 'ESS_WEB',
          latitude: lat, longitude: lng, accuracy, syncedAt: now, vendorRecordHash: hash,
          meta: { note, geofence: geofenceResult, punchedBy: actor.id, punchedByName: actor.name, userAgent: String(body.userAgent || '').slice(0, 200) || undefined },
        },
      },
      { upsert: true }
    );
    await attendanceDayService.recompute(empCode, businessDate);

    const status = await this.getTodayStatus(empCode, now);
    const time = istTimeFromInstant(now);
    return {
      ...status,
      action,
      siteId,
      geofenceResult,
      message: action === 'CHECKED_IN' ? `Checked in at ${time} IST.` : `Checked out at ${time} IST. Worked so far: ${Math.floor(status.workMinutes / 60)}h ${status.workMinutes % 60}m.`,
    };
  }
}

export const punchService = new PunchService();
