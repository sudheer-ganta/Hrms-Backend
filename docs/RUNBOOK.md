# Rollout runbook

Do these **in order**. Nothing here has been run against your production database.

## 0. Immediately (security)

1. **Rotate the Super Admin password.** The old password was in `Login.tsx`, in the built bundle, in the
   backend seed, and in git history. Treat it as public.
   ```powershell
   $env:RESET_EMAIL="gmsaisudheer@gmail.com"; $env:RESET_PASSWORD="<new long password with letters and digits>"; npm run reset-password
   ```
   (Use the real super-admin email. This also revokes the account's existing sessions.)
2. **Rotate `JWT_SECRET`** (any value ≥ 32 chars). All existing sessions end. Set it in Render.
3. **Rotate the e-TimeOffice passwords** for the three accounts if the repository was ever shared or public, and
   update the Render environment.
4. Remove any `SEED_SUPERADMIN_*` variables after the first start (they are only a bootstrap and do nothing once a
   super admin exists).
5. Set `NODE_ENV=production` on Render. Leave `CORS_ORIGINS` empty if the app is reached only through the Vercel
   `/api` rewrite.

## 1. Remove personal data from git

The files are already removed from the git index and ignored (`data/`). They are still in **history**. To purge:

```bash
# on a fresh clone, with git-filter-repo installed
git filter-repo --path data/ --invert-paths
git push --force --all        # rewrites remote history: coordinate with everyone who cloned
```
After that, ask anyone with an old clone to re-clone. If the repository was ever public, assume the data is
compromised regardless. Do **not** delete anything from MongoDB.

## 2. Database migration (before switching reads)

1. **Back up**: Atlas snapshot or `mongodump --uri "$MONGODB_URI"`.
2. Dry run (writes nothing): `npm run migrate:canonical`
3. Review the report. Typical lines: duplicate raw punches, corrupted partial records, ESS rows moved out of the
   vendor staging table, requests converted to adjustments.
4. Apply: `npm run migrate:canonical -- --apply --backup-confirmed`
   * Nothing is deleted: removed rows go to `*_archive` collections with a reason.
   * Safe to re-run.
5. Compare a closed historical month: `GET /api/attendance/days` summary and `GET /api/payroll/all?month=YYYY-MM`
   (live) against the month's old payroll export before the first close in the new system.
6. Closed months keep their old snapshot; the migration wraps it as version 1.

### 2b. One legacy index must be replaced

`users.empCode` used to be a plain (non-unique) sparse index named `empCode_1`; it is now UNIQUE. MongoDB will not
change an existing index's options, so drop the old one once and let the backend recreate it on start:
```js
db.users.dropIndex("empCode_1")
```
(If two users share an employee code, the migration prints a warning; fix those first, otherwise the unique index
cannot be built.)

## 3. Deploy order

1. Deploy the **backend** (it creates the new indexes on start). It answers 503 for business endpoints until
   MongoDB is reachable and returns the new error contract.
2. Deploy the **frontend** immediately after (contracts changed: `/attendance/days`, canonical statuses,
   error bodies). An old frontend against the new backend will not work, and vice versa.
3. Run one manual sync (Settings → Sync) and open Attendance, Dashboard and Payroll to confirm.

## 4. Decisions only the business can make

* Half-day pay: `PAYROLL_RULES.halfDayLopFraction` (currently 0 = paid in full).
* Professional Tax: `PAYROLL_RULES.ptDeductedFromNet` (currently false = employer-borne).
* ESIC eligibility is evaluated on CTC (as before); statutory ESIC uses gross wages.
* Site geofences: set latitude / longitude / radius per site in Settings → Biometric Hardware. Until a site has a
  location, web punches for it are not location-checked.

## 5. Tests

```
cd Hrms-Backend   && npm test        # unit + real-MongoDB integration + migration
cd Hrms-Frontend- && npm test        # helpers + cross-repo contract
```
Integration tests start a throw-away `mongod` (set `MONGOMS_SYSTEM_BINARY` if it cannot be downloaded) and never
touch Atlas.
