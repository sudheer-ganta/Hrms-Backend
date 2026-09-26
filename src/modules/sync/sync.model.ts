import mongoose, { Schema } from 'mongoose';
import { SyncLogDocument } from './sync.types.js';

const SyncLogSchema = new Schema<SyncLogDocument>(
  {
    sourceId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    sourceName: {
      type: String,
      required: true,
      trim: true,
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    completedAt: {
      type: Date,
    },
    status: {
      type: String,
      required: true,
      enum: ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'],
      default: 'RUNNING',
      index: true,
    },
    recordsFetched: {
      type: Number,
      default: 0,
    },
    recordsInserted: {
      type: Number,
      default: 0,
    },
    recordsSkipped: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    requestFromDate: {
      type: String,
    },
    requestToDate: {
      type: String,
    },
    triggeredBy: {
      type: String,
      enum: ['MANUAL', 'SCHEDULED'],
      default: 'MANUAL',
    },
    syncType: {
      type: String,
      enum: ['RAW', 'INOUT'],
      default: 'RAW',
    },
  },
  {
    timestamps: true,
    collection: 'sync_logs',
  }
);

SyncLogSchema.index({ sourceId: 1, startedAt: -1 });

export const SyncLogModel = mongoose.model<SyncLogDocument>(
  'SyncLog',
  SyncLogSchema
);
