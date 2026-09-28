import mongoose from 'mongoose';
import { ENV } from './env.js';

let isConnected = false;
let isConnecting = false;
let listenersAttached = false;

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
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB Disconnected. Driver will auto-reconnect...');
    isConnected = false;
    isConnecting = false;
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
    return false;
  }
};

export const getDbStatus = (): { connected: boolean; uri: string } => {
  return {
    connected: mongoose.connection.readyState === 1,
    uri: ENV.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@'),
  };
};

