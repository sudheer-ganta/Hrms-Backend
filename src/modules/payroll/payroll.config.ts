/**
 * PAYROLL RULESET: every statutory / company salary constant lives here and ONLY here.
 *
 * These values reproduce the behavior of the previous implementation exactly. Where the
 * previous behavior was questionable it is NOT silently changed: the rule is exposed as a
 * flag with a comment so the business can decide, and the ruleset version is stored in every
 * closed-payroll snapshot.
 */
export const PAYROLL_RULES = {
  /** Bump whenever any number below changes; stored in snapshots. */
  version: '2026.10-6',

  // --- Salary structure (Annexure K) ---
  basicShareOfCtc: 0.5,
  hraShareOfCtc: 0.2,

  // --- Provident Fund ---
  // PAYROLL PF is NOT read from here any more: its rates and ceilings are edited in Settings (policy.statutory.pf) and
  // payroll.service.ts reads them from the policy, and so does the CTC-to-gross derivation (employees/salary.ts gets the
  // policy's rate and the ceiling in force). The values below are only the opening defaults of that policy, plus the
  // fallback for a salary calculation that is handed no PF terms.
  pfRate: 0.12,
  pfMonthlyCap: 1800, // the fallback cap (12% of a 15,000 ceiling) for a calculation given no PF terms
  /**
   * Opening defaults for the PF wage ceiling history. The Ministry of Labour notification S.O. 5109(E) raised it
   * from 15,000 to 25,000 with effect from 17 Sep 2026, so that month is split: 1-16 Sep at 15,000 and 17-30 Sep at 25,000,
   * each part prorated over the days of the month (see pfRule.ts). A future change is a new row in Settings, not here.
   */
  pfCeilings: [
    { from: '1900-01-01', ceiling: 15000 },
    { from: '2026-09-17', ceiling: 25000 },
  ] as readonly { from: string; ceiling: number }[],

  // --- ESIC (statutory gross wage ceiling of ₹21,000/month; 0.75% employee, 3.25% employer) ---
  esiWageCeiling: 21000,
  esiCtcThreshold: 21000,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,

  // --- Professional Tax (Karnataka official rule: Gross >= ₹25,000 -> ₹200/month) ---
  ptGrossThreshold: 25000,
  ptCtcThreshold: 25000,
  ptMonthly: 200,
  /**
   * EXISTING BEHAVIOR (preserved): PT is carved out of CTC when deriving Gross
   * (Gross = CTC - employer PF - employer ESIC - PT) and is NOT deducted again from
   * net pay. The payslip therefore shows it as "employer-borne", not as a deduction.
   * Set to true only if the company decides PT must also be deducted from the employee.
   *
   * 2026.10-4: the company's statement deducts PT from net pay, on the earned gross INCLUDING OT and weekly-off/holiday
   * pay (>= ptGrossThreshold => ptMonthly). ESI wages exclude HRA, and ESI is rounded UP.
   */
  ptDeductedFromNet: true,

  // --- Overtime / Off-day work ---
  otWageDivisorDays: 26,   // (Basic + DA) / 26 / hoursPerDay
  defaultOtMultiplier: 2,
  // (Basic + DA) / 26 x multiplier x days worked. Two keys on purpose: the business may price them differently.
  weeklyOffWorkMultiplier: 2,
  holidayWorkMultiplier: 2,

  // --- Loss of pay ---
  /**
   * FINAL BUSINESS POLICY: HALF DAY = 0.5 PAYABLE DAY (0.5 LOP day deduction).
   */
  halfDayLopFraction: 0.5,
  /** Salary is prorated over calendar days of the month (28-31), not over 26 working days. */
  salaryProrationBasis: 'CALENDAR_DAYS' as const,
} as const;

export type PayrollRules = typeof PAYROLL_RULES;

