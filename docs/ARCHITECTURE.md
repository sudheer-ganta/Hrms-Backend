# HRMS architecture: one source of truth

The backend owns every business rule. The frontend renders what the backend returns. MongoDB is the only
system of record. There is no local-file fallback and no UI-side business calculation.

```
Employee (employees.empCode, normalized, immutable)
   │  EmployeeSourceMapping: (sourceId, vendorEmployeeCode) → empCode
   ▼
RawPunch (attendance_records)         append-only, idempotent on a timezone-independent hash
   origin: DEVICE | ESS_WEB            (vendor sync and web punches are the same kind of fact)
   ▲                                   in_out_records = vendor daily summary, STAGING input only
   │
AttendanceDay (attendance_days)       ONE row per employee per IST business date: the FACTS
   firstIn, lastOut, workMinutes, vendorStatus, sources, origins, adjustment ids
   │   + AttendanceAdjustment (attendance_adjustments): effect of an approved request, reversible
   ▼
resolveDay(facts, policy)             THE single authority. Pure function. Produces the verdict:
   PRESENT | HALF_DAY | ABSENT | WEEKLY_OFF | HOLIDAY | LEAVE_PAID | LEAVE_UNPAID
   | WORK_FROM_HOME | ON_DUTY | MISSED_PUNCH   (+ work minutes, OT minutes, late)
   │
   ├── /attendance/days, /calendar, /timesheet, /stats      (admin grid, portal, dashboard)
   └── payroll engine ──► computeEmployeePayroll() ──► payroll_snapshots (immutable, versioned)
                                                        └── payslip (lines foot to net pay)
```

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | `empCode` (via `normalizeEmpCode`) is the canonical employee key; `employeeId` (`_id`) is exposed in the DTO. | The code is immutable (`immutable: true`, never accepted from clients), so it is as stable as an id and already present in every collection. Vendor codes map to it through `employee_source_mappings`. |
| 2 | **Status is computed at read time**; only FACTS are stored. | A holiday, weekly-off or threshold change can never leave a stale stored verdict. Cost: a pure function per day, negligible at this scale. |
| 3 | `web-portal` is not a source. ESS punches are `RawPunch(origin=ESS_WEB)` attached to the matched Site. | Removes the second daily row per person. |
| 4 | Vendor "present"/"half" verdicts are honored; vendor "absent" is re-derived by our policy; vendor off-days are honored. | This preserves previous payroll behavior exactly. Only the authority moved (one function instead of five). |
| 5 | A single punch is `MISSED_PUNCH`: paid as a standard day, flagged for review. | Previous payroll paid it as present; the label is now honest. |
| 6 | Weekly off / holiday win over every other signal. | Previous behavior. Work on an off day is paid via the explicit Sunday-work adjustment in the OT calculator. |
| 7 | `OPTIONAL` holidays are working days unless `paid: true`. Legacy holidays default to paid. | Explicit semantics, no silent change to existing data. |
| 8 | Requests are `PENDING → APPROVED → APPLIED`; `REJECTED`/`CANCELLED` from PENDING; `REVOKED` from APPROVED/APPLIED. | An approved request can only be undone by an explicit, audited revoke that recomputes the day. |
| 9 | Leave balance = quota − days used, per employee + leave type + calendar year; half days = 0.5; weekly offs and paid holidays are not counted. Pending requests are not deducted. | Replaces counting request rows. |
| 10 | Payroll rules live in `payroll.config.ts` with a version stamped on every snapshot. | See "Payroll rules preserved" below. |
| 11 | Closing a month: validate → freeze as **version N+1** in `payroll_snapshots` (immutable) → lock. Reopen needs a reason and is Super-Admin only; old versions are kept. | Audit trail, no silent overwrite. |
| 12 | Locked months reject adjustments, requests, holiday changes, ESS punches and recompute; vendor sync skips and reports them. | The snapshot can never drift from the data underneath it. |

## Payroll rules preserved (no silent salary changes)

`payroll.config.ts` reproduces the previous behavior. Two behaviors are questionable and are exposed as
explicit flags rather than changed:

* `halfDayLopFraction = 0`: a half day is paid in full (as before). Set to `0.5` to deduct half a day.
* `ptDeductedFromNet = false`: Professional Tax is carved out of CTC when deriving gross and is not deducted again
  from net pay (as before). The payslip now shows it under "employer-borne" instead of as a phantom deduction.
  Set to `true` only if the company decides PT must come out of the employee's pay.

