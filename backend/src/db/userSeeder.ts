/**
 * userSeeder.ts
 *
 * Seeds three demo users (one per RBAC role) into the database on first boot.
 * Idempotent: guarded by the _seed_flags table.
 *
 * Demo credentials (development only — never use in production):
 *   admin@demo.com    / demo-password123  → role: admin
 *   analyst@demo.com  / demo-password123  → role: analyst
 *   viewer@demo.com   / demo-password123  → role: viewer
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from './database';
import { logger } from '../utils/logger';

function hashPassword(password: string): string {
  const salt = process.env['PASSWORD_SALT'] || 'mcp-dev-salt';
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

export function seedDemoUsers(tenantId: string): void {
  const db = getDatabase();

  const already = db
    .prepare("SELECT key FROM _seed_flags WHERE key = 'demo_users_v1'")
    .get();
  if (already) {
    logger.info('ℹ️  Demo user seed already applied — skipping');
    return;
  }

  const DEMO_PASSWORD = 'demo-password123';

  const demoUsers = [
    { email: 'admin@demo.com',   role: 'admin',   label: 'Admin' },
    { email: 'analyst@demo.com', role: 'analyst', label: 'Analyst' },
    { email: 'viewer@demo.com',  role: 'viewer',  label: 'Viewer' },
  ];

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seedAll = db.transaction(() => {
    for (const u of demoUsers) {
      insertUser.run(uuidv4(), tenantId, u.email, hashPassword(DEMO_PASSWORD), u.role);
      logger.info(`👤 Seeded ${u.label}: ${u.email}`);
    }
    db.prepare("INSERT INTO _seed_flags (key) VALUES ('demo_users_v1')").run();
  });

  seedAll();
  logger.info('🌱 Demo users seeded (password: demo-password123)');
}
