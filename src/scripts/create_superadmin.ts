/**
 * Operator tool: create or update a Super Admin account.
 *
 *   $env:ADMIN_EMAIL="colormyles@gmail.com"; $env:ADMIN_PASSWORD="colormyles@11"; $env:ADMIN_NAME="ColorMyles Super Admin"; npx tsx src/scripts/create_superadmin.ts
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ENV } from '../config/env.js';
import { UserModel } from '../modules/auth/user.model.js';
import { assertStrongPassword } from '../utils/password.js';

async function main() {
  const email = (process.env.ADMIN_EMAIL || 'colormyles@gmail.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'colormyles@11';
  const name = (process.env.ADMIN_NAME || 'ColorMyles Super Admin').trim();

  if (!email || !password) throw new Error('Email and password are required.');
  assertStrongPassword(password, email);

  console.log('Connecting to database...');
  await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  let user = await UserModel.findOne({ email });
  if (user) {
    console.log(`User ${email} already exists. Updating role to SUPER_ADMIN, resetting password, and activating...`);
    user.passwordHash = await bcrypt.hash(password, 12);
    user.role = 'SUPER_ADMIN';
    user.name = name;
    user.status = 'active';
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    console.log(`Super Admin user ${email} updated successfully.`);
  } else {
    console.log(`Creating new SUPER_ADMIN user: ${email}...`);
    user = await UserModel.create({
      email,
      passwordHash: await bcrypt.hash(password, 12),
      name,
      role: 'SUPER_ADMIN',
      status: 'active',
      tokenVersion: 0,
    });
    console.log(`Super Admin user ${email} created successfully with ID: ${user._id}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
