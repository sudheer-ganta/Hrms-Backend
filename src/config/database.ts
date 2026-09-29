import mongoose from 'mongoose';
import { ENV } from './env.js';

let isConnected = false;
let isConnecting = false;
let listenersAttached = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const RECONNECT_INTERVAL_MS = 5000;

// Once the initial connection drops, mongoose's own driver-level reconnection
// isn't reliably recovering it in this environment (observed connections
// staying down indefinitely after a "secureConnect" timeout). This schedules
// an explicit application-level retry instead of waiting on that.
const scheduleReconnect = (): void => {
  if (reconnectTimer) return; // a retry is already pending
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (mongoose.connection.readyState === 1) return; // recovered on its own meanwhile
    console.log('🔄 Retrying MongoDB connection...');
    const ok = await connectDatabase();
    if (!ok) {
      scheduleReconnect();
    }
  }, RECONNECT_INTERVAL_MS);
};

const attachEventListeners = (): void => {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    isConnected = true;
    isConnecting = false;
    console.log('✅ MongoDB Connected to Atlas successfully');
  });

  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    isConnected = false;
    isConnecting = false;
    scheduleReconnect();
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB Disconnected. Scheduling automatic reconnect...');
    isConnected = false;
    isConnecting = false;
    scheduleReconnect();
  });

  mongoose.connection.on('reconnected', () => {
    console.log('🔄 MongoDB Reconnected to Atlas');
    isConnected = true;
    isConnecting = false;
  });
};

export const connectDatabase = async (): Promise<boolean> => {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return true;
  }

  if (isConnecting || mongoose.connection.readyState === 2) {
    return false;
  }

  attachEventListeners();
  isConnecting = true;

  try {
    mongoose.set('strictQuery', false);

    const conn = await mongoose.connect(ENV.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      maxPoolSize: 25,
      minPoolSize: 2,
      heartbeatFrequencyMS: 10000,
      family: 4, // Force IPv4 to eliminate Windows/ISP DNS resolution delays
      retryWrites: true,
      retryReads: true,
    });

    isConnected = true;
    isConnecting = false;
    console.log(`✅ MongoDB Connection Established: ${conn.connection.host}/${conn.connection.name}`);
    return true;
  } catch (error: any) {
    isConnecting = false;
    isConnected = false;
    console.error(`❌ MongoDB connection failed: ${error?.message || error}`);
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
