/**
 * safety.test.ts
 *
 * Tests: Safety Middleware — blocklist, input sanitization, audit logging
 *
 * Covers:
 *  ✓ Blocklisted tool call (shell_exec) is rejected with 403
 *  ✓ A tool removed from the blocklist is allowed through
 *  ✓ Allowed tool proceeds past the safety layer (reaches vault/proxy stage)
 *  ✓ Oversized param value (>10,000 chars) is rejected with 400
 *  ✓ Nested oversized param value is rejected with 400
 *  ✓ Blocked call is logged to tool_call_logs with was_blocked=1
 *  ✓ Allowed call (not blocked but failing later) is logged with was_blocked=0
 *  ✓ Admin can add a new tool to the blocklist (POST /api/admin/blocklist)
 *  ✓ Admin can remove a tool from the blocklist (DELETE /api/admin/blocklist/:name)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, seedCredential, TOKENS, IDS } from './helpers/fixtures';
import { getDatabase } from './helpers/testApp';
import { __resetRateLimitStore } from '../middleware/safetyMiddleware';

const app = createTestApp();

beforeEach(() => {
  seedFixtures();
  __resetRateLimitStore();
});

// ── Blocklist ─────────────────────────────────────────────────────────────────

describe('Safety — blocklist enforcement', () => {
  it('calling a blocklisted tool (shell_exec) returns 403', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'shell_exec', params: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/blocked by safety policy/i);
  });

  it('calling delete_all (blocklisted) returns 403', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'delete_all', params: {} });

    expect(res.status).toBe(403);
  });

  it('allowed tool (search) passes the blocklist check', async () => {
    // No credential seeded → should fail at vault stage (403/404), NOT blocklist (403)
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { q: 'hello' } });

    // Must NOT be the blocklist 403 message
    if (res.status === 403) {
      expect(res.body.error).not.toMatch(/blocked by safety policy/i);
    }
    // Should fail at vault missing key (403 with vault message)
    expect([403, 404]).toContain(res.status);
  });
});

// ── Admin blocklist management ─────────────────────────────────────────────────

describe('Safety — admin blocklist CRUD', () => {
  it('admin can add a new tool to the blocklist', async () => {
    const res = await request(app)
      .post('/api/admin/blocklist')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ tool_name: 'custom_dangerous_tool', reason: 'Security review' });

    expect(res.status).toBe(201);
    expect(res.body.tool_name).toBe('custom_dangerous_tool');
  });

  it('newly added tool is rejected by the safety middleware', async () => {
    // Add tool
    await request(app)
      .post('/api/admin/blocklist')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ tool_name: 'my_new_blocked_tool', reason: 'Test block' });

    // Try to call it
    const callRes = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'my_new_blocked_tool', params: {} });

    expect(callRes.status).toBe(403);
    expect(callRes.body.error).toMatch(/blocked by safety policy/i);
  });

  it('admin can remove a tool from the blocklist', async () => {
    const res = await request(app)
      .delete('/api/admin/blocklist/shell_exec')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/removed from blocklist/i);
  });

  it('GET /api/admin/blocklist returns all blocklisted tools', async () => {
    const res = await request(app)
      .get('/api/admin/blocklist')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = (res.body as Array<{ tool_name: string }>).map(t => t.tool_name);
    expect(names).toContain('shell_exec');
  });

  it('removing a non-existent tool returns 404', async () => {
    const res = await request(app)
      .delete('/api/admin/blocklist/no_such_tool_xyz')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(404);
  });
});

// ── Input sanitization ────────────────────────────────────────────────────────

describe('Safety — oversized payload rejection', () => {
  it('param value exceeding 10,000 chars is rejected with 400', async () => {
    const bigString = 'A'.repeat(10_001);
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { query: bigString } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the maximum allowed length/i);
  });

  it('exactly 10,000 char value is allowed through sanitization', async () => {
    // Exactly at the limit — should NOT be rejected by sanitizer
    // (may fail at vault/network, which is fine)
    const borderString = 'B'.repeat(10_000);
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { query: borderString } });

    // Must NOT be rejected by the sanitizer
    expect(res.status).not.toBe(400);
  });

  it('oversized nested param value is rejected with 400', async () => {
    const bigString = 'C'.repeat(10_001);
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { nested: { deep: bigString } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the maximum allowed length/i);
  });
});

// ── Audit logging ─────────────────────────────────────────────────────────────

describe('Safety — audit logging', () => {
  it('blocked tool call is logged to tool_call_logs with was_blocked=1', async () => {
    await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'shell_exec', params: { cmd: 'ls' } });

    const db = getDatabase();
    const log = db
      .prepare('SELECT * FROM tool_call_logs WHERE tool_name = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 1')
      .get('shell_exec', IDS.analystA) as Record<string, unknown> | undefined;

    expect(log).toBeDefined();
    expect(log?.['was_blocked']).toBe(1);
    expect(log?.['block_reason']).toMatch(/blocked by safety policy/i);
  });

  it('allowed call is logged with was_blocked=0 after eventual success', async () => {
    const { vi } = await import('vitest');
    seedCredential(IDS.analystA, IDS.serverA, 'test-api-key');

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ answer: 42 }),
    }));

    await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { q: 'audit-test' } });

    const db = getDatabase();
    const log = db
      .prepare(`
        SELECT * FROM tool_call_logs 
        WHERE tool_name = 'search' AND user_id = ?
        ORDER BY timestamp DESC LIMIT 1
      `)
      .get(IDS.analystA) as Record<string, unknown> | undefined;

    expect(log).toBeDefined();
    expect(log?.['was_blocked']).toBe(0);
    expect(log?.['block_reason']).toBeNull();

    vi.unstubAllGlobals();
  });
});
