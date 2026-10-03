/**
 * mcpGateway.routes.ts
 *
 * Exposes a real MCP Server endpoint at POST /mcp (Streamable HTTP transport).
 *
 * This is the central piece of the migration. Instead of the old custom
 * POST /api/proxy/:serverId/call protocol, MCP clients now speak genuine
 * MCP JSON-RPC to this endpoint.
 *
 * Architecture:
 *   MCP Client → POST /mcp → McpServer (SDK)
 *                              ├── tools/list  → aggregated from all downstream servers
 *                              └── tools/call  → dispatched through mcpClientManager
 *
 * Security layers applied per tools/call (in order):
 *   1. JWT authentication     — via X-Auth-Token or Authorization header
 *   2. Tenant/role RBAC       — only analyst/admin can call tools
 *   3. Server authorization   — tool must belong to caller's tenant
 *   4. Blocklist/policy       — reject globally blocked tools
 *   5. Input sanitization     — max parameter length
 *   6. Per-user rate limiting  — 20 calls/minute (same limiter as proxy)
 *   7. Credential resolution  — from AES-256-GCM vault
 *   8. Downstream MCP call    — via mcpClientManager
 *   9. Audit log              — writes to tool_call_logs
 *
 * The transport is stateless (sessionIdGenerator: undefined) to keep
 * it compatible with load-balanced deployments.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import { verifyToken } from '../utils/jwt';
import { getDatabase } from '../db/database';
import { getKey } from '../services/vaultService';
import { mcpClientManager, DownstreamServerConfig } from '../services/mcpClientManager';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  checkRateLimitMcp,
  checkBlocklistMcp,
  sanitizeParamsMcp,
  logToolCallMcp,
} from '../middleware/mcpSafetyHelpers';

export const mcpGatewayRouter = Router();

// ── Types ──────────────────────────────────────────────────────────────────────

interface ServerRow {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  tool_schema: string;
  tenant_id: string;
  transport_type: string | null;
  stdio_command: string | null;
  stdio_args: string | null;
  stdio_env: string | null;
}

interface UserContext {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

// ── Auth helper ────────────────────────────────────────────────────────────────

function extractUser(req: Request): UserContext | null {
  // Accept Bearer token from Authorization header or X-Auth-Token
  const authHeader = req.headers['authorization'] ?? req.headers['x-auth-token'] as string;
  if (!authHeader) return null;

  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader as string;

  try {
    const payload = verifyToken(token);
    return {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

// ── Downstream server loading ──────────────────────────────────────────────────

function loadServerConfig(serverId: string, tenantId: string): DownstreamServerConfig | null {
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT id, name, base_url, is_active, tool_schema, tenant_id,
             transport_type, stdio_command, stdio_args, stdio_env
      FROM mcp_servers
      WHERE id = ? AND tenant_id = ?
    `)
    .get(serverId, tenantId) as ServerRow | undefined;

  if (!row || !row.is_active) return null;

  const transportType = (row.transport_type ?? 'legacy_http') as DownstreamServerConfig['transport_type'];

  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    is_active: Boolean(row.is_active),
    transport_type: transportType,
    stdio_command: row.stdio_command ?? undefined,
    stdio_args: row.stdio_args ? (JSON.parse(row.stdio_args) as string[]) : undefined,
    stdio_env: row.stdio_env ? (JSON.parse(row.stdio_env) as Record<string, string>) : undefined,
    tenant_id: row.tenant_id,
  };
}

function loadAllServersForTenant(tenantId: string): ServerRow[] {
  const db = getDatabase();
  return db
    .prepare(`
      SELECT id, name, base_url, is_active, tool_schema, tenant_id,
             transport_type, stdio_command, stdio_args, stdio_env
      FROM mcp_servers
      WHERE tenant_id = ? AND is_active = 1
    `)
    .all(tenantId) as ServerRow[];
}

// ── Build the aggregated tools list for a tenant ───────────────────────────────

async function buildToolsList(tenantId: string): Promise<Array<{
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}>> {
  const servers = loadAllServersForTenant(tenantId);
  const tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];

  for (const row of servers) {
    const transportType = (row.transport_type ?? 'legacy_http') as DownstreamServerConfig['transport_type'];
    const cfg: DownstreamServerConfig = {
      id: row.id,
      name: row.name,
      base_url: row.base_url,
      is_active: Boolean(row.is_active),
      transport_type: transportType,
      stdio_command: row.stdio_command ?? undefined,
      stdio_args: row.stdio_args ? (JSON.parse(row.stdio_args) as string[]) : undefined,
      stdio_env: row.stdio_env ? (JSON.parse(row.stdio_env) as Record<string, string>) : undefined,
      tenant_id: row.tenant_id,
    };

    if (transportType === 'stdio' || transportType === 'http') {
      // Real MCP server — discover via tools/list
      const discovered = await mcpClientManager.discoverTools(cfg);
      for (const t of discovered) {
        tools.push({
          name: t.gatewayName,
          description: t.description ?? `Tool from ${t.serverName}`,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    } else {
      // Legacy HTTP server — use stored tool_schema
      const schema = JSON.parse(row.tool_schema) as { tools?: Array<{ name: string; description?: string }> };
      const legacyTools = schema.tools ?? [];
      const infos = mcpClientManager.registerLegacyTools(cfg, legacyTools.map(t => t.name));
      for (const info of infos) {
        const legacyTool = legacyTools.find(t => t.name === info.name);
        tools.push({
          name: info.gatewayName,
          description: legacyTool?.description ?? `Tool from ${info.serverName}`,
          inputSchema: { type: 'object' as const, properties: {} },
        });
      }
    }
  }

  return tools;
}

// ── MCP Server factory ─────────────────────────────────────────────────────────

/**
 * Creates a fresh McpServer instance for a single request.
 *
 * We create a new McpServer per-request because:
 *  1. We need to scope tools to the authenticated tenant
 *  2. The stateless transport has no persistent session to re-use
 *
 * For tools/list we do dynamic discovery; for tools/call we perform
 * the full security pipeline before forwarding downstream.
 */
