/**
 * fixtures.ts
 *
 * Inserts deterministic test tenants, users, and MCP servers into the
 * in-memory SQLite database so every test suite can start from a clean,
 * known state.
 *
 * Two completely isolated tenants are seeded:
 *   - Tenant A (slug: "tenant-a")  → adminA, analystA, viewerA
 *   - Tenant B (slug: "tenant-b")  → adminB
 *
 * Password for all users: "TestPass123!" hashed with PASSWORD_SALT="test-salt"
 * (matching vitest.config.ts env).
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from './testApp';
import { signToken } from '../../utils/jwt';
import { encrypt } from '../../services/vaultService';

// ── Password hashing matching auth.routes.ts ──────────────────────────────────

function hashPassword(password: string): string {
  const salt = process.env['PASSWORD_SALT'] ?? 'mcp-salt';
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

const TEST_PASSWORD = 'TestPass123!';

// ── Fixture IDs (stable across calls within the same test file) ───────────────

export const IDS = {
  // Tenant A
  tenantA: uuidv4(),
  adminA: uuidv4(),
  analystA: uuidv4(),
  viewerA: uuidv4(),
  serverA: uuidv4(),

  // Tenant B
  tenantB: uuidv4(),
  adminB: uuidv4(),
  serverB: uuidv4(),
};

export type FixtureSet = typeof IDS;

// ── Token factory (uses real signToken) ───────────────────────────────────────

export function makeToken(userId: string, tenantId: string, email: string, role: string): string {
  return signToken({ userId, tenantId, email, role });
}

export const TOKENS = {
  adminA: () => makeToken(IDS.adminA, IDS.tenantA, 'admin@tenant-a.test', 'admin'),
  analystA: () => makeToken(IDS.analystA, IDS.tenantA, 'analyst@tenant-a.test', 'analyst'),
  viewerA: () => makeToken(IDS.viewerA, IDS.tenantA, 'viewer@tenant-a.test', 'viewer'),
  adminB: () => makeToken(IDS.adminB, IDS.tenantB, 'admin@tenant-b.test', 'admin'),
};

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Wipe all test data and re-insert two clean tenants with users + servers.
 * Call this in beforeEach() for suites that mutate state.
 */
export function seedFixtures(): void {
  const db = getDatabase();

  // Clear in strict FK order
  db.exec(`
    DELETE FROM tool_call_logs;
    DELETE FROM credentials;
    DELETE FROM mcp_servers;
    DELETE FROM users;
    DELETE FROM tenants;
    DELETE FROM safety_blocklist;
    DELETE FROM _seed_flags;
  `);

  const ph = hashPassword(TEST_PASSWORD);

  db.transaction(() => {
    // ── Tenant A ──────────────────────────────────────────────────────────────
    db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)`)
      .run(IDS.tenantA, 'Tenant Alpha', 'tenant-a');

    db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(IDS.adminA, IDS.tenantA, 'admin@tenant-a.test', ph, 'admin');
    db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(IDS.analystA, IDS.tenantA, 'analyst@tenant-a.test', ph, 'analyst');
    db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(IDS.viewerA, IDS.tenantA, 'viewer@tenant-a.test', ph, 'viewer');

    db.prepare(`
      INSERT INTO mcp_servers (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      IDS.serverA,
      IDS.tenantA,
      'Server Alpha',
      'http://mcp-alpha.test',
      JSON.stringify(['search']),
      JSON.stringify({ tools: [{ name: 'search' }] }),
      IDS.adminA,
    );

    // ── Tenant B ──────────────────────────────────────────────────────────────
    db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)`)
      .run(IDS.tenantB, 'Tenant Beta', 'tenant-b');

    db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(IDS.adminB, IDS.tenantB, 'admin@tenant-b.test', ph, 'admin');

    db.prepare(`
      INSERT INTO mcp_servers (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      IDS.serverB,
      IDS.tenantB,
      'Server Beta',
      'http://mcp-beta.test',
      JSON.stringify(['compute']),
      JSON.stringify({ tools: [{ name: 'compute' }] }),
      IDS.adminB,
    );

    // Default blocked tools (matching database.ts migration)
    const defaults = [
      ['shell_exec', 'Remote code execution risk'],
      ['delete_all', 'Destructive operation'],
      ['rm_rf', 'Destructive filesystem operation'],
      ['eval_code', 'Arbitrary code execution risk'],
      ['system_call', 'OS-level access denied'],
    ];
    const ins = db.prepare(
      `INSERT OR IGNORE INTO safety_blocklist (tool_name, reason, added_by) VALUES (?, ?, 'system')`
    );
    for (const [name, reason] of defaults) ins.run(name, reason);
  })();
}

/**
 * Store an encrypted credential for a user/server so proxy tests can find one.
 */
export function seedCredential(userId: string, serverId: string, apiKey: string): void {
  const db = getDatabase();
  const payload = encrypt(apiKey);
  const id = uuidv4();
  db.prepare(`
    INSERT OR REPLACE INTO credentials (id, user_id, server_id, encrypted_key, iv, auth_tag)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, serverId, payload.ciphertext, payload.iv, payload.authTag);
}

export { TEST_PASSWORD };
