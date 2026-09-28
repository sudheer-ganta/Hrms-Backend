import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { EmployeeProfile, EmployeeProfileUpdateInput } from './employeeMaster.types.js';
import { localStore } from '../../config/localStore.js';
import { InOutModel } from '../attendance/inOut.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../../data');
const PROFILES_FILE = path.join(DATA_DIR, 'employee_profiles.json');

class EmployeeMasterService {
  private profilesMap: Map<string, EmployeeProfile> = new Map();
  private lastDiscoveryTime = 0;
  private static readonly DISCOVERY_INTERVAL_MS = 60 * 1000; // at most once every 60s

  constructor() {
    this.ensureDataDir();
    this.loadProfiles();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadProfiles(): void {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        const raw = fs.readFileSync(PROFILES_FILE, 'utf-8');
        const list: EmployeeProfile[] = JSON.parse(raw);
        this.profilesMap.clear();
        for (const p of list) {
          this.profilesMap.set(p.empCode, p);
        }
      }
    } catch (err) {
      console.warn('[EmployeeMasterService] Error reading employee_profiles.json:', err);
    }
  }

  private saveProfiles(): void {
    try {
      this.ensureDataDir();
      const list = Array.from(this.profilesMap.values());
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('[EmployeeMasterService] Failed to save profiles:', err);
    }
  }

  /**
   * Returns all employee profiles, automatically populating new biometric employees
   */
  public async getAllProfiles(): Promise<EmployeeProfile[]> {
    this.loadProfiles();

    const now = Date.now();
    // Fast return if profiles are already loaded and discovery ran recently
    if (this.profilesMap.size > 0 && now - this.lastDiscoveryTime < EmployeeMasterService.DISCOVERY_INTERVAL_MS) {
      return Array.from(this.profilesMap.values());
    }
    this.lastDiscoveryTime = now;

    const isDbConnected = mongoose.connection.readyState === 1;
    let inOutRecords: any[] = [];
    let rawRecords: any[] = [];

    if (isDbConnected) {
      try {
        [inOutRecords, rawRecords] = await Promise.all([
          InOutModel.find({}, { employeeCode: 1, employeeName: 1, sourceId: 1 }).limit(1000).maxTimeMS(2000).lean(),
          AttendanceModel.find({}, { employeeCode: 1, employeeName: 1, sourceId: 1 }).limit(1000).maxTimeMS(2000).lean(),
        ]);
      } catch {
        inOutRecords = [];
        rawRecords = [];
      }
    }

    if (inOutRecords.length === 0 && rawRecords.length === 0) {
      inOutRecords = localStore.getInOutRecords().slice(0, 500);
      rawRecords = localStore.getRecords().slice(0, 500);
    }
    const enrolledMap = new Map<string, { name: string; location: string }>();

    for (const r of inOutRecords) {
      if (r.employeeCode && !enrolledMap.has(r.employeeCode)) {
        enrolledMap.set(r.employeeCode, {
          name: r.employeeName || `Employee ${r.employeeCode}`,
          location: r.sourceId || 'Budigere'
        });
      }
    }

    for (const p of rawRecords) {
      if (p.employeeCode && !enrolledMap.has(p.employeeCode)) {
        enrolledMap.set(p.employeeCode, {
          name: p.employeeName || `Employee ${p.employeeCode}`,
          location: p.sourceId || 'Budigere'
        });
      }
    }

    // Ensure each enrolled employee has a baseline profile
    let changed = false;
    for (const [code, info] of enrolledMap.entries()) {
      if (!this.profilesMap.has(code)) {
        const newProfile: EmployeeProfile = {
          empCode: code,
          name: info.name,
          location: info.location,
          otEligible: true,
          status: 'active',
          updatedAt: new Date().toISOString()
        };
        this.profilesMap.set(code, newProfile);
        changed = true;
      }
    }

    if (changed) {
      this.saveProfiles();
    }

    return Array.from(this.profilesMap.values());
  }

  /**
   * Get single employee profile by code
   */
  public async getProfile(empCode: string): Promise<EmployeeProfile | null> {
    if (this.profilesMap.has(empCode)) {
      return this.profilesMap.get(empCode)!;
    }

    const isDbConnected = mongoose.connection.readyState === 1;

    // Check if employee exists in in-out data or raw punches
    const inOut = isDbConnected
      ? await InOutModel.findOne({ employeeCode: empCode }).lean()
      : localStore.getInOutRecords().find(r => r.employeeCode === empCode);
    if (inOut) {
      const newProfile: EmployeeProfile = {
        empCode: inOut.employeeCode,
        name: inOut.employeeName || `Employee ${inOut.employeeCode}`,
        location: inOut.sourceId || 'Budigere',
        otEligible: true,
        status: 'active',
        updatedAt: new Date().toISOString()
      };
      this.profilesMap.set(empCode, newProfile);
      this.saveProfiles();
      return newProfile;
    }

    const raw = isDbConnected
      ? await AttendanceModel.findOne({ employeeCode: empCode }).lean()
      : localStore.getRecords().find(p => p.employeeCode === empCode);
    if (raw) {
      const newProfile: EmployeeProfile = {
        empCode: raw.employeeCode,
        name: raw.employeeName || `Employee ${raw.employeeCode}`,
        location: raw.sourceId || 'Budigere',
        otEligible: true,
        status: 'active',
        updatedAt: new Date().toISOString()
      };
      this.profilesMap.set(empCode, newProfile);
      this.saveProfiles();
      return newProfile;
    }

    return null;
  }

  /**
   * Update employee profile (DOB, Email, Monthly CTC, Annexure K Breakdown, Bank details, etc.)
   */
  public async updateProfile(empCode: string, input: EmployeeProfileUpdateInput): Promise<EmployeeProfile> {
    let existing = await this.getProfile(empCode);

    if (!existing) {
      existing = {
        empCode,
        name: `Employee ${empCode}`,
        otEligible: true,
        status: 'active'
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
        specialAllowance = Math.max(0, grossSalary - basicSalary - hra);
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
      fixedSalary,
      hra,
      specialAllowance,
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
      updatedAt: new Date().toISOString()
    };

    this.profilesMap.set(empCode, updated);
    this.saveProfiles();
    return updated;
  }
}

export const employeeMasterService = new EmployeeMasterService();
