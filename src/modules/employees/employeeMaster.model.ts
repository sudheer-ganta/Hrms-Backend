import mongoose, { Schema, Document } from 'mongoose';
import { EmployeeProfile } from './employeeMaster.types.js';

export interface EmployeeProfileDocument extends EmployeeProfile, Document {}

const EmployeeProfileSchema = new Schema<EmployeeProfileDocument>(
  {
    empCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    location: { type: String, trim: true },
    operationsCategory: { type: String, trim: true },
    joiningDate: { type: String },
    doj: { type: String },
    dob: { type: String },
    gender: { type: String },
    bloodGroup: { type: String },
    emergencyContact: { type: String },
    phone: { type: String },
    email: { type: String, lowercase: true, trim: true },
    managerEmpCode: { type: String },
    managerName: { type: String },

    // Financial / Annexure K CTC
    monthlyCtc: { type: Number, default: 0 },
    annualCtc: { type: Number, default: 0 },
    basicSalary: { type: Number, default: 0 },
    fixedSalary: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    grossSalary: { type: Number, default: 0 },
    employeePf: { type: Number, default: 0 },
    employeeEsic: { type: Number, default: 0 },
    totalNetSalary: { type: Number, default: 0 },
    employerPf: { type: Number, default: 0 },
    employerEsic: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    minimumBonus: { type: Number, default: 0 },

    // Bank Details
    bankName: { type: String },
    bankAccount: { type: String },
    bankAccountNumber: { type: String },
    ifscCode: { type: String },
    panNumber: { type: String },
    aadhaarNumber: { type: String },
    uanNumber: { type: String },

    // Work / OT
    otEligible: { type: Boolean, default: true },
    otRatePerHour: { type: Number, default: 0 },
    shiftName: { type: String, default: 'General Shift' },
    status: {
      type: String,
      enum: ['active', 'inactive', 'resigned'],
      default: 'active',
    },
    notes: { type: String },
    updatedAt: { type: String },
  },
  {
    timestamps: true,
    collection: 'employees',
  }
);

export const EmployeeModel = mongoose.model<EmployeeProfileDocument>(
  'EmployeeProfile',
  EmployeeProfileSchema
);
