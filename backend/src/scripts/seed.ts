import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { initializeDatabase, getDatabase } from '../db/database';
import { logger } from '../utils/logger';

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password + (process.env['PASSWORD_SALT'] || 'mcp-salt')).digest('hex');
}

async function seed() {
  logger.info('🌱 Starting database seed...');
  
  // Initialize and get db instance
  initializeDatabase();
  const db = getDatabase();

  try {
    // 1. Clean Slate for Demo Tenant
    db.prepare(`DELETE FROM tenants WHERE slug = ?`).run('demo-enterprise');

    // 2. Create a Demo Tenant
    const tenantId = '00000000-0000-0000-0000-000000000001';
    db.prepare(`
      INSERT INTO tenants (id, name, slug)
      VALUES (?, ?, ?)
    `).run(tenantId, 'Demo Enterprise', 'demo-enterprise');

    // 3. Create 3 Users (Admin, Analyst, Viewer)
    const users = [
      { id: '10000000-0000-0000-0000-000000000001', email: 'admin@demo.com', role: 'admin' },
      { id: '10000000-0000-0000-0000-000000000002', email: 'analyst@demo.com', role: 'analyst' },
      { id: '10000000-0000-0000-0000-000000000003', email: 'viewer@demo.com', role: 'viewer' }
    ];

    const passwordHash = hashPassword('Demo1234!');

    for (const u of users) {
      db.prepare(`
        INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, role)
        VALUES (?, ?, ?, ?, ?)
      `).run(u.id, tenantId, u.email, passwordHash, u.role);
    }

    // 3. Create Mock MCP Servers
    const server1Id = '20000000-0000-0000-0000-000000000001';
    const server1Schema = JSON.stringify({
      tools: [
        {
          name: 'read_log_file',
          description: 'Reads the contents of a system log file from the server.',
          inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to log file' } }, required: ['path'] }
        },
        {
          name: 'restart_service',
          description: 'Restarts a systemd service.',
          inputSchema: { type: 'object', properties: { serviceName: { type: 'string' } }, required: ['serviceName'] }
        }
      ]
    });
    
    db.prepare(`
      INSERT OR IGNORE INTO mcp_servers (id, tenant_id, name, base_url, is_active, capabilities, tool_schema)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(server1Id, tenantId, 'Linux Sysadmin Node', 'http://localhost:8001', 1, JSON.stringify(['read', 'execute']), server1Schema);

    // 4. Create Fake Tool Call Logs
    const logStmt = db.prepare(`
      INSERT INTO tool_call_logs (id, user_id, tenant_id, server_id, tool_name, input_params, output, was_blocked, block_reason, timestamp)
      VALUES (?, (SELECT id FROM users WHERE email = 'analyst@demo.com'), ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Helper to generate past dates
    const getPastDate = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

    logStmt.run(uuidv4(), tenantId, server1Id, 'read_log_file', '{"path": "/var/log/syslog"}', '{"status": "success"}', 0, null, getPastDate(2));
    logStmt.run(uuidv4(), tenantId, server1Id, 'restart_service', '{"serviceName": "nginx"}', '{"status": "success"}', 0, null, getPastDate(24));
    logStmt.run(uuidv4(), tenantId, server1Id, 'delete_all', '{"target": "/"}', null, 1, 'Tool is blocked by safety policy: Destructive', getPastDate(48));
    logStmt.run(uuidv4(), tenantId, server1Id, 'read_log_file', '{"path": "/var/log/auth.log"}', '{"status": "success"}', 0, null, getPastDate(72));

    logger.info('✅ Seeding complete! Login with any demo user (e.g. admin@demo.com) and password: Demo1234!');
  } catch (err) {
    logger.error('❌ Seeding failed:', err);
  }
}

seed();
