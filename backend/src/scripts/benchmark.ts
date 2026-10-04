#!/usr/bin/env ts-node
/**
 * benchmark.ts
 *
 * Measures MCP Gateway throughput and latency on the REAL /mcp Streamable HTTP endpoint.
 *
 * Architecture tested:
 *   MCP Client (benchmark workers)
 *     → POST /mcp (Streamable HTTP, JWT auth, RBAC, tenant isolation, safety blocklist, rate limiting, vault decryption)
 *     → McpClientManager
 *     → Downstream Streamable HTTP MCP Server (real MCP protocol)
 *
 * Methodology:
 *  - Real Express app started on a free port (no mocking of routes/middleware)
 *  - In-memory SQLite (DB_PATH=:memory:) — isolated from dev data
 *  - Downstream MCP server: Real MCP server over Streamable HTTP transport
 *  - Warmed up with sequential requests before measurement begins
 *  - Measurement: CONCURRENCY workers each firing REQUESTS_PER_WORKER requests
 *  - Latency measured as time from request send to response received (HTTP round-trip)
 *  - Gateway overhead = total latency − downstream latency (measured separately)
 *  - Reports: Throughput, P50, P95, P99, Min, Max, Errors.
 *
 * Run: npx ts-node --transpile-only src/scripts/benchmark.ts
 */

// ── Must set env before ANY project imports ───────────────────────────────────
process.env['DB_PATH']          = ':memory:';
process.env['NODE_ENV']         = 'test';  // enables __resetRateLimitStore
process.env['JWT_SECRET']       = 'bench-secret-key-32chars-padding!!';
process.env['JWT_EXPIRY']       = '1h';
process.env['PASSWORD_SALT']    = 'bench-salt';
process.env['VAULT_MASTER_KEY'] = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
process.env['CORS_ORIGIN']      = 'http://localhost:5173';

import http from 'http';
import net from 'net';
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Project imports (after env is set)
import { initializeDatabase, getDatabase, closeDatabase } from '../db/database';
import app from '../app';
import { signToken } from '../utils/jwt';
import { encrypt } from '../services/vaultService';
import { __resetRateLimitStore } from '../middleware/safetyMiddleware';
import { __resetRateLimitStoreMcp } from '../middleware/mcpSafetyHelpers';
import { mcpClientManager } from '../services/mcpClientManager';

// ── Config ────────────────────────────────────────────────────────────────────

const CONCURRENCY          = 20;  // parallel workers (one unique user each)
const REQUESTS_PER_WORKER  = 15;  // calls each worker fires — stays under per-user rate limit
const WARMUP_REQUESTS      = 20;  // sequential warm-up (dedicated warmup users)
const TOTAL_MEASURED        = CONCURRENCY * REQUESTS_PER_WORKER;  // 300 requests

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

interface ManagedServer {
  server: http.Server;
  port: number;
  sockets: Set<net.Socket>;
}

async function startServer(expressApp: express.Application): Promise<ManagedServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    const sockets = new Set<net.Socket>();

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('bad address'));
      resolve({ server, port: addr.port, sockets });
    });
  });
}

