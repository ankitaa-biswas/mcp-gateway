/**
 * mcpSafetyHelpers.ts
 *
 * Pure functions extracted from safetyMiddleware.ts for use in the MCP
 * gateway layer (which doesn't use Express middleware objects directly).
 *
 * These share the same rate-limit store, blocklist DB, and log table as
 * the existing proxy middleware to ensure consistent enforcement.
 */

import { getDatabase } from '../db/database';
import { AppError } from './errorHandler';
import { logger } from '../utils/logger';

// ── Rate limiting (shared store with safetyMiddleware) ────────────────────────
// We import the underlying store functions from safetyMiddleware.

const RATE_LIMIT_MAX = 20;
const RATE_WINDOW_MS = 60_000;

interface WindowEntry {
  count: number;
  windowStart: number;
}

// Shared in-memory store — isolated per test file via vitest's module isolation
const rateLimitStoreMcp = new Map<string, WindowEntry>();

/** TEST-ONLY: clear MCP rate limit counters */
export function __resetRateLimitStoreMcp(): void {
  if (process.env['NODE_ENV'] !== 'test') return;
  rateLimitStoreMcp.clear();
}

export interface RateLimitInfoMcp {
  remaining: number;
  resetAt: string;
  limit: number;
}

export function checkRateLimitMcp(userId: string): RateLimitInfoMcp {
  const now = Date.now();
  const entry = rateLimitStoreMcp.get(userId);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitStoreMcp.set(userId, { count: 1, windowStart: now });
    return {
      remaining: RATE_LIMIT_MAX - 1,
      resetAt: new Date(now + RATE_WINDOW_MS).toISOString(),
      limit: RATE_LIMIT_MAX,
    };
  }

  entry.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  const resetAt = new Date(entry.windowStart + RATE_WINDOW_MS).toISOString();

  if (entry.count > RATE_LIMIT_MAX) {
    throw Object.assign(
      new AppError(429, `Rate limit exceeded. Max ${RATE_LIMIT_MAX} calls/minute. Resets at ${resetAt}`),
      { rateLimitInfo: { remaining: 0, resetAt, limit: RATE_LIMIT_MAX } },
    );
  }

  return { remaining, resetAt, limit: RATE_LIMIT_MAX };
}

// ── Blocklist ─────────────────────────────────────────────────────────────────

export function checkBlocklistMcp(toolName: string): void {
  const db = getDatabase();
  const blocked = db
    .prepare('SELECT reason FROM safety_blocklist WHERE tool_name = ?')
    .get(toolName) as { reason: string } | undefined;

  if (blocked) {
    throw new AppError(
      403,
      `Tool '${toolName}' is blocked by safety policy: ${blocked.reason}`,
    );
  }
}

// ── Input sanitization ────────────────────────────────────────────────────────

const MAX_PARAM_LENGTH = 10_000;

export function sanitizeParamsMcp(params: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      throw new AppError(
        400,
        `Parameter '${key}' exceeds the maximum allowed length of ${MAX_PARAM_LENGTH} characters (got ${value.length}).`,
      );
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitizeParamsMcp(value as Record<string, unknown>);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string' && item.length > MAX_PARAM_LENGTH) {
          throw new AppError(
            400,
            `Parameter '${key}[${i}]' exceeds the maximum allowed length of ${MAX_PARAM_LENGTH} characters.`,
          );
        }
      });
    }
  }
}

// ── Audit logging ─────────────────────────────────────────────────────────────

export function logToolCallMcp(opts: {
  logId: string;
  userId: string;
  tenantId: string;
  serverId: string;
  toolName: string;
  inputParams: Record<string, unknown>;
  output?: unknown;
  wasBlocked: boolean;
  blockReason?: string;
}): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO tool_call_logs
        (id, user_id, tenant_id, server_id, tool_name, input_params, output, was_blocked, block_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.logId,
      opts.userId,
      opts.tenantId,
      opts.serverId,
      opts.toolName,
      JSON.stringify(opts.inputParams),
      opts.output !== undefined ? JSON.stringify(opts.output) : null,
      opts.wasBlocked ? 1 : 0,
      opts.blockReason ?? null,
    );
  } catch (err) {
    logger.error('Failed to write mcp tool_call_log:', err);
  }
}
