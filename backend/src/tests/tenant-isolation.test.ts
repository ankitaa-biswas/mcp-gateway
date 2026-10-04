/**
 * tenant-isolation.test.ts
 *
 * Tests: Multi-tenant data isolation
 *
 * Covers:
 *  ✓ Tenant A cannot see Tenant B's MCP servers (GET /api/servers)
 *  ✓ Tenant A cannot fetch Tenant B's server by ID (GET /api/servers/:id)
 *  ✓ Tenant A cannot store a credential against Tenant B's server (POST /api/vault/store)
 *  ✓ Tenant A cannot retrieve Tenant B's credential (GET /api/vault/retrieve/:id)
 *  ✓ Tenant A's admin cannot see Tenant B's tool logs (GET /api/admin/logs)
 *  ✓ Tenant A's admin cannot see Tenant B's users via tenant route
 *  ✓ Cross-tenant server ID in proxy call returns 404 (no data leak)
 *  ✓ GET /api/tenants/me returns the correct tenant for each user
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, seedCredential, TOKENS, IDS, TEST_PASSWORD } from './helpers/fixtures';
import { getDatabase } from './helpers/testApp';
import { v4 as uuidv4 } from 'uuid';

const app = createTestApp();

beforeEach(() => {
  seedFixtures();
});

// ── MCP Server isolation ───────────────────────────────────────────────────────

describe('Multi-tenant isolation — MCP server registry', () => {
  it('Tenant A lists only Tenant A servers', async () => {
    const res = await request(app)
      .get('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    const tenantIds = (res.body as Array<{ tenant_id: string }>).map(s => s.tenant_id);
    // All returned servers must belong to Tenant A
    for (const tid of tenantIds) {
      expect(tid).toBe(IDS.tenantA);
    }
    // Tenant B's server must NOT appear
    const ids = (res.body as Array<{ id: string }>).map(s => s.id);
    expect(ids).not.toContain(IDS.serverB);
  });

  it('Tenant A cannot fetch Tenant B server by ID (404)', async () => {
    const res = await request(app)
      .get(`/api/servers/${IDS.serverB}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    // The query scopes by tenant_id, so server B is invisible → 404
    expect(res.status).toBe(404);
  });

  it('Tenant B lists only Tenant B servers', async () => {
    const res = await request(app)
      .get('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.adminB()}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map(s => s.id);
    expect(ids).not.toContain(IDS.serverA);
  });
});

// ── Credential vault isolation ─────────────────────────────────────────────────

describe('Multi-tenant isolation — credential vault', () => {
  it('Tenant A cannot store a credential against Tenant B server (404)', async () => {
    // Tenant A's admin tries to store a key for Tenant B's server
    const res = await request(app)
      .post('/api/vault/store')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ server_id: IDS.serverB, api_key: 'leaked-key' });

    // The cross-tenant fix in storeKey() returns 404
    expect(res.status).toBe(404);
  });

  it('Tenant A cannot retrieve a credential for Tenant B server', async () => {
    // Seed a credential for adminB on serverB (valid within tenant B)
    seedCredential(IDS.adminB, IDS.serverB, 'b-secret-key');

    // Tenant A user tries to retrieve it — should 404 because it's not linked to adminA
    const res = await request(app)
      .get(`/api/vault/retrieve/${IDS.serverB}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('b-secret-key');
  });

  it('Tenant A cannot delete Tenant B credentials', async () => {
    seedCredential(IDS.adminB, IDS.serverB, 'b-secret-key');

    const res = await request(app)
      .delete(`/api/vault/${IDS.serverB}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    // No credential for adminA+serverB exists → 404
    expect(res.status).toBe(404);
  });
});

// ── Admin log isolation ────────────────────────────────────────────────────────

describe('Multi-tenant isolation — audit logs', () => {
  it('Tenant A admin sees only Tenant A logs', async () => {
    const db = getDatabase();
    const logIdB = uuidv4();
    // Directly insert a log for tenant B
    db.prepare(`
      INSERT INTO tool_call_logs (id, user_id, tenant_id, server_id, tool_name, input_params, was_blocked)
      VALUES (?, ?, ?, ?, 'tenantB-tool', '{}', 0)
    `).run(logIdB, IDS.adminB, IDS.tenantB, IDS.serverB);

    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    const logIds = (res.body.data as Array<{ id: string }>).map(l => l.id);
    expect(logIds).not.toContain(logIdB);
  });
});

// ── Tenant info isolation ──────────────────────────────────────────────────────

describe('Multi-tenant isolation — tenant profile', () => {
  it('GET /api/tenants/me returns Tenant A info for Tenant A user', async () => {
    const res = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(IDS.tenantA);
    expect(res.body.slug).toBe('tenant-a');
  });

  it('GET /api/tenants/me returns Tenant B info for Tenant B user', async () => {
    const res = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${TOKENS.adminB()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(IDS.tenantB);
    expect(res.body.slug).toBe('tenant-b');
  });

  it('Tenant A admin cannot access Tenant B users list (403)', async () => {
    const res = await request(app)
      .get(`/api/tenants/${IDS.tenantB}/users`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(403);
  });
});

// ── Proxy cross-tenant ID isolation ───────────────────────────────────────────

describe('Multi-tenant isolation — proxy cross-tenant server ID', () => {
  it('using Tenant B server ID in Tenant A proxy call returns 404 (no data leak)', async () => {
    // Seed a credential for adminA on serverA first so we get past the key check
    // But use serverB as the proxy target — it does not belong to tenantA
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverB}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'compute', params: {} });

    // The server lookup filters by tenant_id, so serverB is invisible → 404
    expect(res.status).toBe(404);
    // Confirm the response body does NOT reveal serverB details
    expect(JSON.stringify(res.body)).not.toMatch(/tenant-b/i);
    expect(JSON.stringify(res.body)).not.toMatch(/mcp-beta/i);
  });

  it('random UUID server ID returns 404 (no information leakage)', async () => {
    const phantomId = uuidv4();
    const res = await request(app)
      .post(`/api/proxy/${phantomId}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(404);
    // Ensure the phantom ID is not echoed back in any revealing way
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(IDS.tenantB);
  });
});

// ── Auth login cross-tenant: same email in different tenants ───────────────────

describe('Multi-tenant isolation — login scoping', () => {
  it('Same email in two tenants resolves to correct tenant user', async () => {
    const db = getDatabase();
    const { hashSync } = { hashSync: (p: string) => {
      const crypto = require('crypto') as typeof import('crypto');
      const salt = process.env['PASSWORD_SALT'] ?? 'test-salt';
      return crypto.createHash('sha256').update(p + salt).digest('hex');
    }};

    // Insert same email in tenant B
    db.prepare(`INSERT OR IGNORE INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), IDS.tenantB, 'admin@tenant-a.test', hashSync(TEST_PASSWORD), 'admin');

    const resA = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@tenant-a.test', password: TEST_PASSWORD, tenantSlug: 'tenant-a' });
    expect(resA.status).toBe(200);

    const resB = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@tenant-a.test', password: TEST_PASSWORD, tenantSlug: 'tenant-b' });
    expect(resB.status).toBe(200);

    // They should receive different tokens bound to different tenants
    expect(resA.body.tenant.id).toBe(IDS.tenantA);
    expect(resB.body.tenant.id).toBe(IDS.tenantB);
  });
});
