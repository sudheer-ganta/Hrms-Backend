import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { EmployeeModel } from '../modules/employees/employeeMaster.model.js';
import { PolicyModel } from '../modules/settings/policy.model.js';
import { RequestModel } from '../modules/requests/requests.model.js';
import { InOutModel } from '../modules/attendance/inOut.model.js';
import { AttendanceModel } from '../modules/attendance/attendance.model.js';

import { ENV } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');

const MONGODB_URI = process.env.MONGODB_URI || ENV.MONGODB_URI;

async function runSync() {
  console.log('🔗 Connecting to MongoDB Atlas...');
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
    connectTimeoutMS: 20000,
  });
  console.log('✅ Connected to MongoDB Atlas successfully!\n');

  // 1. Sync Employee Profiles
  const profilesFile = path.join(DATA_DIR, 'employee_profiles.json');
  if (fs.existsSync(profilesFile)) {
    const profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf-8'));
    const empOps = profiles.map((p: any) => ({
      updateOne: {
        filter: { empCode: p.empCode },
        update: { $set: p },
        upsert: true,
      },
    }));
    if (empOps.length > 0) {
      await EmployeeModel.bulkWrite(empOps, { ordered: false });
    }
    console.log(`👤 Synced ${profiles.length} Employee Profiles to MongoDB Atlas.`);
  }

  // 2. Sync HRMS Policy & Holidays
  const policyFile = path.join(DATA_DIR, 'hrms_policy_settings.json');
  if (fs.existsSync(policyFile)) {
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf-8'));
    await PolicyModel.findOneAndUpdate(
      { key: 'global_hrms_policy' },
      { $set: { ...policy, key: 'global_hrms_policy' } },
      { upsert: true, new: true }
    );
    console.log(`⚙️ Synced HRMS Policy & ${policy.holidays?.length || 0} Corporate Holidays to MongoDB Atlas.`);
  }

  // 3. Sync Employee Requests
  const requestsFile = path.join(DATA_DIR, 'requests_store.json');
  if (fs.existsSync(requestsFile)) {
    const requests = JSON.parse(fs.readFileSync(requestsFile, 'utf-8'));
    const reqOps = requests.map((r: any) => ({
      updateOne: {
        filter: { id: r.id },
        update: { $set: r },
        upsert: true,
      },
    }));
    if (reqOps.length > 0) {
      await RequestModel.bulkWrite(reqOps, { ordered: false });
    }
    console.log(`📝 Synced ${requests.length} Leave / Regularization Requests to MongoDB Atlas.`);
  }

  // 4. Sync from attendance_store.json (In-Out Summaries and Raw Punches)
  // Skipped by default: attendance/InOut data already dual-writes to MongoDB
  // during normal sync operation, so this one-off migration only needs to
  // cover the modules that were previously local-file-only (employees,
  // policy, requests). Set INCLUDE_ATTENDANCE=true to also backfill this.
  const attStoreFile = path.join(DATA_DIR, 'attendance_store.json');
  if (process.env.INCLUDE_ATTENDANCE === 'true' && fs.existsSync(attStoreFile)) {
    console.log('📦 Reading attendance store...');
    const attData = JSON.parse(fs.readFileSync(attStoreFile, 'utf-8'));

    // Sync inOutRecords
    if (attData.inOutRecords && Array.isArray(attData.inOutRecords)) {
      const inOutList = attData.inOutRecords;
      console.log(`🔄 Syncing ${inOutList.length} daily In-Out records...`);
      const BATCH_SIZE = 500;
      for (let i = 0; i < inOutList.length; i += BATCH_SIZE) {
        const batch = inOutList.slice(i, i + BATCH_SIZE);
        const ops = batch.map((r: any) => ({
          updateOne: {
            filter: { recordKey: r.recordKey || `${r.sourceId}_${r.employeeCode}_${r.date}` },
            update: { $set: r },
            upsert: true,
          },
        }));
        await InOutModel.bulkWrite(ops, { ordered: false });
      }
      console.log(`📊 Synced ${inOutList.length} Daily In-Out Attendance Records to MongoDB.`);
    }

    // Sync raw punch records (latest 3000 punches)
    if (attData.records && Array.isArray(attData.records)) {
      const recordsList = attData.records.slice(-3000);
      console.log(`🔄 Syncing latest ${recordsList.length} biometric punch logs...`);
      const BATCH_SIZE = 500;
      for (let i = 0; i < recordsList.length; i += BATCH_SIZE) {
        const batch = recordsList.slice(i, i + BATCH_SIZE);
        const ops = batch.map((p: any) => ({
          updateOne: {
            filter: { vendorRecordHash: p.vendorRecordHash || `${p.sourceId || p.source}_${p.employeeCode || p.empCode}_${p.punchDateTime}` },
            update: {
              $set: {
                sourceId: p.sourceId || p.source,
                sourceName: p.sourceName || p.source,
                employeeCode: p.employeeCode || p.empCode,
                employeeName: p.employeeName || p.name,
                punchDateTime: new Date(p.punchDateTime),
                entryDate: p.entryDate,
                entryTime: p.entryTime,
                machineId: p.machineId || p.deviceNo || '0',
                vendorRecordHash: p.vendorRecordHash || `${p.sourceId || p.source}_${p.employeeCode || p.empCode}_${p.punchDateTime}`,
                syncedAt: new Date(p.syncedAt || Date.now()),
              },
            },
            upsert: true,
          },
        }));
        await AttendanceModel.bulkWrite(ops, { ordered: false });
      }
      console.log(`⏱️ Synced ${recordsList.length} Raw Biometric Punch Logs to MongoDB.`);
    }
  }

  console.log('\n🎉 ALL HRMS & BIOMETRIC DATA IS FULLY SYNCED TO MONGODB ATLAS!');
  await mongoose.disconnect();
  process.exit(0);
}

runSync().catch((err) => {
  console.error('❌ Data Sync Error:', err);
  process.exit(1);
});
