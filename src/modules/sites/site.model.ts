import mongoose, { Schema, Document } from 'mongoose';

export interface ISite {
  siteId: string;
  name: string;
  displayName: string;
  active: boolean;
  geo?: { lat: number; lng: number; radiusM: number };
}

export interface SiteDocument extends ISite, Document {}

const SiteSchema = new Schema<SiteDocument>(
  {
    siteId: { type: String, required: true, unique: true, lowercase: true, trim: true, immutable: true },
    name: { type: String, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    geo: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
      radiusM: { type: Number, min: 10, max: 50000 },
    },
  },
  { timestamps: true, collection: 'sites' }
);

export const SiteModel = mongoose.model<SiteDocument>('Site', SiteSchema);
