import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from server/.env or current working directory
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface SourceCredential {
  id: string;
  name: string;
  displayName: string;
  corporateId: string;
  username: string;
  password: string;
  enabled: boolean;
}

export const ENV = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/etimehr',
  ETIMESOURCE_BASE_URL: (process.env.ETIMESOURCE_BASE_URL || 'https://api.etimeoffice.com/api').replace(/\/+$/, ''),
  
  // 3 Configured Locations
  SOURCES: {
    office: {
      id: 'office',
      name: 'Office',
      displayName: 'ColorMyles',
      corporateId: process.env.ETIMESOURCE_OFFICE_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_OFFICE_USERNAME || '',
      password: process.env.ETIMESOURCE_OFFICE_PASSWORD || '',
      enabled: true,
    },
    budigere: {
      id: 'budigere',
      name: 'Budigere',
      displayName: 'Budigere',
      corporateId: process.env.ETIMESOURCE_BUDIGERE_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_BUDIGERE_USERNAME || '',
      password: process.env.ETIMESOURCE_BUDIGERE_PASSWORD || '',
      enabled: true,
    },
    bidarahalli: {
      id: 'bidarahalli',
      name: 'Bidarahalli',
      displayName: 'Bidarahalli',
      corporateId: process.env.ETIMESOURCE_BIDARAHALLI_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_BIDARAHALLI_USERNAME || '',
      password: process.env.ETIMESOURCE_BIDARAHALLI_PASSWORD || '',
      enabled: true,
    }
  } as Record<string, SourceCredential>
};

export const getSourceById = (sourceId: string): SourceCredential | null => {
  const normalized = sourceId.toLowerCase().trim();
  return ENV.SOURCES[normalized] || null;
};

export const getAllSources = (): SourceCredential[] => {
  return Object.values(ENV.SOURCES);
};
