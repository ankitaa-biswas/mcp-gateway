/**
 * proxy.test.ts
 *
 * Tests: MCP Proxy endpoint — POST /api/proxy/:serverId/call
 *
 * fetch() is stubbed via vi.stubGlobal() so no real network call is made.
 *
 * Covers:
 *  ✓ Valid tool call is forwarded and returns safety-enriched envelope
 *  ✓ Response includes server_id, tool, result, safety metadata
 *  ✓ Downstream timeout (AbortError) returns 504
 *  ✓ Downstream 5xx returns 502
 *  ✓ Unknown server ID returns 404
 *  ✓ Tool not in server's tool_schema returns 400
 *  ✓ Missing vault credential returns 403 (not a 500)
 *  ✓ Viewer role is rejected before reaching the proxy (403)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, seedCredential, TOKENS, IDS } from './helpers/fixtures';
import { __resetRateLimitStore } from '../middleware/safetyMiddleware';
import { v4 as uuidv4 } from 'uuid';

const app = createTestApp();

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  seedFixtures();
  __resetRateLimitStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetchSuccess(body: unknown = { answer: 42 }) {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function mockFetchError(status: number, body = 'Internal Server Error') {
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status,
    headers: { get: () => 'text/plain' },
    json: async () => ({ error: body }),
    text: async () => body,
  }));
}

function mockFetchTimeout() {
  vi.stubGlobal('fetch', async (_url: string, opts: { signal?: AbortSignal }) => {
    return new Promise<never>((_resolve, reject) => {
      // Listen for the abort signal and reject with an AbortError
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
      // Never resolve — simulates a hanging connection
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Proxy — successful forward', () => {
  it('valid tool call returns 200 with safety-enriched envelope', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchSuccess({ items: ['result1', 'result2'] });

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: { q: 'test' } });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('result');
    expect(res.body).toHaveProperty('safety');
    expect(res.body.safety).toHaveProperty('rateLimit');
    expect(res.body.safety.logged).toBe(true);
    expect(res.body.tool).toBe('search');
    expect(res.body.server_id).toBe(IDS.serverA);
  });

  it('response contains duration_ms and server_name', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchSuccess({ data: 'ok' });

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(200);
    expect(typeof res.body.duration_ms).toBe('number');
    expect(res.body.server_name).toBe('Server Alpha');
  });

  it('safety.rateLimit includes remaining count and limit', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchSuccess();

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(200);
    expect(res.body.safety.rateLimit).toHaveProperty('remaining');
    expect(res.body.safety.rateLimit).toHaveProperty('limit', 20);
    expect(res.body.safety.rateLimit).toHaveProperty('resetAt');
  });
});

// ── Downstream failure handling ───────────────────────────────────────────────

describe('Proxy — downstream failure handling', () => {
  it('downstream timeout returns HTTP 504', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchTimeout();

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  }, 20_000);

  it('downstream 500 response returns HTTP 502', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchError(500, 'downstream server error');

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/MCP server returned/i);
  });

  it('downstream 400 response is proxied back as-is (4xx passthrough)', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    mockFetchError(400, 'bad request to mcp');

    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    // 4xx from downstream is passed back (not mapped to 502)
    expect(res.status).toBe(400);
  });
});

// ── Invalid request handling ──────────────────────────────────────────────────

describe('Proxy — invalid request rejection', () => {
  it('unknown server ID returns 404', async () => {
    const res = await request(app)
      .post(`/api/proxy/${uuidv4()}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('tool not in server tool_schema returns 400 (advisory validation)', async () => {
    seedCredential(IDS.analystA, IDS.serverA, 'valid-api-key');
    // serverA only has 'search' in its schema
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'nonexistent_tool', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not registered/i);
  });

  it('missing vault credential returns 403 (not 500)', async () => {
    // No credential seeded for analystA+serverA
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no api key stored/i);
  });

  it('missing tool name in body returns 400', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.analystA()}`)
      .send({ params: {} }); // no 'tool' field

    expect(res.status).toBe(400);
  });

  it('viewer role cannot call tools (403 before reaching proxy logic)', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .set('Authorization', `Bearer ${TOKENS.viewerA()}`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request(app)
      .post(`/api/proxy/${IDS.serverA}/call`)
      .send({ tool: 'search', params: {} });

    expect(res.status).toBe(401);
  });
});
