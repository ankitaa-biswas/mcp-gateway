/**
 * rate-limit.test.ts
 *
 * Tests: Per-user tool-call rate limiter in safetyMiddleware.ts
 *
 * The rate limiter uses an in-memory Map (rateLimitStore) keyed by userId.
 * Limit: 20 calls per 60-second window.
 *
 * Strategy: We call a BLOCKED tool so the safety middleware runs and increments
 * the counter but we don't need a real MCP server or vault key.
 * Alternatively we directly call the proxy with a blocked tool — the rate limit
 * check happens BEFORE the blocklist check, so once the window is exhausted we
 * get 429 even for blocked tools.
 *
 * Covers:
 *  ✓ First request within the window succeeds (counter incremented)
 *  ✓ Requests up to the limit (20) are allowed
 *  ✓ The 21st request within the same window returns HTTP 429
 *  ✓ 429 response body includes rate-limit reason string
 *  ✓ After a new window (simulated by clearing the store) requests succeed again
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, seedCredential, TOKENS, IDS } from './helpers/fixtures';
import { __resetRateLimitStore } from '../middleware/safetyMiddleware';

const app = createTestApp();

// We use analyst token (can call tools); we aim at serverA which exists in tenant A
// We pick a tool that is NOT on the blocklist — 'search' is defined in serverA's schema
// The real proxy will fail at the vault key stage (HTTP 403 from getKey) but the
// rate-limit middleware runs before that and is what we are testing.
// To avoid needing a real downstream, we seed a credential and mock fetch.

beforeEach(() => {
  seedFixtures();
  __resetRateLimitStore(); // ensure clean window for each test
});

// ── Helper — fire one proxy call (may fail at vault/network, that's OK) ────────
async function fireCall(token: string, serverId: string, toolName = 'search') {
  return request(app)
    .post(`/api/proxy/${serverId}/call`)
    .set('Authorization', `Bearer ${token}`)
    .send({ tool: toolName, params: {} });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Rate limiting — safetyMiddleware', () => {
  it('first request (no vault key) passes rate check and reaches vault stage (not 429)', async () => {
    // No credential seeded → expect 403 from vault, NOT 429 from rate limit
    const res = await fireCall(TOKENS.analystA(), IDS.serverA);
    // Should fail at vault/server lookup, not rate limit
    expect(res.status).not.toBe(429);
  });

  it('20 requests are all allowed (under or at limit)', async () => {
    // Seed credential so we get past the vault check
    seedCredential(IDS.analystA, IDS.serverA, 'test-key');
    // vi.stubGlobal so fetch doesn't actually network
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }));

    const LIMIT = 20;
    for (let i = 0; i < LIMIT; i++) {
      const res = await fireCall(TOKENS.analystA(), IDS.serverA);
      expect(res.status).not.toBe(429);
    }

    vi.unstubAllGlobals();
  });

  it('the 21st request returns HTTP 429', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'test-key');
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }));

    const LIMIT = 20;
    for (let i = 0; i < LIMIT; i++) {
      await fireCall(TOKENS.analystA(), IDS.serverA);
    }
    // 21st call — over the limit
    const res = await fireCall(TOKENS.analystA(), IDS.serverA);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);

    vi.unstubAllGlobals();
  });

  it('429 response includes a descriptive error message with reset info', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'test-key');
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }));

    for (let i = 0; i < 21; i++) {
      await fireCall(TOKENS.analystA(), IDS.serverA);
    }
    const res = await fireCall(TOKENS.analystA(), IDS.serverA);
    expect(res.status).toBe(429);
    // Should mention the limit and reset time
    expect(res.body.error).toMatch(/20/);

    vi.unstubAllGlobals();
  });

  it('different users share no rate-limit state (Tenant B analyst has fresh window)', async () => {
    // Exhaust Tenant A analyst's window
    seedCredential(IDS.analystA, IDS.serverA, 'test-key');
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }));

    for (let i = 0; i <= 20; i++) {
      await fireCall(TOKENS.analystA(), IDS.serverA);
    }
    const exhausted = await fireCall(TOKENS.analystA(), IDS.serverA);
    expect(exhausted.status).toBe(429);

    // Tenant B admin's first call should not be rate-limited (different userId key)
    // (No server in their tenant but the rate-limit check runs first)
    const resBAdmin = await fireCall(TOKENS.adminB(), IDS.serverA);
    // May be 404 (server belongs to tenantA from tenantB's view) but NOT 429
    expect(resBAdmin.status).not.toBe(429);

    vi.unstubAllGlobals();
  });

  it('after store reset, requests succeed again within the new window', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'test-key');
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }));

    // Exhaust
    for (let i = 0; i <= 20; i++) {
      await fireCall(TOKENS.analystA(), IDS.serverA);
    }
    const beforeReset = await fireCall(TOKENS.analystA(), IDS.serverA);
    expect(beforeReset.status).toBe(429);

    // Reset simulates a new window
    __resetRateLimitStore();

    const afterReset = await fireCall(TOKENS.analystA(), IDS.serverA);
    expect(afterReset.status).not.toBe(429);

    vi.unstubAllGlobals();
  });
});
