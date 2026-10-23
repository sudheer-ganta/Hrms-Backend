import { HRMSPolicySettings, ShiftConfig } from './policy.types.js';
import { pfPolicy, isOvernightShift } from './policy.service.js';
import { PAYROLL_RULES as R } from '../payroll/payroll.config.js';
import { hhmmToMinutes, minutesToHhmm } from '../../utils/istTime.js';

/**
 * The company rulebook, as plain sentences, built from the values the system really uses (the live policy and the payroll
 * ruleset). It is generated, never typed, so this page cannot drift away from what attendance and payroll do.
 */
export interface RuleItem {
  title: string;
  detail: string;
}
export interface RuleSection {
  id: string;
  title: string;
  /** Where the numbers in this section can be changed ("Settings → Shift & Grace Rules"), or null if they are fixed. */
  editableIn: string | null;
  rules: RuleItem[];
}
export interface RulesDocument {
  generatedAt: string;
  policyVersion: number;
  payrollRulesVersion: string;
  sections: RuleSection[];
}

const t12 = (hhmm: string): string => {
  const m = hhmmToMinutes(hhmm);
  if (m === null) return hhmm;
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
};
const dur = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
};
const pct = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
const inr = (n: number): string => `₹${n.toLocaleString('en-IN')}`;
const titleCase = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();
const windows = (s: ShiftConfig): string => (s.otWindows.length ? s.otWindows.map((w) => `${t12(w.start)} to ${t12(w.end)}`).join(' and ') : 'none');

const lateAfter = (s: ShiftConfig): string => {
  const start = hhmmToMinutes(s.startTime) ?? 0;
  return t12(minutesToHhmm((start + s.gracePeriodMinutes) % 1440));
};

