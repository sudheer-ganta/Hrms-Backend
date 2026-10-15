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
  version: '2026.10-3',

  // --- Salary structure (Annexure K) ---
  basicShareOfCtc: 0.5,
  hraShareOfCtc: 0.2,

  // --- Provident Fund ---
  pfRate: 0.12,
  pfMonthlyCap: 1800, // PF is 12% of basic, capped at this monthly amount (employee and employer)

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
   */
  ptDeductedFromNet: false,

  // --- Overtime / Off-day work ---
  otWageDivisorDays: 26,   // (Basic + DA) / 26 / hoursPerDay
  defaultOtMultiplier: 2,
  // (Basic + DA) / 26 x multiplier x days worked. Two keys on purpose: the business may price them differently.
  weeklyOffWorkMultiplier: 2,
  holidayWorkMultiplier: 2,
  /** Legacy: profile.otRatePerHour <= this value was interpreted as a MULTIPLIER. Superseded by profile.otMultiplier. */
  legacyOtMultiplierMax: 10,

  // --- Loss of pay ---
  /**
   * FINAL BUSINESS POLICY: HALF DAY = 0.5 PAYABLE DAY (0.5 LOP day deduction).
   */
  halfDayLopFraction: 0.5,
  /** Salary is prorated over calendar days of the month (28-31), not over 26 working days. */
  salaryProrationBasis: 'CALENDAR_DAYS' as const,
} as const;

export type PayrollRules = typeof PAYROLL_RULES;

