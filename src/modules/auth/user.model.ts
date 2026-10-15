import mongoose, { Schema, Document } from 'mongoose';
import { UserRole, USER_ROLES } from './auth.types.js';

export interface UserDocument extends Document {
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  empCode?: string;
  status: 'active' | 'inactive';
  /** Incremented to revoke every token issued before (logout, password reset, deactivation). */
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDocument>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: USER_ROLES, default: 'EMPLOYEE', index: true },
    // Canonical employee identity key (normalizeEmpCode): trimmed + UPPERCASE.
    empCode: { type: String, trim: true, uppercase: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'users' }
);

// One login per employee code.
UserSchema.index({ empCode: 1 }, { unique: true, sparse: true });

export const UserModel = mongoose.model<UserDocument>('User', UserSchema);
