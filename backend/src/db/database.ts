import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../utils/logger';

const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../../data/mcp_gateway.db');

let db: Database.Database;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db && db.open) {
    db.close();
  }
}

export function initializeDatabase(): void {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info(`📦 SQLite database at: ${DB_PATH}`);

  runMigrations(db);
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    -- Tenants table
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      slug        TEXT NOT NULL UNIQUE,
      plan        TEXT NOT NULL DEFAULT 'free',
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Users table
    -- Roles: 'admin' | 'analyst' | 'viewer'
    --   admin   → full access including /admin routes
    --   analyst → call tools + view own logs
    --   viewer  → browse servers & schemas, cannot call tools
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'analyst',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, email)
    );

    -- MCP Servers — tenant-scoped tool providers with registry metadata
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      api_key      TEXT,
      is_active    INTEGER NOT NULL DEFAULT 1,
      capabilities TEXT NOT NULL DEFAULT '[]',
      tool_schema  TEXT NOT NULL DEFAULT '{}',
      owner_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Audit log
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id     TEXT REFERENCES users(id),
      action      TEXT NOT NULL,
      resource    TEXT NOT NULL,
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Credential Vault — AES-256-GCM encrypted API keys per user per MCP server
    CREATE TABLE IF NOT EXISTS credentials (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id     TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      encrypted_key TEXT NOT NULL,
      iv            TEXT NOT NULL,
      auth_tag      TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, server_id)
    );

    -- Tool call logs — every proxy call, allowed or blocked
    CREATE TABLE IF NOT EXISTS tool_call_logs (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id     TEXT NOT NULL,
      server_id     TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      input_params  TEXT NOT NULL DEFAULT '{}',
      output        TEXT DEFAULT NULL,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      was_blocked   INTEGER NOT NULL DEFAULT 0,
      block_reason  TEXT DEFAULT NULL
    );

    -- Safety blocklist — tool names that are globally denied
    CREATE TABLE IF NOT EXISTS safety_blocklist (
      tool_name   TEXT PRIMARY KEY,
      reason      TEXT NOT NULL DEFAULT 'Policy violation',
      added_by    TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Seed flags — prevents re-seeding on every restart
    CREATE TABLE IF NOT EXISTS _seed_flags (
      key        TEXT PRIMARY KEY,
      seeded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_users_tenant          ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant    ON mcp_servers(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_active    ON mcp_servers(is_active);
    CREATE INDEX IF NOT EXISTS idx_audit_tenant          ON audit_logs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at      ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_credentials_user      ON credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_credentials_server    ON credentials(server_id);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_user        ON tool_call_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_tenant      ON tool_call_logs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tool_logs_timestamp   ON tool_call_logs(timestamp);
  `);

  // ── ALTER TABLE guards for pre-existing databases ─────────────────────────
  const alterGuards = [
    `ALTER TABLE mcp_servers ADD COLUMN tool_schema TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE mcp_servers ADD COLUMN owner_id TEXT`,
    // MCP transport configuration columns (added in v2 migration)
    `ALTER TABLE mcp_servers ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'legacy_http'`,
    `ALTER TABLE mcp_servers ADD COLUMN stdio_command TEXT`,
    `ALTER TABLE mcp_servers ADD COLUMN stdio_args TEXT`,
    `ALTER TABLE mcp_servers ADD COLUMN stdio_env TEXT`,
  ];
  for (const sql of alterGuards) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  // Seed default blocked tools on first run
  const blocklisted = database
    .prepare("SELECT COUNT(*) as c FROM safety_blocklist")
    .get() as { c: number };
  if (blocklisted.c === 0) {
    const insertBlock = database.prepare(
      `INSERT OR IGNORE INTO safety_blocklist (tool_name, reason, added_by)
       VALUES (?, ?, 'system')`
    );
    const defaults = [
      ['shell_exec', 'Remote code execution risk'],
      ['delete_all', 'Destructive operation'],
      ['rm_rf', 'Destructive filesystem operation'],
      ['eval_code', 'Arbitrary code execution risk'],
      ['system_call', 'OS-level access denied'],
    ];
    const tx = database.transaction(() => {
      for (const [name, reason] of defaults) insertBlock.run(name, reason);
    });
    tx();
  }

  logger.info('✅ Migrations applied');
}
