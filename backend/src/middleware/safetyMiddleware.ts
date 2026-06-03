/**
 * safetyMiddleware.ts  (Cycle-4 — fully implemented)
 *
 * Enforces three layers before every proxy tool call:
 *
 *  Layer 1 — Rate Limit:    max 20 tool calls per user per 60-second window
 *  Layer 2 — Blocklist:     reject if tool_name is in safety_blocklist table
 *  Layer 3 — Sanitization:  reject if any param value exceeds 10,000 chars
 *
 * Every call (allowed or blocked) is logged to tool_call_logs.
 * The proxy response is wrapped with a `safety` metadata object.
 */

import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from './auth.middleware';
import { getDatabase } from '../db/database';
import { AppError } from './errorHandler';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SafetyContext {
  serverId: string;
  toolName: string;
  params: Record<string, unknown>;
  userId: string;
  tenantId: string;
  logId: string;
}

export interface RateLimitInfo {
  remaining: number;
  resetAt: string;   // ISO timestamp when the window resets
  limit: number;
}

// Extend AuthRequest so downstream handlers can access safety data
export interface SafetyRequest extends AuthRequest {
  safetyContext?: SafetyContext;
  rateLimitInfo?: RateLimitInfo;
}

// ── In-memory rate limiter ────────────────────────────────────────────────────
// Sliding-window counter: { userId → { count, windowStart } }
// In production replace this with a Redis INCR + TTL approach.

const RATE_LIMIT_MAX = 20;
const RATE_WINDOW_MS = 60_000; // 1 minute

interface WindowEntry {
  count: number;
  windowStart: number;
}
const rateLimitStore = new Map<string, WindowEntry>();

function checkRateLimit(userId: string): RateLimitInfo {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    // Fresh window
    rateLimitStore.set(userId, { count: 1, windowStart: now });
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

// ── Blocklist check ───────────────────────────────────────────────────────────

function checkBlocklist(toolName: string): void {
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

function sanitizeParams(params: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      throw new AppError(
        400,
        `Parameter '${key}' exceeds the maximum allowed length of ${MAX_PARAM_LENGTH} characters (got ${value.length}).`,
      );
    }
    // Recurse into nested objects
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitizeParams(value as Record<string, unknown>);
    }
    // Check array string elements
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

// ── DB logging helpers ────────────────────────────────────────────────────────

function logToolCall(opts: {
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
    // Logging failures must never crash the request
    logger.error('Failed to write tool_call_log:', err);
  }
}

// ── Middleware: pre-call ──────────────────────────────────────────────────────

export function safetyRequestMiddleware(
  req: SafetyRequest,
  _res: Response,
  next: NextFunction,
): void {
  const body = req.body as Record<string, unknown>;
  const toolName  = (body?.['tool'] as string) ?? 'unknown';
  const params    = (body?.['params'] as Record<string, unknown>) ?? {};
  const serverId  = req.params['serverId'] ?? 'unknown';
  const userId    = req.user?.userId   ?? 'anonymous';
  const tenantId  = req.user?.tenantId ?? 'unknown';
  const logId     = uuidv4();

  const context: SafetyContext = { serverId, toolName, params, userId, tenantId, logId };
  req.safetyContext = context;

  try {
    // Layer 1 — Rate limit
    const rateLimitInfo = checkRateLimit(userId);
    req.rateLimitInfo = rateLimitInfo;

    // Layer 2 — Blocklist
    checkBlocklist(toolName);

    // Layer 3 — Input sanitization
    sanitizeParams(params);

    logger.info(
      `🛡️  Safety OK — user=${userId} tool=${toolName} remaining=${rateLimitInfo.remaining}`,
    );

    next();
  } catch (err) {
    // Log the blocked call before propagating
    const isAppError = err instanceof AppError;
    const blockReason = isAppError ? err.message : String(err);

    logToolCall({
      logId,
      userId,
      tenantId,
      serverId,
      toolName,
      inputParams: params,
      wasBlocked: true,
      blockReason,
    });

    logger.warn(`🚫 Safety BLOCKED — user=${userId} tool=${toolName} reason=${blockReason}`);
    next(err);
  }
}

// ── Middleware: post-call (logs successful result) ────────────────────────────

export function logSuccessfulCall(opts: {
  context: SafetyContext;
  output: unknown;
}): void {
  logToolCall({
    logId: opts.context.logId,
    userId: opts.context.userId,
    tenantId: opts.context.tenantId,
    serverId: opts.context.serverId,
    toolName: opts.context.toolName,
    inputParams: opts.context.params,
    output: opts.output,
    wasBlocked: false,
  });
}
