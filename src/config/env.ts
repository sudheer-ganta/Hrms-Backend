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

/**
 * A vendor (e-TimeOffice) login. Credentials live ONLY in the environment, never in
 * the database or API responses. `siteId` links the account to a canonical Site.
 */
export interface SourceCredential {
  id: string;          // accountId (also the vendor "source id" used in sync/API)
  siteId: string;      // canonical Site this account belongs to
  name: string;
  displayName: string;
  corporateId: string;
  username: string;
  password: string;
  enabled: boolean;
}

const bool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

const NODE_ENV = process.env.NODE_ENV || 'development';

export const ENV = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  NODE_ENV,
  IS_PRODUCTION: NODE_ENV === 'production',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/etimehr',
  ETIMESOURCE_BASE_URL: (process.env.ETIMESOURCE_BASE_URL || 'https://api.etimeoffice.com/api').replace(/\/+$/, ''),

  // --- Auth ---
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',

  // Optional first-run bootstrap of the very first SUPER_ADMIN. Used only when NO
  // super admin exists yet. Remove these variables after the first start.
  SEED_SUPERADMIN_EMAIL: (process.env.SEED_SUPERADMIN_EMAIL || '').trim().toLowerCase(),
  SEED_SUPERADMIN_PASSWORD: process.env.SEED_SUPERADMIN_PASSWORD || '',
  SEED_SUPERADMIN_NAME: process.env.SEED_SUPERADMIN_NAME || 'Super Admin',

  // Comma-separated browser origins allowed to call the API cross-origin.
  // The Vercel deployment proxies /api (same-origin), so production can leave this empty.
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // How often each instance re-reads the policy from MongoDB (the cross-instance convergence bound).
  POLICY_REFRESH_MS: Math.max(500, parseInt(process.env.POLICY_REFRESH_MS || '30000', 10) || 30000),

  // Only ONE instance in a deployment should run the background sync.
  SCHEDULER_ENABLED: bool(process.env.SCHEDULER_ENABLED, true),

  // 3 configured vendor accounts, each mapped to a canonical site.
  SOURCES: {
    office: {
      id: 'office',
      siteId: 'office',
      name: 'Office',
      displayName: 'ColorMyles',
      corporateId: process.env.ETIMESOURCE_OFFICE_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_OFFICE_USERNAME || '',
      password: process.env.ETIMESOURCE_OFFICE_PASSWORD || '',
      enabled: true,
    },
    budigere: {
      id: 'budigere',
      siteId: 'budigere',
      name: 'Budigere',
      displayName: 'Budigere',
      corporateId: process.env.ETIMESOURCE_BUDIGERE_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_BUDIGERE_USERNAME || '',
      password: process.env.ETIMESOURCE_BUDIGERE_PASSWORD || '',
      enabled: true,
    },
    bidarahalli: {
      id: 'bidarahalli',
      siteId: 'bidarahalli',
      name: 'Bidarahalli',
      displayName: 'Bidarahalli',
      corporateId: process.env.ETIMESOURCE_BIDARAHALLI_CORPORATE_ID || '',
      username: process.env.ETIMESOURCE_BIDARAHALLI_USERNAME || '',
      password: process.env.ETIMESOURCE_BIDARAHALLI_PASSWORD || '',
      enabled: true,
    },
  } as Record<string, SourceCredential>,
};

/** Fails fast at startup on unsafe configuration. */
export const assertEnv = (): void => {
  if (!ENV.JWT_SECRET || ENV.JWT_SECRET.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to a random string of at least 32 characters. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
};

export const getSourceById = (sourceId: string): SourceCredential | null => {
  const normalized = String(sourceId || '').toLowerCase().trim();
  return ENV.SOURCES[normalized] || null;
};

export const getAllSources = (): SourceCredential[] => {
  return Object.values(ENV.SOURCES);
};
