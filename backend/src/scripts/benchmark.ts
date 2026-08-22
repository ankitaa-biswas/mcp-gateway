#!/usr/bin/env ts-node
/**
 * benchmark.ts
 *
 * Measures MCP Gateway proxy throughput and latency using the real Express app
 * backed by an in-memory SQLite database and a stubbed downstream MCP server.
 *
 * Methodology (fully reproducible):
 *  - Real Express app started on a random free port (no mocking of routes/middleware)
 *  - In-memory SQLite (DB_PATH=:memory:) — isolated from dev data
 *  - Downstream MCP server: a tiny Express server responding in <1ms (localhost:0)
 *  - Warmed up with 20 sequential requests before measurement begins
 *  - Measurement: CONCURRENCY workers each firing REQUESTS_PER_WORKER requests
 *  - Latency measured as time from request send to response received (HTTP round-trip)
 *  - Gateway overhead = total latency − downstream latency (measured separately)
 *  - Results printed as a plain table for easy copy/paste
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
import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Project imports (after env is set)
import { initializeDatabase, getDatabase } from '../db/database';
import app from '../app';
import { signToken } from '../utils/jwt';
import { encrypt } from '../services/vaultService';
import { __resetRateLimitStore } from '../middleware/safetyMiddleware';

// ── Config ────────────────────────────────────────────────────────────────────

const CONCURRENCY          = 20;  // parallel workers (one unique user each)
const REQUESTS_PER_WORKER  = 15;  // calls each worker fires — stays under per-user rate limit
const WARMUP_REQUESTS      = 20;  // sequential warm-up (2 additional warmup users used)
const TOTAL_MEASURED        = CONCURRENCY * REQUESTS_PER_WORKER;  // 300 requests

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function startServer(expressApp: express.Application): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('bad address'));
      resolve({ server, port: addr.port });
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Downstream stub MCP server ─────────────────────────────────────────────────

function createDownstreamStub(): express.Application {
  const stub = express();
  stub.use(express.json());
  stub.post('/call', (_req, res) => {
    res.json({ result: 'benchmark-response', status: 'ok' });
  });
  return stub;
}

// ── HTTP fetch helper (no fetch polyfill needed — uses Node http module) ───────

interface TimedResult {
  status: number;
  latencyMs: number;
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      res.resume(); // drain
      res.on('end', () => {
        const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        resolve({ status: res.statusCode ?? 0, latencyMs });
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
  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    await httpPost('127.0.0.1', downstreamPort, '/call', { tool: 'search', params: {} }, {});
    latencies.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return mean(latencies);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬 MCP Gateway Performance Benchmark');
  console.log('════════════════════════════════════════');
  console.log(`  Concurrency        : ${CONCURRENCY} workers`);
  console.log(`  Requests/worker    : ${REQUESTS_PER_WORKER}`);
  console.log(`  Total measured     : ${TOTAL_MEASURED} requests`);
  console.log(`  Warm-up            : ${WARMUP_REQUESTS} sequential requests`);
  console.log('');

  // ── 1. Start downstream stub ───────────────────────────────────────────────
  const { server: downstreamServer, port: downstreamPort } = await startServer(createDownstreamStub());
  console.log(`✅ Downstream stub running on :${downstreamPort}`);

  // ── 2. Initialize DB + seed fixtures ──────────────────────────────────────
  initializeDatabase();
  const db = getDatabase();

  const tenantId = uuidv4();

  const ph = crypto.createHash('sha256')
    .update('BenchPass1!' + (process.env['PASSWORD_SALT'] ?? 'bench-salt'))
    .digest('hex');

  // Seed one synthetic user + credential per concurrent worker
  // so no single userId exhausts the 20-req/min safety rate limit
  const serverId = uuidv4();
  const workers: Array<{ userId: string; token: string }> = [];
  const warmupWorkers: Array<{ userId: string; token: string }> = [];

  db.transaction(() => {
    db.prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)').run(tenantId, 'Bench Tenant', 'bench');

    // Create admin as server owner first
    const adminId = uuidv4();
    db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(adminId, tenantId, 'admin@bench.test', ph, 'admin');

    // Seed the shared MCP server
    db.prepare(`
      INSERT INTO mcp_servers (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      serverId, tenantId, 'Bench Server',
      `http://127.0.0.1:${downstreamPort}`,
      JSON.stringify(['search']),
      JSON.stringify({ tools: [{ name: 'search' }] }),
      adminId,
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

    // 2 additional dedicated warm-up users (separate budget from measurement users)
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

    // Seed default blocklist so safety middleware doesn't crash
    const blocked = [
      ['shell_exec', 'RCE risk'], ['delete_all', 'Destructive'],
      ['rm_rf', 'FS risk'], ['eval_code', 'Code exec'], ['system_call', 'OS access'],
    ];
    const ins = db.prepare("INSERT OR IGNORE INTO safety_blocklist (tool_name, reason) VALUES (?, ?)");
    for (const [n, r] of blocked) ins.run(n, r);
  })();

  console.log(`✅ Fixtures seeded: ${CONCURRENCY} workers × 1 user+credential each (avoids rate-limit ceiling)`);

  // ── 3. Start gateway ───────────────────────────────────────────────────────
  const { server: gatewayServer, port: gatewayPort } = await startServer(app);
  console.log(`✅ Gateway running on :${gatewayPort}\n`);

  const body = { tool: 'search', params: { q: 'benchmark' } };
  const proxyPath = `/api/proxy/${serverId}/call`;

  // ── 4. Warm-up ─────────────────────────────────────────────────────────────
  process.stdout.write('🔥 Warming up (dedicated warm-up user pool)');
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    const w = warmupWorkers[i % warmupWorkers.length];
    await httpPost('127.0.0.1', gatewayPort, proxyPath, body, { Authorization: `Bearer ${w.token}` });
    process.stdout.write('.');
  }
  console.log(' done\n');

  // Reset rate-limit store after warmup so measurement workers start with a clean window
  __resetRateLimitStore();

  // ── 5. Measure downstream-only latency (baseline) ─────────────────────────
  const downstreamMeanMs = await measureDownstreamLatency(downstreamPort);

  // ── 6. Benchmark ─────────────────────────────────────────────────────
  console.log(`📊 Running ${TOTAL_MEASURED} measured requests (${CONCURRENCY} concurrent workers, 1 user each)...`);

  const allLatencies: number[] = [];
  const benchStart = process.hrtime.bigint();

  await Promise.all(
    workers.map(async (w, idx) => {
      const authHeader = { Authorization: `Bearer ${w.token}` };
      for (let i = 0; i < REQUESTS_PER_WORKER; i++) {
        const r = await httpPost('127.0.0.1', gatewayPort, proxyPath, body, authHeader);
        if (r.status !== 200) {
          console.warn(`  ⚠️  Unexpected status ${r.status} (worker ${idx})`);
        }
        allLatencies.push(r.latencyMs);
      }
    }),
  );

  const totalMs = Number(process.hrtime.bigint() - benchStart) / 1_000_000;

  // ── 7. Compute statistics ─────────────────────────────────────────────────
  allLatencies.sort((a, b) => a - b);
  const reqPerSec       = Math.round((TOTAL_MEASURED / totalMs) * 1000);
  const meanLatencyMs   = mean(allLatencies);
  const medianLatencyMs = percentile(allLatencies, 50);
  const p95LatencyMs    = percentile(allLatencies, 95);
  const p99LatencyMs    = percentile(allLatencies, 99);
  const minLatencyMs    = allLatencies[0];
  const maxLatencyMs    = allLatencies[allLatencies.length - 1];
  const gatewayOverhead = meanLatencyMs - downstreamMeanMs;

  // ── 8. Print results ───────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log(' MCP GATEWAY BENCHMARK RESULTS');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Total requests      : ${TOTAL_MEASURED}`);
  console.log(`  Concurrency         : ${CONCURRENCY} workers`);
  console.log(`  Wall-clock time     : ${totalMs.toFixed(0)} ms`);
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
  console.log(`  Downstream baseline : ${downstreamMeanMs.toFixed(2)} ms (stub MCP server, no auth)`);
  console.log(`  Gateway overhead    : ${gatewayOverhead.toFixed(2)} ms  ← JWT+RBAC+safety+vault+SQLite`);
  console.log('════════════════════════════════════════════════════════');
  console.log('');

  // ── 9. Teardown ────────────────────────────────────────────────────────────
  await stopServer(gatewayServer);
  await stopServer(downstreamServer);
  console.log('✅ Servers shut down. Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