Other documented consequences of unifying the formula: when a stored profile has gaps, the CTC breakdown is
completed by the single formula in `employees/salary.ts` (previously two slightly different fallbacks existed).
`gross = CTC − employer PF − employer ESIC − PT − minimum bonus` (the bonus term is 0 for every profile that has
no bonus configured, so existing results are unchanged).

## Security model

Every route declares one of `PUBLIC`, `AUTHENTICATED`, `EMPLOYEE_SELF`, `FOUNDER_OR_SUPER_ADMIN`,
`SUPER_ADMIN_ONLY` (see `middleware/auth.middleware.ts → access`). Tokens carry only `{id, tokenVersion}`; the
current user (role, status, employee code) is loaded from the database on every request, so deactivation,
password reset/change and logout take effect immediately. Login is rate limited, passwords follow a policy, and
there are no default credentials anywhere in source.

## Time

Instants are UTC. Business dates (`YYYY-MM-DD`) and months (`YYYY-MM`) are Asia/Kolkata and are produced only by
`utils/istTime.ts` (backend) and `lib/businessDate.ts` (frontend). Vendor timestamps are IST wall-clock values and
are converted without reading the server timezone. Durations handle overnight shifts (`22:00 → 06:00 = 8h`).

## API contract

Success: `{ success: true, data, pagination?, summary? }`. Error:
`{ success: false, error: { code, message, details? } }` with 400 / 401 / 403 / 404 / 409 / 422 / 429 / 502 / 503 / 500.
Business failures are never HTTP 200. Types are mirrored in `Hrms-Frontend-/src/types/index.ts`, and
`Hrms-Frontend-/tests/lib.test.ts` fails the build if the enums or the payroll DTO drift apart.

## Business-rule traceability (configure once, apply everywhere)

Rule values live in ONE place, `policies` (MongoDB), edited on Settings, cached per instance and refreshed on save
and every 30 s. Rule *interpretation* lives in ONE function each. Nothing else may re-derive either; the test
`no module hard-codes a configurable policy value` fails the build if a default shift time or threshold literal
reappears outside `policy.service.ts` / `policy.model.ts`.

| Rule | Configured in | Interpreted ONLY in | Consumed by |
|---|---|---|---|
| Shift start / end / name | Settings > Shift (`policy.shift`) | `resolveDay`, `policy.service` helpers | Attendance grid, timesheet, dashboard, portal, payroll (standard day, OT), ESS punch (overnight) |
| Grace period / late-in | `shift.gracePeriodMinutes` | `resolveDay` (`isLate`, `lateMinutes`) | Same as above; payroll `lateArrivals`; `derived.lateAfter` for the Settings hint |
| Early checkout | `shift.endTime` | `resolveDay` (`earlyCheckoutMinutes`) | Grid, timesheet, portal |
| Half-day / full-day thresholds, full-day checkout cutoff | `shift.*Threshold*`, `minCheckoutForFullDay` | `classifyWork` | Everything that shows a status; payroll present/half/absent days |
| Weekly off days | `policy.weeklyOffDays` | `isWeeklyOffDate` | Resolver, leave-day counting, payroll weekly-off count |
| Holidays, paid / unpaid | `policy.holidays[].paid` | `isHolidayDate`, resolver (`isHoliday`, `isPaidHoliday`) | Resolver, leave-day counting, payroll holiday count |
| Work on weekly off / paid holiday | Settings > Work on Weekly Off (`policy.offDayWork`) | `resolveDay` (`offDayWorkFraction`) | Payroll `sundayDays` (HR override still wins), timesheet, portal, employee drawer |
| Overtime on/off, hours per day | `policy.overtime` | `resolveDay` (`overtimeMinutes`), payroll hourly rate | Payroll, reports |
| Leave quotas | `policy.leaves` | `requests.service` balance | Requests, portal |
| Geofence mode | `policy.ess` | `punch.service` | ESS punch |
| Statutory / salary constants | `payroll.config.ts` (versioned) | `employees/salary.ts`, `computeEmployeePayroll` | Payroll, payslip, exports |

Every resolved day carries `policyVersion`. A closed payroll month stores the full `policy` it was computed under
(`payroll_snapshots.policy`, `policyVersion`), so later setting changes never rewrite history; reopening and
re-closing creates a new immutable version under the then-current policy.

Verified by `src/tests/policyPropagation.test.ts`: changing only Settings (shift times, grace, thresholds, cutoff)
changes the attendance rows, timesheet, dashboard counts, employee-portal rows and payroll together, with no
recompute call and no code change; changing only `offDayWork.recognition` makes weekly-off and paid-holiday work flow
into attendance, portal and payroll, and back.
