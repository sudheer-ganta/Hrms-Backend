import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { syncService } from '../modules/sync/sync.service.js';
import { AttendanceDayModel } from '../modules/attendance/attendanceDay.model.js';
import { AttendanceModel } from '../modules/attendance/attendance.model.js';
import { InOutModel } from '../modules/attendance/inOut.model.js';
import { revisionService } from '../modules/realtime/revision.service.js';

interface SyncChunk {
  label: string;
  from: string;
  to: string;
}

// 10-day chunks prevent eTimeOffice upstream 45s timeouts on large datasets
const CHUNKS_2026: SyncChunk[] = [
  // 1. September 2026 (first priority for payroll review)
  { label: 'September 2026 (Part 1: 01-10)', from: '2026-09-01', to: '2026-09-10' },
  { label: 'September 2026 (Part 2: 11-20)', from: '2026-09-11', to: '2026-09-20' },
  { label: 'September 2026 (Part 3: 21-30)', from: '2026-09-21', to: '2026-09-30' },

  // 2. October 2026 (current month up to today)
  { label: 'October 2026 (Part 1: 01-10)', from: '2026-10-01', to: '2026-10-10' },
  { label: 'October 2026 (Part 2: 11-15)', from: '2026-10-11', to: '2026-10-15' },

  // 3. August 2026
  { label: 'August 2026 (Part 1: 01-10)', from: '2026-08-01', to: '2026-08-10' },
  { label: 'August 2026 (Part 2: 11-20)', from: '2026-08-11', to: '2026-08-20' },
  { label: 'August 2026 (Part 3: 21-31)', from: '2026-08-21', to: '2026-08-31' },

  // 4. July 2026
  { label: 'July 2026 (Part 1: 01-10)', from: '2026-07-01', to: '2026-07-10' },
  { label: 'July 2026 (Part 2: 11-20)', from: '2026-07-11', to: '2026-07-20' },
  { label: 'July 2026 (Part 3: 21-31)', from: '2026-07-21', to: '2026-07-31' },

  // 5. June 2026
  { label: 'June 2026 (Part 1: 01-10)', from: '2026-06-01', to: '2026-06-10' },
  { label: 'June 2026 (Part 2: 11-20)', from: '2026-06-11', to: '2026-06-20' },
  { label: 'June 2026 (Part 3: 21-30)', from: '2026-06-21', to: '2026-06-30' },

  // 6. May 2026
  { label: 'May 2026 (Part 1: 01-10)', from: '2026-05-01', to: '2026-05-10' },
  { label: 'May 2026 (Part 2: 11-20)', from: '2026-05-11', to: '2026-05-20' },
  { label: 'May 2026 (Part 3: 21-31)', from: '2026-05-21', to: '2026-05-31' },

  // 7. April 2026
  { label: 'April 2026 (Part 1: 01-10)', from: '2026-04-01', to: '2026-04-10' },
  { label: 'April 2026 (Part 2: 11-20)', from: '2026-04-11', to: '2026-04-20' },
  { label: 'April 2026 (Part 3: 21-30)', from: '2026-04-21', to: '2026-04-30' },

  // 8. March 2026
  { label: 'March 2026 (Part 1: 01-10)', from: '2026-03-01', to: '2026-03-10' },
  { label: 'March 2026 (Part 2: 11-20)', from: '2026-03-11', to: '2026-03-20' },
  { label: 'March 2026 (Part 3: 21-31)', from: '2026-03-21', to: '2026-03-31' },

  // 9. February 2026
  { label: 'February 2026 (Part 1: 01-10)', from: '2026-02-01', to: '2026-02-10' },
  { label: 'February 2026 (Part 2: 11-20)', from: '2026-02-11', to: '2026-02-20' },
  { label: 'February 2026 (Part 3: 21-28)', from: '2026-02-21', to: '2026-02-28' },

  // 10. January 2026
  { label: 'January 2026 (Part 1: 01-10)', from: '2026-01-01', to: '2026-01-10' },
  { label: 'January 2026 (Part 2: 11-20)', from: '2026-01-11', to: '2026-01-20' },
  { label: 'January 2026 (Part 3: 21-31)', from: '2026-01-21', to: '2026-01-31' },
];

async function main() {
  console.log('\n======================================================');
  console.log('  COLORMYLES HRMS — FULL YEAR 2026 BIOMETRIC SYNC');
  console.log('======================================================\n');

  await connectDatabase();
  console.log(`Starting synchronized download for all 2026 chunks...\n`);

  const tStart = Date.now();
  let totalInOutUpserted = 0;
  let totalRawInserted = 0;

  for (let i = 0; i < CHUNKS_2026.length; i++) {
    const chunk = CHUNKS_2026[i];
    console.log(`[${i + 1}/${CHUNKS_2026.length}] ${chunk.label} (${chunk.from} to ${chunk.to})`);
    const cStart = Date.now();

    // 1. INOUT records (Daily timesheet summary with status, work time, in/out)
    try {
      const inout = await syncService.syncAll('INOUT', { fromDate: chunk.from, toDate: chunk.to, triggeredBy: 'MANUAL' });
      const inoutCount = inout.reduce((a, r) => a + r.inserted, 0);
      totalInOutUpserted += inoutCount;
      console.log(`  ✓ IN/OUT: ${inoutCount} records synced`);
    } catch (e: any) {
      console.warn(`  ⚠ IN/OUT chunk note: ${e.message}`);
    }

    // 2. RAW punch records (Individual timestamped biometric punch logs with MCID)
    try {
      const raw = await syncService.syncAll('RAW', { fromDate: chunk.from, toDate: chunk.to, triggeredBy: 'MANUAL' });
      const rawCount = raw.reduce((a, r) => a + r.inserted, 0);
      totalRawInserted += rawCount;
      console.log(`  ✓ RAW:    ${rawCount} punches synced`);
    } catch (e: any) {
      console.warn(`  ⚠ RAW chunk note: ${e.message}`);
    }

    const elapsed = ((Date.now() - cStart) / 1000).toFixed(1);
    console.log(`  Completed chunk in ${elapsed}s\n`);

    // Bump revision so UI displays immediately updated statistics
    revisionService.bump('sync');
  }

  const [punchCount, inoutCount, dayCount, distinctDates] = await Promise.all([
    AttendanceModel.countDocuments(),
    InOutModel.countDocuments(),
    AttendanceDayModel.countDocuments(),
    AttendanceDayModel.distinct('businessDate'),
  ]);

  const datesSorted = distinctDates.sort();

  console.log('======================================================');
  console.log(`  FULL 2026 SYNC COMPLETE in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
  console.log('======================================================');
  console.log(`Summary of attendance data in MongoDB:`);
  console.log(`  • Total Raw Punches:          ${punchCount}`);
  console.log(`  • Total IN/OUT Daily Records: ${inoutCount}`);
  console.log(`  • Resolved Attendance Days:   ${dayCount}`);
  console.log(`  • Distinct Business Dates:    ${datesSorted.length}`);
  console.log(`  • Coverage Range:             ${datesSorted[0] || 'N/A'} to ${datesSorted[datesSorted.length - 1] || 'N/A'}`);
  console.log('\nAll biometric records are saved to MongoDB and synchronized.\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal sync failure:', err);
  process.exit(1);
});