async function stopServer(managed: ManagedServer): Promise<void> {
  const { server, sockets } = managed;
  return new Promise((resolve) => {
    if (typeof (server as any).closeIdleConnections === 'function') {
      (server as any).closeIdleConnections();
    }
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    for (const socket of sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    sockets.clear();

    server.close(() => {
      resolve();
    });
  });
}

// ── Downstream Real MCP server over Streamable HTTP ──────────────────────────

function createDownstreamMcpServer(): express.Application {
  const downstreamApp = express();
  downstreamApp.use(express.json());

  downstreamApp.all('/mcp', async (req, res) => {
    res.setHeader('Connection', 'close');
    const server = new McpServer({ name: 'bench-downstream', version: '1.0.0' });
    (server as any).registerTool(
      'search',
      {
        description: 'Benchmark search tool',
        inputSchema: { q: z.string().optional() },
      },
      async (args: { q?: string }) => {
        return {
          content: [{ type: 'text', text: `result for ${args?.q ?? 'ok'}` }],
        };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('finish', () => {
      server.close().catch(() => {});
    });
  });

  return downstreamApp;
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────

interface TimedResult {
  status: number;
  latencyMs: number;
  body: string;
}

function httpPost(host: string, port: number, path: string, body: unknown, headers: Record<string, string>): Promise<TimedResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const start = process.hrtime.bigint();

    const req = http.request({
      hostname: host,
      port,
      path,
      method: 'POST',
      agent: false, // Don't pool sockets in globalAgent
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Connection': 'close',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        resolve({ status: res.statusCode ?? 0, latencyMs, body: data });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Measure downstream-only latency (baseline) ────────────────────────────────

async function measureDownstreamLatency(downstreamPort: number, samples = 50): Promise<number> {
  const latencies: number[] = [];
  const reqBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search', arguments: { q: 'benchmark' } },
  };

  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    await httpPost('127.0.0.1', downstreamPort, '/mcp', reqBody, {});
    latencies.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return mean(latencies);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬 MCP Gateway Performance Benchmark (Real MCP Protocol)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Path Tested        : POST /mcp (Streamable HTTP)`);
  console.log(`  Downstream Protocol: Real MCP over Streamable HTTP`);
  console.log(`  Concurrency        : ${CONCURRENCY} workers`);
  console.log(`  Requests/worker    : ${REQUESTS_PER_WORKER}`);
  console.log(`  Total measured     : ${TOTAL_MEASURED} requests`);
  console.log(`  Warm-up            : ${WARMUP_REQUESTS} sequential requests`);
  console.log('');

  let downstreamManaged: ManagedServer | null = null;
  let gatewayManaged: ManagedServer | null = null;

  try {
    // ── 1. Start downstream real MCP server ──────────────────────────────────
    downstreamManaged = await startServer(createDownstreamMcpServer());
    const downstreamPort = downstreamManaged.port;
    console.log(`✅ Downstream MCP server running on :${downstreamPort}/mcp`);

    // ── 2. Initialize DB + seed fixtures ────────────────────────────────────
    initializeDatabase();
    const db = getDatabase();

    const tenantId = uuidv4();

    const ph = crypto.createHash('sha256')
      .update('BenchPass1!' + (process.env['PASSWORD_SALT'] ?? 'bench-salt'))
      .digest('hex');

    const serverId = uuidv4();
    const workers: Array<{ userId: string; token: string }> = [];
    const warmupWorkers: Array<{ userId: string; token: string }> = [];

    db.transaction(() => {
      db.prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)').run(tenantId, 'Bench Tenant', 'bench');

      // Create admin as server owner first
      const adminId = uuidv4();
      db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(adminId, tenantId, 'admin@bench.test', ph, 'admin');

      // Seed the real MCP server
      db.prepare(`
        INSERT INTO mcp_servers (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id, transport_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        serverId, tenantId, 'Bench Server',
        `http://127.0.0.1:${downstreamPort}/mcp`,
        JSON.stringify(['tools']),
        JSON.stringify({}),
        adminId,
        'http',
      );

      // Create CONCURRENCY analyst users, each with their own credential
      for (let i = 0; i < CONCURRENCY; i++) {
        const userId = uuidv4();
        const email  = `bench-worker-${i}@test.com`;
        db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(userId, tenantId, email, ph, 'analyst');

        const enc = encrypt('bench-api-key');
        const credId = uuidv4();
        db.prepare(`
          INSERT INTO credentials (id, user_id, server_id, encrypted_key, iv, auth_tag)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(credId, userId, serverId, enc.ciphertext, enc.iv, enc.authTag);

        workers.push({ userId, token: signToken({ userId, tenantId, email, role: 'analyst' }) });
      }

      // Dedicated warm-up users
      for (let i = 0; i < 2; i++) {
        const userId = uuidv4();
        const email  = `bench-warmup-${i}@test.com`;
        db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(userId, tenantId, email, ph, 'analyst');
        const enc = encrypt('bench-api-key');
        const credId = uuidv4();
        db.prepare(`
          INSERT INTO credentials (id, user_id, server_id, encrypted_key, iv, auth_tag)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(credId, userId, serverId, enc.ciphertext, enc.iv, enc.authTag);
        warmupWorkers.push({ userId, token: signToken({ userId, tenantId, email, role: 'analyst' }) });
      }

      // Seed default blocklist
      const blocked = [
        ['shell_exec', 'RCE risk'], ['delete_all', 'Destructive'],
        ['rm_rf', 'FS risk'], ['eval_code', 'Code exec'], ['system_call', 'OS access'],
      ];
      const ins = db.prepare("INSERT OR IGNORE INTO safety_blocklist (tool_name, reason) VALUES (?, ?)");
      for (const [n, r] of blocked) ins.run(n, r);
    })();

    console.log(`✅ Fixtures seeded: ${CONCURRENCY} workers × 1 user+credential each`);

    // ── 3. Start gateway ─────────────────────────────────────────────────────
    gatewayManaged = await startServer(app);
    const gatewayPort = gatewayManaged.port;
    console.log(`✅ Gateway running on :${gatewayPort}/mcp\n`);

    // Gateway namespaced tool name: "bench_server__search"
    const mcpToolName = 'bench_server__search';
    const mcpCallPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: mcpToolName,
        arguments: { q: 'benchmark' },
      },
    };

    // ── 4. Warm-up ───────────────────────────────────────────────────────────
    process.stdout.write('🔥 Warming up (initial tool discovery + sequential calls)');

    // Initial tool discovery via tools/list
    await httpPost('127.0.0.1', gatewayPort, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }, { Authorization: `Bearer ${warmupWorkers[0].token}` });

    for (let i = 0; i < WARMUP_REQUESTS; i++) {
      const w = warmupWorkers[i % warmupWorkers.length];
      await httpPost('127.0.0.1', gatewayPort, '/mcp', mcpCallPayload, { Authorization: `Bearer ${w.token}` });
      process.stdout.write('.');
    }
    console.log(' done\n');

    // Reset rate-limit stores
    __resetRateLimitStore();
    __resetRateLimitStoreMcp();

    // ── 5. Measure downstream-only latency (baseline) ───────────────────────
    const downstreamMeanMs = await measureDownstreamLatency(downstreamPort);

    // ── 6. Benchmark ────────────────────────────────────────────────────────
    console.log(`📊 Running ${TOTAL_MEASURED} measured requests (${CONCURRENCY} concurrent workers, 1 user each)...`);

    const allLatencies: number[] = [];
    let errorCount = 0;
    const benchStart = process.hrtime.bigint();

    await Promise.all(
      workers.map(async (w, idx) => {
        const authHeader = { Authorization: `Bearer ${w.token}` };
        for (let i = 0; i < REQUESTS_PER_WORKER; i++) {
          const r = await httpPost('127.0.0.1', gatewayPort, '/mcp', {
            ...mcpCallPayload,
            id: i + 1,
          }, authHeader);

          let isErr = r.status !== 200;
          if (!isErr) {
            try {
              const bodyObj = JSON.parse(r.body);
              if (bodyObj.error || bodyObj.result?.isError === true) {
                isErr = true;
              }
            } catch {
              if (r.body.includes('"isError":true') || r.body.includes('"error":{')) {
                isErr = true;
              }
            }
          }

          if (isErr) {
            errorCount++;
            console.warn(`  ⚠️  Unexpected status or error in response: status=${r.status} (worker ${idx})`);
          }
          allLatencies.push(r.latencyMs);
        }
      }),
    );

    const totalMs = Number(process.hrtime.bigint() - benchStart) / 1_000_000;

    // ── 7. Compute statistics ───────────────────────────────────────────────
    allLatencies.sort((a, b) => a - b);
    const reqPerSec       = Math.round((TOTAL_MEASURED / totalMs) * 1000);
    const meanLatencyMs   = mean(allLatencies);
    const medianLatencyMs = percentile(allLatencies, 50);
    const p95LatencyMs    = percentile(allLatencies, 95);
    const p99LatencyMs    = percentile(allLatencies, 99);
    const minLatencyMs    = allLatencies[0];
    const maxLatencyMs    = allLatencies[allLatencies.length - 1];
    const gatewayOverhead = meanLatencyMs - downstreamMeanMs;

    // ── 8. Print results ─────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════');
    console.log(' REAL MCP GATEWAY BENCHMARK RESULTS');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  Endpoint            : POST /mcp (Streamable HTTP)`);
    console.log(`  Total requests      : ${TOTAL_MEASURED}`);
    console.log(`  Concurrency         : ${CONCURRENCY} workers`);
    console.log(`  Wall-clock time     : ${totalMs.toFixed(0)} ms`);
    console.log(`  Errors              : ${errorCount} (${((errorCount / TOTAL_MEASURED) * 100).toFixed(1)}%)`);
    console.log('');
    console.log(`  Throughput          : ${reqPerSec} req/sec`);
    console.log('');
    console.log(`  Latency (end-to-end)`);
    console.log(`    Mean              : ${meanLatencyMs.toFixed(2)} ms`);
    console.log(`    Median (P50)      : ${medianLatencyMs.toFixed(2)} ms`);
    console.log(`    P95               : ${p95LatencyMs.toFixed(2)} ms`);
    console.log(`    P99               : ${p99LatencyMs.toFixed(2)} ms`);
    console.log(`    Min               : ${minLatencyMs.toFixed(2)} ms`);
    console.log(`    Max               : ${maxLatencyMs.toFixed(2)} ms`);
    console.log('');
    console.log(`  Downstream baseline : ${downstreamMeanMs.toFixed(2)} ms (real MCP server over Streamable HTTP)`);
    console.log(`  Gateway overhead    : ${gatewayOverhead.toFixed(2)} ms  ← MCP routing + JWT + RBAC + safety + vault + SQLite`);
    console.log('════════════════════════════════════════════════════════');
    console.log('');
  } finally {
    // ── 9. Resource Teardown ─────────────────────────────────────────────────
    // A. Close all MCP clients and transports
    await mcpClientManager.closeAll();

    // B. Stop HTTP servers and close all sockets
    if (gatewayManaged) await stopServer(gatewayManaged);
    if (downstreamManaged) await stopServer(downstreamManaged);

    // C. Close SQLite database connection
    closeDatabase();
    console.log('✅ Resource cleanup complete: servers stopped, MCP clients closed, database closed.\n');
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
