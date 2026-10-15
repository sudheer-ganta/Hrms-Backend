import mongoose, { Schema } from 'mongoose';
import { InOutRecordDocument } from './inOut.types.js';

// Collection: in_out_records. Vendor staging only (see inOut.types.ts).
const InOutRecordSchema = new Schema<InOutRecordDocument>(
  {
    sourceId: { type: String, required: true, index: true, trim: true, lowercase: true },
    sourceName: { type: String, required: true, trim: true },
    employeeCode: { type: String, required: true, index: true, trim: true, uppercase: true },
    vendorEmployeeCode: { type: String, trim: true },
    employeeName: { type: String, required: true, trim: true, default: 'Unknown Employee' },
    date: { type: String, required: true, index: true },
    inTime: { type: String, default: '--:--' },
    outTime: { type: String, default: '--:--' },
    workTime: { type: String, default: '00:00' },
    workMinutes: { type: Number, default: 0 },
    overTime: { type: String, default: '00:00' },
    breakTime: { type: String, default: '00:00' },
    lateIn: { type: String, default: '00:00' },
    earlyOut: { type: String, default: '00:00' },
    status: { type: String, required: true, default: 'A' },
    remark: { type: String, default: '--' },
    syncedAt: { type: Date, default: Date.now, index: true },
    recordKey: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true, collection: 'in_out_records', strict: false } // strict:false only so legacy columns survive until migration
);

InOutRecordSchema.index({ sourceId: 1, employeeCode: 1, date: 1 }, { unique: true });
InOutRecordSchema.index({ date: 1, sourceId: 1 });
InOutRecordSchema.index({ employeeCode: 1, date: 1 });

export const InOutModel = mongoose.model<InOutRecordDocument>('InOutRecord', InOutRecordSchema);
