import mongoose from 'mongoose';
import { EmployeeModel } from './employeeMaster.model.js';
import { EmployeeProfile, EmployeeProfileUpdateInput } from './employeeMaster.types.js';
import { InOutModel } from '../attendance/inOut.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';

function toProfile(doc: any): EmployeeProfile {
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return {
    ...rest,
    updatedAt: rest.updatedAt || (updatedAt ? new Date(updatedAt).toISOString() : undefined),
  } as EmployeeProfile;
}

class EmployeeMasterService {
  private lastDiscoveryTime = 0;
  private static readonly DISCOVERY_INTERVAL_MS = 60 * 1000; // at most once every 60s

  private assertDbConnected(): void {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Employee master data requires an active database connection. Please try again shortly.');
    }
  }

  /**
   * Returns all employee profiles, automatically populating new biometric employees
   */
  public async getAllProfiles(): Promise<EmployeeProfile[]> {
    this.assertDbConnected();
    await this.discoverNewEmployees();
    const docs = await EmployeeModel.find({}).lean();
    return docs.map(toProfile);
  }

  /**
   * Scans recent biometric data for employee codes with no master profile yet,
   * and creates a baseline profile for each so they show up across the app.
   */
  private async discoverNewEmployees(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiscoveryTime < EmployeeMasterService.DISCOVERY_INTERVAL_MS) return;
    this.lastDiscoveryTime = now;

    let inOutRecords: any[] = [];
    let rawRecords: any[] = [];
    try {
      [inOutRecords, rawRecords] = await Promise.all([
        InOutModel.find({}, { employeeCode: 1, employeeName: 1, sourceId: 1 }).limit(1000).maxTimeMS(2000).lean(),
        AttendanceModel.find({}, { employeeCode: 1, employeeName: 1, sourceId: 1 }).limit(1000).maxTimeMS(2000).lean(),
      ]);
    } catch {
      return;
    }

    const enrolledMap = new Map<string, { name: string; location: string }>();
    for (const r of inOutRecords) {
      if (r.employeeCode && !enrolledMap.has(r.employeeCode)) {
        enrolledMap.set(r.employeeCode, {
          name: r.employeeName || `Employee ${r.employeeCode}`,
          location: r.sourceId || 'Budigere',
        });
      }
    }
    for (const p of rawRecords) {
      if (p.employeeCode && !enrolledMap.has(p.employeeCode)) {
        enrolledMap.set(p.employeeCode, {
          name: p.employeeName || `Employee ${p.employeeCode}`,
          location: p.sourceId || 'Budigere',
        });
      }
    }

    if (enrolledMap.size === 0) return;

    const existingCodes = new Set(
      (await EmployeeModel.find({}, { empCode: 1 }).lean()).map((d: any) => d.empCode)
    );

    const newDocs = Array.from(enrolledMap.entries())
      .filter(([code]) => !existingCodes.has(code))
      .map(([code, info]) => ({
        empCode: code,
        name: info.name,
        location: info.location,
        otEligible: true,
        status: 'active' as const,
        updatedAt: new Date().toISOString(),
      }));

    if (newDocs.length > 0) {
      await EmployeeModel.insertMany(newDocs, { ordered: false }).catch((err) => {
        console.warn('[EmployeeMasterService] Could not insert newly discovered employees:', err.message);
      });
    }
  }

  /**
   * Get single employee profile by code. Auto-provisions a baseline profile
   * the first time a known biometric employee is looked up.
   */
  public async getProfile(empCode: string): Promise<EmployeeProfile | null> {
    this.assertDbConnected();

    const existing = await EmployeeModel.findOne({ empCode }).lean();
    if (existing) return toProfile(existing);

    const inOut = await InOutModel.findOne({ employeeCode: empCode }).lean();
    const raw = inOut ? null : await AttendanceModel.findOne({ employeeCode: empCode }).lean();
    const source: any = inOut || raw;
    if (!source) return null;

    const created = await EmployeeModel.findOneAndUpdate(
      { empCode },
      {
        $setOnInsert: {
          empCode,
          name: source.employeeName || `Employee ${empCode}`,
          location: source.sourceId || 'Budigere',
          otEligible: true,
          status: 'active',
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true, new: true }
    ).lean();

    return toProfile(created);
  }

  /**
   * Update employee profile (DOB, Email, Monthly CTC, Annexure K Breakdown, Bank details, etc.)
   */
  public async updateProfile(empCode: string, input: EmployeeProfileUpdateInput): Promise<EmployeeProfile> {
    this.assertDbConnected();

    let existing = await this.getProfile(empCode);
    if (!existing) {
      existing = {
        empCode,
        name: `Employee ${empCode}`,
        otEligible: true,
        status: 'active',
      };
    }

    const ctc = input.monthlyCtc !== undefined && input.monthlyCtc !== null && Number(input.monthlyCtc) > 0
      ? Number(input.monthlyCtc)
      : existing.monthlyCtc;

    let basicSalary = input.basicSalary;
    let fixedSalary = input.fixedSalary;
    let hra = input.hra;
    let specialAllowance = input.specialAllowance;
    let grossSalary = input.grossSalary;
    let employeePf = input.employeePf;
    let employeeEsic = input.employeeEsic;
    let totalNetSalary = input.totalNetSalary;
    let employerPf = input.employerPf;
    let employerEsic = input.employerEsic;
    let professionalTax = input.professionalTax;
    let minimumBonus = input.minimumBonus ?? existing.minimumBonus ?? 0;

    // Auto-calculate Annexure K CTC breakdown if monthly CTC is provided
    if (ctc && ctc > 0) {
      if (basicSalary === undefined) basicSalary = Math.round(ctc * 0.50);
      if (fixedSalary === undefined) fixedSalary = basicSalary;
      if (hra === undefined) hra = Math.round(ctc * 0.20);
      if (employerPf === undefined) employerPf = Math.min(1800, Math.round(basicSalary * 0.12));
      if (professionalTax === undefined) professionalTax = ctc >= 15000 ? 200 : 0;
      if (employerEsic === undefined) employerEsic = ctc <= 21000 ? Math.round(ctc * 0.0325) : 0;

      if (employeePf === undefined) employeePf = employerPf;
      if (employeeEsic === undefined) employeeEsic = ctc <= 21000 ? Math.round(ctc * 0.0075) : 0;

      if (grossSalary === undefined) {
        grossSalary = ctc - employerPf - employerEsic - professionalTax;
      }

      if (specialAllowance === undefined) {
        specialAllowance = Math.max(0, grossSalary - basicSalary - (input.da ?? existing.da ?? 0) - (input.otherAllowance ?? existing.otherAllowance ?? 0) - hra);
      }

      if (totalNetSalary === undefined) {
        totalNetSalary = grossSalary - employeePf - employeeEsic;
      }
    }

    const updated: EmployeeProfile = {
      ...existing,
      ...input,
      monthlyCtc: ctc,
      annualCtc: ctc ? ctc * 12 : undefined,
      basicSalary,
      da: input.da !== undefined && input.da !== null ? Number(input.da) : existing.da,
      fixedSalary,
      hra,
      specialAllowance,
      otherAllowance: input.otherAllowance !== undefined && input.otherAllowance !== null ? Number(input.otherAllowance) : existing.otherAllowance,
      grossSalary,
      employeePf,
      employeeEsic,
      totalNetSalary,
      employerPf,
      employerEsic,
      professionalTax,
      minimumBonus,
      otEligible: input.otEligible !== undefined ? input.otEligible : existing.otEligible,
      otRatePerHour: input.otRatePerHour !== undefined ? Number(input.otRatePerHour) : existing.otRatePerHour,
      updatedAt: new Date().toISOString(),
    };

    await EmployeeModel.findOneAndUpdate({ empCode }, { $set: updated }, { upsert: true, new: true });
    return updated;
  }
}

export const employeeMasterService = new EmployeeMasterService();
