import { PAYROLL_RULES as R } from '../payroll/payroll.config.js';

/**
 * ONE backend formula for the Annexure K salary structure.
 * Used by: profile save, the salary-preview endpoint, and the payroll engine (for legacy
 * profiles that have gaps). The frontend never reconstructs any of this.
 *
 * Top-down: monthly CTC is the input; everything else is derived unless explicitly overridden.
 *   Gross   = CTC - employerPF - employerESIC - PT - minimumBonus
 *   Special = Gross - Basic - DA - Other - HRA   (never negative)
 *   Net(G)  = Gross - employeePF - employeeESIC  (before PT, which is employer-borne; see payroll.config)
 */
export interface SalaryInputs {
  monthlyCtc?: number | null;
  basicSalary?: number | null;
  da?: number | null;
  hra?: number | null;
  specialAllowance?: number | null;
  otherAllowance?: number | null;
  employeePf?: number | null;
  employerPf?: number | null;
  employeeEsic?: number | null;
  employerEsic?: number | null;
  professionalTax?: number | null;
  minimumBonus?: number | null;
  grossSalary?: number | null;
  statutoryEsicWages?: number | null;
}

export interface SalaryBreakdown {
  monthlyCtc: number;
  annualCtc: number;
  basicSalary: number;
  fixedSalary: number;
  da: number;
  hra: number;
  specialAllowance: number;
  otherAllowance: number;
  grossSalary: number;
  statutoryEsicWages: number;
  employeePf: number;
  employerPf: number;
  employeeEsic: number;
  employerEsic: number;
  professionalTax: number;
  minimumBonus: number;
  totalNetSalary: number;
  rulesVersion: string;
}

const has = (v: unknown): v is number => v !== undefined && v !== null && Number.isFinite(Number(v));
const n = (v: unknown): number => Number(v);

export function computeSalaryBreakdown(input: SalaryInputs): SalaryBreakdown | null {
  const ctc = has(input.monthlyCtc) ? n(input.monthlyCtc) : 0;
  if (ctc <= 0) return null;

  const basic = has(input.basicSalary) ? n(input.basicSalary) : Math.round(ctc * R.basicShareOfCtc);
  const da = has(input.da) ? n(input.da) : 0;
  const hra = has(input.hra) ? n(input.hra) : Math.round(ctc * R.hraShareOfCtc);
  const other = has(input.otherAllowance) ? n(input.otherAllowance) : 0;
  const bonus = has(input.minimumBonus) ? n(input.minimumBonus) : 0;

  const erPf = has(input.employerPf) ? n(input.employerPf) : Math.min(R.pfMonthlyCap, Math.round(basic * R.pfRate));
  const eePf = has(input.employeePf) ? n(input.employeePf) : erPf;

  let gross = 0;
  let statutoryEsicWages = 0;
  let erEsic = 0;
  let eeEsic = 0;
  let pt = 0;

  if (has(input.grossSalary)) {
    gross = n(input.grossSalary);
    pt = has(input.professionalTax) ? n(input.professionalTax) : gross >= R.ptGrossThreshold ? R.ptMonthly : 0;
    statutoryEsicWages = has(input.statutoryEsicWages)
      ? n(input.statutoryEsicWages)
      : gross <= R.esiWageCeiling ? gross : 0;
    const esiEligible = statutoryEsicWages > 0;
    erEsic = has(input.employerEsic) ? n(input.employerEsic) : esiEligible ? Math.round(statutoryEsicWages * R.esiEmployerRate) : 0;
    eeEsic = has(input.employeeEsic) ? n(input.employeeEsic) : esiEligible ? Math.round(statutoryEsicWages * R.esiEmployeeRate) : 0;
  } else {
    // Top-down derivation from CTC
    pt = has(input.professionalTax) ? n(input.professionalTax) : ctc >= R.ptGrossThreshold ? R.ptMonthly : 0;
    const baseForGross = ctc - erPf - pt - bonus;
    // Check if gross falls within statutory ESIC wage ceiling (<= ₹21,000)
    const tentativeGross = Math.round(baseForGross / (1 + R.esiEmployerRate));
    if (tentativeGross <= R.esiWageCeiling) {
      statutoryEsicWages = tentativeGross;
      erEsic = has(input.employerEsic) ? n(input.employerEsic) : Math.round(statutoryEsicWages * R.esiEmployerRate);
      eeEsic = has(input.employeeEsic) ? n(input.employeeEsic) : Math.round(statutoryEsicWages * R.esiEmployeeRate);
    } else {
      statutoryEsicWages = 0;
      erEsic = has(input.employerEsic) ? n(input.employerEsic) : 0;
      eeEsic = has(input.employeeEsic) ? n(input.employeeEsic) : 0;
    }
    gross = ctc - erPf - erEsic - pt - bonus;
  }

  const special = has(input.specialAllowance) ? n(input.specialAllowance) : Math.max(0, gross - basic - da - other - hra);
  const net = Math.max(0, gross - eePf - eeEsic);

  return {
    monthlyCtc: ctc,
    annualCtc: ctc * 12,
    basicSalary: basic,
    fixedSalary: basic,
    da,
    hra,
    specialAllowance: special,
    otherAllowance: other,
    grossSalary: gross,
    statutoryEsicWages,
    employeePf: eePf,
    employerPf: erPf,
    employeeEsic: eeEsic,
    employerEsic: erEsic,
    professionalTax: pt,
    minimumBonus: bonus,
    totalNetSalary: net,
    rulesVersion: R.version,
  };
}

