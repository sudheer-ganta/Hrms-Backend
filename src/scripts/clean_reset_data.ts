/**
 * Clean & Reset Script:
 * Safely purges transient/test attendance, sync logs, and payroll records to allow a fresh resync & recalculation.
 *
 * PRESERVED COLLECTIONS:
 *  - users (Admin / HR / Employee accounts)
 *  - employee_profiles (Employee Master & Salary structure)
 *  - employee_source_mappings (Device mapping)
 *  - sites (Geofence & office locations)
 *  - policies (Global HRMS Attendance & Overtime Policy)
 *
 * TARGETED FOR PURGE:
 *  - attendance_days
 *  - attendance_records (raw biometric staging)
 *  - in_out_records (raw punches)
 *  - attendance_adjustments
 *  - payroll_runs
 *  - payroll_snapshots
 *  - payroll_adjustments
 *  - payroll_adjustment_audits
 *  - sync_logs
 *  - scheduler_leases
 *  - employee_requests (optional, enabled by default)
 *
 * USAGE:
 *  Dry-run:  npx tsx src/scripts/clean_reset_data.ts
 *  Apply:    npx tsx src/scripts/clean_reset_data.ts --apply
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`\n=== HRMS DATA CLEANUP & RESET (${APPLY ? 'APPLY MODE' : 'DRY RUN'}) ===\n`);

  await connectDatabase();
  const db = mongoose.connection.db;
  if (!db) {
    console.error('Database connection failed.');
    process.exit(1);
  }

  const collectionsToClean = [
    { name: 'attendance_days', label: 'Resolved Attendance Days' },
    { name: 'attendance_records', label: 'Raw Attendance Records' },
    { name: 'in_out_records', label: 'Raw In/Out Punches' },
    { name: 'attendance_adjustments', label: 'Attendance Adjustments' },
    { name: 'payroll_runs', label: 'Payroll Runs' },
    { name: 'payroll_snapshots', label: 'Payroll Snapshots' },
    { name: 'payroll_adjustments', label: 'Payroll Adjustments' },
    { name: 'payroll_adjustment_audits', label: 'Payroll Adjustment Audits' },
    { name: 'sync_logs', label: 'Biometric Sync Logs' },
    { name: 'scheduler_leases', label: 'Scheduler Leases' },
    { name: 'employee_requests', label: 'Employee Requests' },
  ];

  console.log('Counting existing documents in target collections:');
  const counts: Record<string, number> = {};

  for (const col of collectionsToClean) {
    try {
      const count = await db.collection(col.name).countDocuments();
      counts[col.name] = count;
      console.log(`  - ${col.label} (${col.name}): ${count} documents`);
    } catch {
      counts[col.name] = 0;
      console.log(`  - ${col.label} (${col.name}): collection does not exist (0 documents)`);
    }
  }

  const totalDocs = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nTotal transient/test records found: ${totalDocs}`);

  if (!APPLY) {
    console.log('\n[DRY RUN] No records were deleted.');
    console.log('To execute the cleanup, run with the --apply flag:\n  npx tsx src/scripts/clean_reset_data.ts --apply\n');
    process.exit(0);
  }

  console.log('\n[APPLY] Deleting targeted documents...');
  for (const col of collectionsToClean) {
    if (counts[col.name] > 0) {
      const res = await db.collection(col.name).deleteMany({});
      console.log(`  ✓ Cleared ${res.deletedCount} documents from ${col.name}`);
    }
  }

  console.log('\n✓ Cleanup complete! Database is now reset for fresh sync and recalculation.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error during cleanup:', err);
  process.exit(1);
});
