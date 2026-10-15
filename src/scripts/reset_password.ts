/**
 * Operator tool: set a new password for a user (used to rotate the exposed Super Admin credential).
 *
 *   $env:RESET_EMAIL="you@company.com"; $env:RESET_PASSWORD="a-long-new-password-1"; npm run reset-password
 *
 * The password is taken from the environment (never from argv, so it stays out of shell history
 * listings of process arguments) and is validated by the normal password policy. All existing
 * sessions of the user are revoked.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ENV } from '../config/env.js';
import { UserModel } from '../modules/auth/user.model.js';
import { assertStrongPassword } from '../utils/password.js';

async function main() {
  const email = (process.env.RESET_EMAIL || '').trim().toLowerCase();
  const password = process.env.RESET_PASSWORD || '';
  if (!email || !password) throw new Error('Set RESET_EMAIL and RESET_PASSWORD in the environment.');
  assertStrongPassword(password, email);
  await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const user = await UserModel.findOne({ email });
  if (!user) throw new Error(`No user with email ${email}.`);
  user.passwordHash = await bcrypt.hash(password, 12);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  console.log(`Password updated for ${email}; all previous sessions are revoked.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
