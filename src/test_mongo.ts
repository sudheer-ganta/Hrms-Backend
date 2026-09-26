import mongoose from 'mongoose';
import { ENV } from './config/env.js';

const uri = process.env.MONGODB_URI || ENV.MONGODB_URI;

console.log('Testing connection to MongoDB Atlas...');

async function run() {
  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ Successfully connected to MongoDB Atlas!');
    console.log('Host:', conn.connection.host);
    console.log('Database Name:', conn.connection.name);
    console.log('Connection State:', conn.connection.readyState);
    await mongoose.disconnect();
    console.log('Disconnected cleanly.');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ MongoDB Atlas Connection Error:', err.message);
    process.exit(1);
  }
}

run();
