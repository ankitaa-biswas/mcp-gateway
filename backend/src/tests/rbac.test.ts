/**
 * rbac.test.ts
 *
 * Tests: Role-Based Access Control
 *
 * Covers:
 *  ✓ admin can access GET /api/admin/logs
 *  ✓ admin can access GET /api/admin/blocklist
 *  ✓ admin can POST to /api/servers (register new server)
 *  ✓ analyst cannot access admin routes (403)
 *  ✓ analyst CAN access GET /api/servers (viewer-level read)
 *  ✓ viewer cannot access admin routes (403)
 *  ✓ viewer cannot call tools via proxy (403)
 *  ✓ viewer CAN list servers (GET /api/servers)
 *  ✓ unauthenticated request to any protected route gets 401
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, TOKENS, IDS } from './helpers/fixtures';

const app = createTestApp();

beforeEach(() => {
  seedFixtures();
});

// ── Admin role ────────────────────────────────────────────────────────────────

describe('RBAC — admin role', () => {
  it('admin can access GET /api/admin/logs', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('admin can access GET /api/admin/blocklist', async () => {
    const res = await request(app)
      .get('/api/admin/blocklist')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('admin can register a new MCP server (POST /api/servers)', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({
        name: 'New Server',
        base_url: 'https://newserver.test',
        capabilities: ['search'],
        tool_schema: { tools: [{ name: 'search' }] },
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Server');
    expect(res.body.tenant_id).toBe(IDS.tenantA);
  });

  it('admin can add a tool to the blocklist', async () => {
    const res = await request(app)
      .post('/api/admin/blocklist')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ tool_name: 'admin_new_tool', reason: 'RBAC test' });

    expect(res.status).toBe(201);
    expect(res.body.tool_name).toBe('admin_new_tool');
  });
});

// ── Analyst role ──────────────────────────────────────────────────────────────

describe('RBAC — analyst role', () => {
  it('analyst is forbidden from GET /api/admin/logs (403)', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${TOKENS.analystA()}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it('analyst is forbidden from POST /api/servers (403)', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({
        name: 'Hack Server',
        base_url: 'https://hack.test',
      });

    expect(res.status).toBe(403);
  });

  it('analyst CAN list servers (GET /api/servers)', async () => {
    const res = await request(app)
      .get('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.analystA()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Viewer role ───────────────────────────────────────────────────────────────

describe('RBAC — viewer role', () => {
  it('viewer is forbidden from GET /api/admin/logs (403)', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${TOKENS.viewerA()}`);

    expect(res.status).toBe(403);
  });

  it('viewer is forbidden from calling tools via proxy (403)', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.viewerA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it('viewer CAN list servers (GET /api/servers)', async () => {
    const res = await request(app)
      .get('/api/servers')
      .set('Authorization', `Bearer ${TOKENS.viewerA()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Unauthenticated ───────────────────────────────────────────────────────────

describe('RBAC — unauthenticated', () => {
  it('GET /api/admin/logs without a token returns 401', async () => {
    const res = await request(app).get('/api/admin/logs');
    expect(res.status).toBe(401);
  });

  it('GET /api/servers without a token returns 401', async () => {
    const res = await request(app).get('/api/servers');
    expect(res.status).toBe(401);
  });
});
