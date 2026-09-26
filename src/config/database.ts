import mongoose from 'mongoose';
import { ENV } from './env.js';

let isConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
const RECONNECT_INTERVAL_MS = 15000;

// The previous version of this file logged "Disconnected. Retrying..." but never
// actually scheduled a retry — once the initial connect failed or the connection
// dropped, it stayed down until the whole process was restarted, even after the
// network recovered. Confirmed this in practice: Atlas connectivity from this
// environment is intermittent, and a dropped connection otherwise required a
// manual server restart to recover, even though a fresh connect attempt right
// next to it succeeded immediately. This schedules real background retries.
const scheduleReconnect = (): void => {
  if (reconnectTimer) return; // a retry is already pending
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDatabase().catch(() => {
      // connectDatabase() already logs and reschedules on failure
    });
  }, RECONNECT_INTERVAL_MS);
};

export const connectDatabase = async (): Promise<boolean> => {
  if (isConnected) {
    return true;
  }

  try {
    mongoose.set('strictQuery', false);
    const conn = await mongoose.connect(ENV.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log(`✅ MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);

    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB Connection Error:', err.message);
      isConnected = false;
      scheduleReconnect();
    });

    mongoose.connection.on('disconnected', () => {
      console.warn(`⚠️ MongoDB Disconnected. Retrying every ${RECONNECT_INTERVAL_MS / 1000}s...`);
      isConnected = false;
      scheduleReconnect();
    });

    return true;
  } catch (error: any) {
    console.warn(`⚠️ MongoDB connection warning: ${error?.message || error}`);
    console.warn(`👉 The server will keep running and retry every ${RECONNECT_INTERVAL_MS / 1000}s in the background.`);
    scheduleReconnect();
    return false;
  }
};

export const getDbStatus = (): { connected: boolean; uri: string } => {
  return {
    connected: mongoose.connection.readyState === 1,
    uri: ENV.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@'),
  };
};