async function createMcpServerForRequest(user: UserContext): Promise<McpServer> {
  const server = new McpServer(
    { name: 'mcp-gateway', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // ── tools/list: dynamically scoped to tenant ──────────────────────────────
  // We override the default list handler by registering tools dynamically.
  // McpServer aggregates registered tools for the list response automatically.

  const tenantTools = await buildToolsList(user.tenantId);

  for (const toolDef of tenantTools) {
    (server as any).registerTool(
      toolDef.name,
      {
        description: toolDef.description,
        inputSchema: z.record(z.unknown()),
      },
      async (args: Record<string, unknown>) => {
        // ── Security pipeline for tools/call ─────────────────────────────────
        const logId = uuidv4();
        const gatewayToolName = toolDef.name;

        // 1. RBAC — only analyst / admin can call tools
        if (!['analyst', 'admin', 'superadmin'].includes(user.role)) {
          throw new Error(`Role '${user.role}' is not authorized to call tools`);
        }

        // 2. Resolve which server owns this tool
        const route = mcpClientManager.getRoute(gatewayToolName);
        if (!route) {
          throw new Error(`Tool '${gatewayToolName}' is not routable`);
        }

        // 3. Server authorization — verify server belongs to tenant
        const serverCfg = loadServerConfig(route.serverId, user.tenantId);
        if (!serverCfg) {
          throw new Error(`Server for tool '${gatewayToolName}' not found or inactive`);
        }

        const params = (args ?? {}) as Record<string, unknown>;

        // 4. Blocklist / policy
        try {
          checkBlocklistMcp(route.originalName);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logToolCallMcp({
            logId, userId: user.userId, tenantId: user.tenantId,
            serverId: route.serverId, toolName: route.originalName,
            inputParams: params, wasBlocked: true, blockReason: reason,
          });
          throw err;
        }

        // 5. Input sanitization
        try {
          sanitizeParamsMcp(params);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logToolCallMcp({
            logId, userId: user.userId, tenantId: user.tenantId,
            serverId: route.serverId, toolName: route.originalName,
            inputParams: params, wasBlocked: true, blockReason: reason,
          });
          throw err;
        }

        // 6. Rate limiting
        try {
          checkRateLimitMcp(user.userId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logToolCallMcp({
            logId, userId: user.userId, tenantId: user.tenantId,
            serverId: route.serverId, toolName: route.originalName,
            inputParams: params, wasBlocked: true, blockReason: reason,
          });
          throw err;
        }

        // 7. Credential resolution
        let apiKey: string | null = null;
        try {
          apiKey = getKey(user.userId, route.serverId);
        } catch {
          if (serverCfg.transport_type === 'legacy_http') {
            const msg = `No API key stored for server '${serverCfg.name}'`;
            logToolCallMcp({
              logId, userId: user.userId, tenantId: user.tenantId,
              serverId: route.serverId, toolName: route.originalName,
              inputParams: params, wasBlocked: true, blockReason: msg,
            });
            throw new Error(msg);
          }
        }

        // 8. Downstream call
        const startMs = Date.now();
        let result: unknown;
        try {
          if (serverCfg.transport_type === 'legacy_http') {
            // Forward to legacy /call endpoint
            result = await callLegacyHttpServer(serverCfg.base_url!, apiKey!, route.originalName, params);
          } else {
            // Real MCP call via client manager
            result = await mcpClientManager.callTool(gatewayToolName, params, serverCfg, apiKey ?? undefined);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logToolCallMcp({
            logId, userId: user.userId, tenantId: user.tenantId,
            serverId: route.serverId, toolName: route.originalName,
            inputParams: params, output: { error: reason }, wasBlocked: false,
          });
          throw err;
        }

        const durationMs = Date.now() - startMs;

        // 9. Audit log
        logToolCallMcp({
          logId, userId: user.userId, tenantId: user.tenantId,
          serverId: route.serverId, toolName: route.originalName,
          inputParams: params, output: result, wasBlocked: false,
        });

        logger.info(`✅ MCP tools/call: ${gatewayToolName} user=${user.userId} duration=${durationMs}ms`);

        // Return MCP-formatted result
        if (result && typeof result === 'object' && 'content' in result) {
          const resObj = result as { content: Array<{ type: string; [k: string]: unknown }>; isError?: boolean };
          return {
            content: resObj.content,
            ...(resObj.isError !== undefined ? { isError: resObj.isError } : {}),
          };
        }
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string'
              ? result
              : JSON.stringify(result),
          }],
        };
      }
    );
  }

  return server;
}

// ── Legacy HTTP fallback ───────────────────────────────────────────────────────

async function callLegacyHttpServer(
  baseUrl: string,
  apiKey: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = `${baseUrl}/call`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'MCP-Gateway/2.0',
      },
      body: JSON.stringify({ tool, params }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      throw new AppError(
        response.status >= 500 ? 502 : response.status,
        `Legacy MCP server returned ${response.status}: ${body}`,
      );
    }

    const ct = response.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? response.json() : response.text();
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new AppError(504, 'Legacy MCP server request timed out');
    }
    throw new AppError(502, `Unable to reach legacy MCP server: ${msg}`);
  }
}

// ── POST /mcp  ─────────────────────────────────────────────────────────────────
// Single endpoint — the Streamable HTTP transport handles both GET (SSE) and POST.

mcpGatewayRouter.all('/', async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  // 1. Authenticate
  const user = extractUser(req);
  if (!user) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Unauthorized: valid Bearer token required' },
      id: null,
    });
    return;
  }

  logger.info(`[MCP Gateway] Request from user=${user.userId} tenant=${user.tenantId}`);

  try {
    // 2. Create a per-request McpServer with tenant-scoped tools
    const mcpServer = await createMcpServerForRequest(user);

    // 3. Create a stateless Streamable HTTP transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });

    // 4. Connect and handle request
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Cleanup after response
    res.on('finish', () => {
      mcpServer.close().catch(() => {});
    });
  } catch (err) {
    logger.error('[MCP Gateway] Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});
