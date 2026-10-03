import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { initializeDatabase, getDatabase } from '../db/database';
import { encrypt } from '../services/vaultService';
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
    const adminId = '10000000-0000-0000-0000-000000000001';
    const analystId = '10000000-0000-0000-0000-000000000002';
    const viewerId = '10000000-0000-0000-0000-000000000003';

    const users = [
      { id: adminId, email: 'admin@demo.com', role: 'admin' },
      { id: analystId, email: 'analyst@demo.com', role: 'analyst' },
      { id: viewerId, email: 'viewer@demo.com', role: 'viewer' }
    ];

    const passwordHash = hashPassword('Demo1234!');

    for (const u of users) {
      db.prepare(`
        INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, role)
        VALUES (?, ?, ?, ?, ?)
      `).run(u.id, tenantId, u.email, passwordHash, u.role);
    }

    // 4. Create Mock & Real MCP Servers
    // Server 1: Legacy HTTP (Sysadmin Node)
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
      INSERT OR REPLACE INTO mcp_servers (id, tenant_id, name, base_url, is_active, capabilities, tool_schema, owner_id, transport_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(server1Id, tenantId, 'Linux Sysadmin Node', 'http://localhost:8001', 1, JSON.stringify(['read', 'execute']), server1Schema, adminId, 'legacy_http');

    // Server 2: Real MCP stdio Server (Calculator)
    const server2Id = '20000000-0000-0000-0000-000000000002';
    const distScript = path.resolve(__dirname, '../../dist/scripts/demoStdioServer.js');
    const tsScript = path.resolve(__dirname, 'demoStdioServer.ts');
    const stdioArgs = fs.existsSync(distScript)
      ? [distScript]
      : ['-r', 'ts-node/register', tsScript];

    db.prepare(`
      INSERT OR REPLACE INTO mcp_servers
        (id, tenant_id, name, base_url, is_active, capabilities, tool_schema, owner_id,
         transport_type, stdio_command, stdio_args)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      server2Id,
      tenantId,
      'Demo Calculator (stdio)',
      'http://localhost',
      1,
      JSON.stringify(['calculate', 'system']),
      JSON.stringify({}),
      adminId,
      'stdio',
      process.execPath,
      JSON.stringify(stdioArgs),
    );

    // Server 3: Real MCP Streamable HTTP Server (Weather & Currency)
    const server3Id = '20000000-0000-0000-0000-000000000003';
    db.prepare(`
      INSERT OR REPLACE INTO mcp_servers
        (id, tenant_id, name, base_url, is_active, capabilities, tool_schema, owner_id,
         transport_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      server3Id,
      tenantId,
      'Demo Weather Service (HTTP)',
      'http://127.0.0.1:8003/mcp',
      1,
      JSON.stringify(['weather', 'currency']),
      JSON.stringify({}),
      adminId,
      'http',
    );

    // 5. Store API Credentials in Vault for Analyst
    const demoServers = [
      { id: server1Id, key: 'legacy-sysadmin-secret-key' },
      { id: server2Id, key: 'stdio-calculator-key' },
      { id: server3Id, key: 'http-weather-bearer-token' },
    ];

    for (const s of demoServers) {
      const enc = encrypt(s.key);
      db.prepare(`
        INSERT OR REPLACE INTO credentials (id, user_id, server_id, encrypted_key, iv, auth_tag)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), analystId, s.id, enc.ciphertext, enc.iv, enc.authTag);
    }

    // 6. Create Fake Tool Call Logs
    const logStmt = db.prepare(`
      INSERT INTO tool_call_logs (id, user_id, tenant_id, server_id, tool_name, input_params, output, was_blocked, block_reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Helper to generate past dates
    const getPastDate = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

    logStmt.run(uuidv4(), analystId, tenantId, server1Id, 'read_log_file', '{"path": "/var/log/syslog"}', '{"status": "success"}', 0, null, getPastDate(2));
    logStmt.run(uuidv4(), analystId, tenantId, server2Id, 'calc_multiply', '{"a": 21, "b": 2}', '{"content":[{"type":"text","text":"Product: 42"}]}', 0, null, getPastDate(12));
    logStmt.run(uuidv4(), analystId, tenantId, server1Id, 'restart_service', '{"serviceName": "nginx"}', '{"status": "success"}', 0, null, getPastDate(24));
    logStmt.run(uuidv4(), analystId, tenantId, server1Id, 'delete_all', '{"target": "/"}', null, 1, 'Tool is blocked by safety policy: Destructive', getPastDate(48));

    logger.info('✅ Seeding complete!');
    logger.info('   Tenant: Demo Enterprise (demo-enterprise)');
    logger.info('   Users: admin@demo.com, analyst@demo.com, viewer@demo.com (Password: Demo1234!)');
    logger.info('   Servers:');
    logger.info('     1. Linux Sysadmin Node (legacy HTTP)');
    logger.info('     2. Demo Calculator (stdio MCP server)');
    logger.info('     3. Demo Weather Service (Streamable HTTP MCP server on http://127.0.0.1:8003/mcp)');
  } catch (err) {
    logger.error('❌ Seeding failed:', err);
  }
}

seed();
