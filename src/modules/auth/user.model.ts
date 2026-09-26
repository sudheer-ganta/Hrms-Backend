import mongoose, { Schema, Document } from 'mongoose';
import { IUser, UserRole } from './auth.types.js';

export interface UserDocument extends Document {
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  empCode?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      required: true,
      enum: ['SUPER_ADMIN', 'FOUNDER', 'EMPLOYEE'],
      default: 'EMPLOYEE',
      index: true,
    },
    empCode: {
      type: String,
      trim: true,
      index: true,
      sparse: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'users',
  }
);

export const UserModel = mongoose.model<UserDocument>('User', UserSchema);
