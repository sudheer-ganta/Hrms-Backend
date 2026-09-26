import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InOutModel } from '../modules/attendance/inOut.model.js';

import { ENV } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');

const MONGODB_URI = process.env.MONGODB_URI || ENV.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB Atlas');

  const file = path.join(DATA_DIR, 'attendance_store.json');
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data.inOutRecords && Array.isArray(data.inOutRecords)) {
      const ops = data.inOutRecords.map((r: any) => ({
        updateOne: {
          filter: { recordKey: r.recordKey || `${r.sourceId}_${r.employeeCode}_${r.date}` },
          update: { $set: r },
          upsert: true,
        },
      }));
      const res = await InOutModel.bulkWrite(ops, { ordered: false });
      console.log(`Synced ${data.inOutRecords.length} in_out_records to MongoDB Atlas!`);
    }
  }
  await mongoose.disconnect();
}

main().catch(console.error);
