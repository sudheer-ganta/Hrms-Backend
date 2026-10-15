import fs from 'fs';
import { spawnSync } from 'child_process';
import './src/tests/helpers.js'; // sets MONGOMS_SYSTEM_BINARY
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const file = fs.existsSync('data/attendance_store.json') ? 'data/attendance_store.json' : '/tmp/legacy_store.json';
const store = JSON.parse(fs.readFileSync(file, 'utf-8'));
const profFile = fs.existsSync('data/employee_profiles.migrated.bak.json') ? 'data/employee_profiles.migrated.bak.json' : null;
const mongod = await MongoMemoryServer.create({ instance: { args: ['--wiredTigerCacheSizeGB', '0.5'] } });
const uri = mongod.getUri('legacy');
const client = await MongoClient.connect(uri);
const d = client.db('legacy');
const clean = (arr: any[]) => arr.map((x) => { const { _id, ...r } = x; return r; });
const ins = async (c: string, arr: any[]) => { for (let i = 0; i < arr.length; i += 400) { await d.collection(c).insertMany(arr.slice(i, i + 400), { ordered: false }).catch(() => undefined); await new Promise((r) => setTimeout(r, 40)); } };
await ins('in_out_records', clean(store.inOutRecords).map((r: any, i: number) => ({ ...r, recordKey: r.recordKey || `partial-${i}` })));
await ins('attendance_records', clean(store.records).map((r: any) => ({ ...r, syncedAt: new Date(r.syncedAt || Date.now()), punchDateTime: new Date(r.punchDateTime) })));
if (profFile) await ins('employees', clean(JSON.parse(fs.readFileSync(profFile, 'utf-8'))));
await d.collection('policies').insertOne({ key: 'global_hrms_policy', weeklyOffDays: ['Sunday'], holidays: [] });
console.log('seeded legacy copy:', JSON.stringify({ inOut: await d.collection('in_out_records').countDocuments(), raw: await d.collection('attendance_records').countDocuments(), employees: await d.collection('employees').countDocuments() }));

const run = (label: string, extra: Record<string, string>, ...flags: string[]) => {
  console.log(`\n######## ${label}`);
  const t = Date.now();
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/migrate_canonical.ts', ...flags], {
    env: { ...process.env, MIGRATE_MONGODB_URI: uri, JWT_SECRET: 'x'.repeat(48), ...extra }, stdio: ['ignore', 'inherit', 'inherit'], timeout: 900_000,
  });
  console.log(`######## ${label}: exit ${r.status} in ${Math.round((Date.now() - t) / 1000)}s`);
  return r.status;
};
const counts = async () => ({ days: await d.collection('attendance_days').countDocuments(), raw: await d.collection('attendance_records').countDocuments(), inOut: await d.collection('in_out_records').countDocuments(), archivedInOut: await d.collection('in_out_records_archive').countDocuments() });

run('0. DRY RUN (must write nothing)', {});
console.log('after dry run:', JSON.stringify(await counts()), 'checkpoint:', JSON.stringify(await d.collection('migration_state').findOne({})));
run('1. APPLY, simulated crash after 5 batches', { MIGRATE_FAIL_AFTER_BATCHES: '5' }, '--apply', '--backup-confirmed');
console.log('after crash:', JSON.stringify(await counts()), 'checkpoint:', JSON.stringify(await d.collection('migration_state').findOne({})));
run('2. APPLY again (must resume)', {}, '--apply', '--backup-confirmed');
const afterResume = await counts();
console.log('after resume:', JSON.stringify(afterResume));
run('3. APPLY a third time (must change nothing)', {}, '--apply', '--backup-confirmed');
const afterThird = await counts();
console.log('after third run:', JSON.stringify(afterThird), 'identical to previous:', JSON.stringify(afterThird) === JSON.stringify(afterResume));
await client.close();
await mongod.stop();
process.exit(0);
