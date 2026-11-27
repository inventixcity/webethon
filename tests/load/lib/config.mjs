import { randomUUID } from 'node:crypto';

// Environment and shared constants for the load suite. Nothing here prints secrets.
const trimSlash = value => value.replace(/\/+$/, '');

export const API_URL = trimSlash(process.env.API_URL || 'http://127.0.0.1:8080');
export const MAILPIT_URL = trimSlash(process.env.MAILPIT_URL || 'http://localhost:8025');
export const PROXY_SECRET = process.env.PROXY_SECRET || '';
export const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'wa-api-dev';

// Password for the accounts this suite creates. These are disposable test accounts only.
export const PASSWORD = process.env.LOAD_PASSWORD || 'Correct horse battery 57!';

// Identifies this run in names of per-run accounts, resources and notes.
export const RUN_ID = (process.env.LOAD_RUN_ID || randomUUID().slice(0, 8)).toLowerCase();

// Shared, stable pool of verified accounts reused across runs (sign-in instead of signup).
// Index POOL_SIZE - 1 is reserved as the booking resource owner.
export const POOL_SIZE = 101;
export const BOOKING_OWNER_INDEX = POOL_SIZE - 1;
export const poolEmail = index => `loadtest-pool-${String(index).padStart(3, '0')}@example.test`;
export const stormEmail = index => `loadtest-storm-${RUN_ID}-${String(index).padStart(3, '0')}@example.test`;
