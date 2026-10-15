import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { SyncService } from '../modules/sync/sync.service.js';
import { istToday } from '../utils/istTime.js';

async function main() {
  console.log('\n=== RE-SYNCING ATTENDANCE & BIOMETRICS FROM ETIMEOFFICE ===\n');
  let ok = await connectDatabase();
  while (!ok) {
    console.log('Waiting for MongoDB connection...');
    await new Promise((r) => setTimeout(r, 2000));
    ok = mongoose.connection.readyState === 1 || await connectDatabase();
  }
  console.log('Connected to MongoDB.');

  const syncService = new SyncService();
  const today = istToday();
  const year = today.slice(0, 4);
  const month = today.slice(5, 7);
  const fromDate = `${year}-${month}-01`;
  const toDate = today;

  console.log(`Syncing IN/OUT punch data from ${fromDate} to ${toDate}...`);
  const inOutResults = await syncService.syncAll('INOUT', { fromDate, toDate, triggeredBy: 'MANUAL' });
  console.log('INOUT Sync Results:', JSON.stringify(inOutResults, null, 2));

  console.log(`Syncing RAW punch logs from ${fromDate} to ${toDate}...`);
  const rawResults = await syncService.syncAll('RAW', { fromDate, toDate, triggeredBy: 'MANUAL' });
  console.log('RAW Sync Results:', JSON.stringify(rawResults, null, 2));

  console.log('\n✓ Sync complete! Attendance data has been restored.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
