/**
 * proxy.routes.ts
 *
 * POST /api/proxy/:serverId/call
 *
 * Flow:
 *  1. authenticate           → verify JWT
 *  2. requireRole            → only 'analyst' and 'admin' can call tools
 *  3. safetyRequestMiddleware → rate limit + blocklist + sanitize + log
 *  4. Look up MCP server     → base_url + tool_schema
 *  5. Retrieve vault key     → decrypt API key
 *  6. Forward to MCP server  → POST with auth header
 *  7. Log success            → write output to tool_call_logs
 *  8. Return safety envelope → { result, safety: { rateLimit, logged } }
 */

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.middleware';
import {
  safetyRequestMiddleware,
  logSuccessfulCall,
  SafetyRequest,
} from '../middleware/safetyMiddleware';
import { getKey } from '../services/vaultService';
import { getDatabase } from '../db/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export const proxyRouter = Router();

// ── Validation schema ─────────────────────────────────────────────────────────

const ProxyCallSchema = z.object({
  tool: z.string().min(1, 'tool name is required'),
  params: z.record(z.unknown()).default({}),
  auth_scheme: z.enum(['bearer', 'api_key', 'none']).default('bearer'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ServerRow {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  tool_schema: string;
  tenant_id: string;
}

async function forwardToMcpServer(
  baseUrl: string,
  apiKey: string,
  tool: string,
  params: Record<string, unknown>,
  authScheme: string,
): Promise<unknown> {
  const endpoint = `${baseUrl}/call`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'MCP-Gateway/1.0',
  };

  if (authScheme === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (authScheme === 'api_key') {
    headers['X-API-Key'] = apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool, params }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') ?? '';
    const responseBody = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new AppError(
        response.status >= 500 ? 502 : response.status,
        `MCP server returned ${response.status}: ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`,
      );
    }

    return responseBody;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof AppError) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new AppError(504, 'MCP server request timed out after 15 seconds');
    }
    throw new AppError(502, `Unable to reach MCP server: ${msg}`);
  }
}

// ── POST /api/proxy/:serverId/call ────────────────────────────────────────────

proxyRouter.post(
  '/:serverId/call',
  authenticate,
  requireRole('analyst', 'admin'),    // viewers cannot call tools
  safetyRequestMiddleware,            // rate limit + blocklist + sanitize
  async (req: SafetyRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { serverId } = req.params;
      const { tool, params, auth_scheme } = ProxyCallSchema.parse(req.body);
      const userId   = req.user!.userId;
      const tenantId = req.user!.tenantId;
      const db = getDatabase();

      // ── 1. Resolve server ─────────────────────────────────────────────────
      const server = db
        .prepare(`
          SELECT id, name, base_url, is_active, tool_schema, tenant_id
          FROM mcp_servers
          WHERE id = ? AND tenant_id = ?
        `)
        .get(serverId, tenantId) as ServerRow | undefined;

      if (!server) throw new AppError(404, `MCP server '${serverId}' not found`);
      if (!server.is_active) throw new AppError(503, `MCP server '${server.name}' is inactive`);

      // ── 2. Retrieve vault key ─────────────────────────────────────────────
      let apiKey: string;
      try {
        apiKey = getKey(userId, serverId);
      } catch {
        throw new AppError(
          403,
          `No API key stored for server '${server.name}'. ` +
          `Store one via POST /api/vault/store before calling this server.`,
        );
      }

      // ── 3. Advisory tool schema validation ───────────────────────────────
      const toolSchema = JSON.parse(server.tool_schema) as { tools?: Array<{ name: string }> };
      const knownTools = toolSchema.tools?.map((t) => t.name) ?? [];
      if (knownTools.length > 0 && !knownTools.includes(tool)) {
        throw new AppError(
          400,
          `Tool '${tool}' is not registered on '${server.name}'. Available: ${knownTools.join(', ')}`,
        );
      }

      logger.info(`📡 Proxying tool call  user=${userId} server=${server.name} tool=${tool}`);

      // ── 4. Forward to MCP server ──────────────────────────────────────────
      const startMs = Date.now();
      const mcpResponse = await forwardToMcpServer(
        server.base_url, apiKey, tool, params, auth_scheme,
      );
      const durationMs = Date.now() - startMs;

      // ── 5. Log success to tool_call_logs ──────────────────────────────────
      if (req.safetyContext) {
        logSuccessfulCall({ context: req.safetyContext, output: mcpResponse });
      }

      logger.info(`✅ Proxy complete  tool=${tool} duration=${durationMs}ms`);

      // ── 6. Return safety-enriched response ───────────────────────────────
      res.json({
        server_id: serverId,
        server_name: server.name,
        tool,
        duration_ms: durationMs,
        result: mcpResponse,
        safety: {
          rateLimit: req.rateLimitInfo ?? null,
          logged: true,
          log_id: req.safetyContext?.logId,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
