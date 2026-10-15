import mongoose, { Schema, Document } from 'mongoose';
import { EmployeeProfile } from './employeeMaster.types.js';

export interface EmployeeProfileDocument extends Omit<EmployeeProfile, 'employeeId'>, Document {
  // Legacy duplicates kept readable for migration only; never written by the API.
  joiningDate?: string;
  bankAccountNumber?: string;
  allowances?: number;
}

const EmployeeProfileSchema = new Schema<EmployeeProfileDocument>(
  {
    empCode: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true, immutable: true },
    name: { type: String, required: true, trim: true },
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    location: { type: String, trim: true, lowercase: true }, // canonical siteId
    operationsCategory: { type: String, trim: true },
    doj: { type: String },
    dob: { type: String },
    gender: { type: String },
    bloodGroup: { type: String },
    emergencyContact: { type: String },
    phone: { type: String },
    email: { type: String, lowercase: true, trim: true },
    managerEmpCode: { type: String, uppercase: true, trim: true },
    managerName: { type: String },
    shiftName: { type: String },

    // Salary: intentionally NO defaults, so "unset" is distinguishable from an explicit 0.
    monthlyCtc: { type: Number },
    annualCtc: { type: Number },
    basicSalary: { type: Number },
    da: { type: Number },
    fixedSalary: { type: Number },
    hra: { type: Number },
    specialAllowance: { type: Number },
    otherAllowance: { type: Number },
    grossSalary: { type: Number },
    employeePf: { type: Number },
    employeeEsic: { type: Number },
    totalNetSalary: { type: Number },
    employerPf: { type: Number },
    employerEsic: { type: Number },
    professionalTax: { type: Number },
    minimumBonus: { type: Number },

    bankName: { type: String },
    bankAccount: { type: String },
    ifscCode: { type: String },
    panNumber: { type: String },
    aadhaarNumber: { type: String },
    uanNumber: { type: String },
    esiNumber: { type: String },

    otEligible: { type: Boolean, default: true },
    otMultiplier: { type: Number },
    otRatePerHour: { type: Number },
    status: { type: String, enum: ['active', 'inactive', 'resigned'], default: 'active' },
    notes: { type: String },
    updatedAt: { type: String },

    // legacy (read-only)
    joiningDate: { type: String },
    bankAccountNumber: { type: String },
    allowances: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'employees', strict: true } // updatedAt is an ISO string maintained by the service
);

export const EmployeeModel = mongoose.model<EmployeeProfileDocument>('EmployeeProfile', EmployeeProfileSchema);
