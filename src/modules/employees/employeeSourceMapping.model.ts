import mongoose, { Schema, Document } from 'mongoose';

/**
 * EmployeeSourceMapping: which vendor code identifies which employee at which source.
 * A vendor code is only unique within its own vendor account.
 */
export interface IEmployeeSourceMapping {
  employeeCode: string;       // canonical employee code
  sourceId: string;
  vendorEmployeeCode: string; // normalized vendor code
}
export interface EmployeeSourceMappingDocument extends IEmployeeSourceMapping, Document {}

const Schema_ = new Schema<EmployeeSourceMappingDocument>(
  {
    employeeCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    sourceId: { type: String, required: true, lowercase: true, trim: true },
    vendorEmployeeCode: { type: String, required: true, uppercase: true, trim: true },
  },
  { timestamps: true, collection: 'employee_source_mappings' }
);
Schema_.index({ sourceId: 1, vendorEmployeeCode: 1 }, { unique: true });

export const EmployeeSourceMappingModel = mongoose.model<EmployeeSourceMappingDocument>('EmployeeSourceMapping', Schema_);
