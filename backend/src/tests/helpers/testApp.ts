/**
 * testApp.ts
 *
 * Creates a fully-initialized Express application backed by an **in-memory
 * SQLite database** (DB_PATH=:memory: is set by vitest.config.ts).
 *
 * Usage:
 *   import { createTestApp } from './helpers/testApp';
 *   const app = createTestApp();
 *   await request(app).get('/api/health').expect(200);
 */

import { initializeDatabase } from '../../db/database';
import app from '../../app';

let initialized = false;

/**
 * Ensures the database is initialized exactly once per module scope.
 * Because vitest uses `isolate: true`, each test file gets a fresh module
 * registry and therefore a fresh in-memory database.
 */
export function createTestApp() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
  return app;
}

/**
 * Re-exported for tests that need to directly access the DB
 * (e.g. to insert seed data or verify DB state).
 */
export { getDatabase } from '../../db/database';