export function buildRules(policy: HRMSPolicySettings): RulesDocument {
  const s = policy.shift;
  const pf = pfPolicy(policy);
  const offDays = policy.weeklyOffDays.map(titleCase).join(', ') || 'none';
  const weeklyAuto = policy.offDayWork.weeklyOff.recognition === 'AUTOMATIC';
  const holidayAuto = policy.offDayWork.paidHoliday.recognition === 'AUTOMATIC';
  const paidHolidays = policy.holidays.filter((h) => h.paid !== false).length;
  const days = R.weeklyOffWorkAfterAbsentDays;
  const ceilings = pf.ceilings.map((c) => `${inr(c.ceiling)} from ${c.from === '1900-01-01' ? 'the beginning' : c.from}`).join(', then ');

  const sections: RuleSection[] = [
    {
      id: 'attendance',
      title: 'Attendance: how a day is decided',
      editableIn: 'Settings → Shift & Grace Rules',
      rules: [
        { title: 'General shift', detail: `${t12(s.startTime)} to ${t12(s.endTime)}${isOvernightShift(s) ? ' (overnight)' : ''}. Used by everyone who is not assigned to another shift.` },
        { title: 'Late', detail: `Late means the first punch is after ${lateAfter(s)} (shift start plus ${s.gracePeriodMinutes} min grace).` },
        { title: 'Present (full day)', detail: `Working ${dur(s.fullDayThresholdMinutes)} or more is a full day${s.minCheckoutForFullDay && !isOvernightShift(s) ? `. Punching out at or after ${t12(s.minCheckoutForFullDay)} (with at least the half-day hours) also counts as a full day` : ''}.` },
        { title: 'Half day', detail: `Working ${dur(s.halfDayThresholdMinutes)} or more, but less than a full day, is a half day.` },
        { title: 'Absent', detail: `Working less than ${dur(s.halfDayThresholdMinutes)} (or no punches on a working day) is absent.` },
        { title: 'One punch only', detail: 'A day with a single punch is paid as a present day but flagged "Missed Punch" so it can be corrected.' },
        { title: 'The biometric device does not decide the day', detail: 'Present, half and absent come from the hours worked and the numbers above, never from the device\'s own P / P-2 / A codes. The device\'s weekly-off, holiday and paid-leave codes are still honoured.' },
        { title: 'Approved requests win', detail: 'An approved leave, missed-punch, work-from-home or on-duty request overrides the punches for that day.' },
        { title: 'Before joining / after leaving', detail: 'Days before the joining date or after the last working day are "not employed": not absent, not paid, no loss of pay.' },
        { title: 'Future days', detail: 'Days that have not happened yet have no status.' },
      ],
    },
    {
      id: 'shifts',
      title: 'Other shifts',
      editableIn: 'Settings → Shift & Grace Rules',
      rules: policy.shifts.length
        ? policy.shifts.map((x) => ({
            title: x.shiftName,
            detail: `${t12(x.startTime)} to ${t12(x.endTime)}${isOvernightShift(x) ? ' (overnight)' : ''}, grace ${x.gracePeriodMinutes} min, full day ${dur(x.fullDayThresholdMinutes)}, half day ${dur(x.halfDayThresholdMinutes)}. Overtime hours: ${windows(x)}.`,
          }))
        : [{ title: 'No other shifts', detail: 'Everyone follows the general shift. Add shifts in Settings → Shift & Grace Rules and assign them on the employee profile.' }],
    },
    {
      id: 'offdays',
      title: 'Weekly offs, holidays and working on them',
      editableIn: 'Settings → Shift & Grace Rules (weekly off days, work on weekly off) and Holidays & Weekly Offs (the calendar)',
      rules: [
        { title: 'Weekly off', detail: `${offDays}. Paid as part of the monthly salary.` },
        { title: 'Company holidays', detail: `${paidHolidays} paid holiday(s) are set for the year. A holiday marked unpaid or optional is a normal working day.` },
        { title: 'Working on a weekly off', detail: weeklyAuto
            ? `Credited automatically from the punches: a full day counts 1 day, a half day counts 0.5. Paid at ${R.weeklyOffWorkMultiplier}x the daily rate, on top of the salary (only for employees with the overtime switch on).`
            : 'HR enters the days worked in the OT Calculator each month. Paid at the weekly-off rate, only for employees with the overtime switch on.' },
        { title: 'Working on a paid holiday', detail: holidayAuto
            ? `Credited automatically from the punches (full day 1, half day 0.5), paid at ${R.holidayWorkMultiplier}x the daily rate.`
            : `HR enters the days worked in the OT Calculator each month, paid at ${R.holidayWorkMultiplier}x the daily rate.` },
        { title: days > 0 ? `Absent ${days} days in a row, then works the weekly off` : 'Absent days before a weekly off', detail: days > 0
            ? `If someone was absent on each of the ${days} days just before a weekly off and then works that weekly off, it is a normal working day. No weekly-off working pay and no overtime is added; the weekly off is simply part of the salary. Leave, holidays and other weekly offs in between break the run (only real absences count). This applies to the automatic crediting; days HR types in by hand are HR's decision.`
            : 'This rule is switched off.' },
      ],
    },
    {
      id: 'overtime',
      title: 'Overtime',
      editableIn: 'Settings → Shift & Grace Rules (Shifts, Overtime Pay) and the OT switch on each employee',
      rules: [
        { title: 'Who gets overtime', detail: 'Only employees whose profile has "Eligible for overtime pay" switched on. Nobody else earns any, whatever time they punch out.' },
        { title: 'What counts', detail: policy.overtime.enabled
            ? `Only the time between the first and last punch that falls inside the shift's overtime hours. General shift overtime hours: ${windows(s)}. Time outside them (the shift itself, a break) is never overtime. A shift with no overtime hours has no overtime.`
            : 'Overtime is switched off for the whole company.' },
        { title: 'The device\'s overtime figure', detail: 'Not used. Overtime is always worked out from the punches and the hours above.' },
        { title: 'Overtime pay', detail: `(Basic + DA) ÷ ${R.otWageDivisorDays} days ÷ ${policy.overtime.hoursPerDay} hours, times ${R.defaultOtMultiplier} (the employee's own multiplier, or HR's figure for the month, replaces ${R.defaultOtMultiplier}).` },
        { title: 'HR override', detail: 'HR can type the overtime hours, multiplier and off-day work days for a month in the OT Calculator; that figure replaces the automatic one.' },
      ],
    },
    {
      id: 'leave',
      title: 'Leave and requests',
      editableIn: 'Settings → Shift & Grace Rules (leave quotas)',
      rules: [
        { title: 'Yearly leave', detail: `Casual ${policy.leaves.casualLeave}, sick ${policy.leaves.sickLeave}, earned ${policy.leaves.earnedLeave}, comp-off ${policy.leaves.compOff} days.` },
        { title: 'How a request moves', detail: 'Pending → Approved → Applied to the attendance. An approver can reject; the employee can cancel a pending request; an applied request can be revoked with a reason.' },
        { title: 'Limits', detail: 'A request covers at most 31 days and cannot span two calendar years. Leave is refused if the balance is too low (unpaid leave excepted). Weekly offs and holidays inside the range are not counted as leave days. Two requests cannot cover the same day.' },
        { title: 'Half-day leave', detail: 'A paid half-day leave costs no pay (the leave balance covers it). An unpaid half-day loses 0.5 day of pay.' },
        { title: 'Closed months', detail: 'No request can be created or approved for a date in a closed payroll month.' },
      ],
    },
    {
      id: 'pay',
      title: 'Salary and loss of pay',
      editableIn: null,
      rules: [
        { title: 'Salary structure', detail: `Basic is ${pct(R.basicShareOfCtc * 100)} of CTC and HRA is ${pct(R.hraShareOfCtc * 100)}. Gross = CTC − employer PF − employer ESIC − professional tax − minimum bonus; Special Allowance is what remains after Basic, DA, HRA and Other.` },
        { title: 'Daily rate', detail: 'Gross salary ÷ the calendar days of the month (28 to 31), not 26.' },
        { title: 'Loss of pay', detail: `Each absent day and each unpaid-leave day loses one day's pay; each half day loses ${R.halfDayLopFraction} day. Weekly offs, paid holidays and paid leave lose nothing.` },
        { title: 'Month still running', detail: 'Pay accrues for the days that have passed; the rest is shown as "days not yet accrued".' },
        { title: 'Pay items HR types each month', detail: 'Salary advance, other deduction, LWF, attendance bonus and increment / reimbursement are entered in the OT Calculator.' },
        { title: 'Net pay', detail: 'Earned gross − PF − ESI − professional tax − the deductions HR typed + bonus / reimbursement. Never below zero.' },
      ],
    },
    {
      id: 'statutory',
      title: 'PF, ESI and professional tax',
      editableIn: 'Settings → Shift & Grace Rules → Provident Fund (PF) Rules (PF only; ESI and professional tax are fixed in the payroll rules)',
      rules: [
        { title: 'Provident Fund', detail: `Employee ${pct(pf.employeeRatePct)} of the PF wages; the employer pays the same. Of the employer share, ${pct(pf.epsRatePct)} of the wages goes to the pension scheme; admin charge ${pct(pf.adminRatePct)} and EDLI ${pct(pf.edliRatePct)} are the employer's on top.` },
        { title: 'PF wages', detail: `The earned basic-type pay (everything except HRA), capped at the ceiling in force: ${ceilings}. Overtime and weekly-off / holiday pay are left out.` },
        { title: 'Month where the ceiling changes', detail: 'The month is split by days at each ceiling. The first part is exact; every later part is rounded up to the rupee, as the company statement does.' },
        { title: 'ESI', detail: `Applies when the non-HRA salary is ${inr(R.esiWageCeiling)} or less a month. Employee ${pct(R.esiEmployeeRate * 100)} (rounded up), employer ${pct(R.esiEmployerRate * 100)}. HRA, overtime and off-day pay are left out of the wages.` },
        { title: 'Professional tax', detail: `${inr(R.ptMonthly)} a month when the earned gross (including overtime and off-day pay) is ${inr(R.ptGrossThreshold)} or more. ${R.ptDeductedFromNet ? 'Deducted from net pay.' : 'Paid by the employer, not deducted.'}` },
      ],
    },
    {
      id: 'closing',
      title: 'Closing a payroll month',
      editableIn: 'Settings → Payroll Closing',
      rules: [
        { title: 'When', detail: 'A month can be closed only after it has fully ended.' },
        { title: 'What closing does', detail: 'Freezes exactly what was paid as a permanent record, together with the rule versions used. Later changes to attendance or settings do not alter it.' },
        { title: 'Reopening', detail: 'Needs a reason (at least 5 characters). Every earlier version is kept; closing again makes a new version.' },
        { title: 'Locked while closed', detail: 'Attendance corrections and recomputes, leave and other requests, web punches, holiday changes, salary changes taking effect in that month, and the monthly pay items HR types are all refused for that month until it is reopened.' },
      ],
    },
    {
      id: 'punching',
      title: 'Web punching and sync',
      editableIn: 'Settings → Shift & Grace Rules (location check) and Auto-Sync Scheduler',
      rules: [
        { title: 'Location check', detail: policy.ess.geofenceMode === 'ENFORCE' ? 'A web punch outside the site\'s set location is rejected (sites without a location are not checked).' : 'Web punches are not location-checked.' },
        { title: 'Double taps', detail: 'A second web punch within 60 seconds of the last one is refused ("please wait a minute").' },
        { title: 'Poor GPS', detail: 'When the location check is on, a GPS fix worse than 300 m is rejected.' },
        { title: 'Biometric sync', detail: policy.scheduler.enabled ? `Punches are pulled from the devices every ${policy.scheduler.intervalMinutes} minute(s) while the server is awake.` : 'Automatic sync is off; use Sync Devices.' },
      ],
    },
  ];

  return { generatedAt: new Date().toISOString(), policyVersion: policy.version, payrollRulesVersion: R.version, sections };
}
