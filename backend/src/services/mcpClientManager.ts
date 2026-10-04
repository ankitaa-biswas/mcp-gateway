/**
 * mcpClientManager.ts
 *
 * Manages MCP client connections to downstream MCP servers.
 *
 * Supports two downstream transport types:
 *   - "stdio"   → spawns a local child process, communicates via stdin/stdout
 *   - "http"    → connects via Streamable HTTP to a remote MCP server
 *
 * Each downstream server entry in the DB carries:
 *   transport_type: 'stdio' | 'http' | 'legacy_http'
 *   stdio_command / stdio_args: for stdio servers
 *   base_url: for http servers
 *
 * The manager caches a Client instance per server-ID.
 * On first access it connects & calls initialize().
 *
 * Tool discovery (tools/list) is performed eagerly on connect and
 * cached in _toolRegistry. This is re-populated on demand.
 *
 * Thread-safety note: Node.js is single-threaded; concurrent async
 * init races are guarded by _pendingConnects.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DownstreamToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  serverName: string;
  /** Disambiguated name exposed on the gateway (e.g. "alpha__search") */
  gatewayName: string;
}

export interface DownstreamServerConfig {
  id: string;
  name: string;
  transport_type: 'stdio' | 'http' | 'legacy_http';
  base_url?: string;
  stdio_command?: string;
  stdio_args?: string[];
  stdio_env?: Record<string, string>;
  tenant_id: string;
  is_active: boolean;
}

// ── Manager singleton ─────────────────────────────────────────────────────────

class McpClientManager {
  /** serverId → connected Client */
  private _clients = new Map<string, Client>();
  /** pendingConnects prevents duplicate init races */
  private _pendingConnects = new Map<string, Promise<Client>>();
  /**
   * gatewayToolName → { serverId, serverName, originalName }
   * This is the routing table for tools/call.
   */
  private _toolRoute = new Map<string, { serverId: string; serverName: string; originalName: string }>();
  /** tenantId → DownstreamToolInfo[] */
  private _tenantTools = new Map<string, DownstreamToolInfo[]>();

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Get-or-create an MCP Client connected to the given downstream server.
   * Returns null if the server type is 'legacy_http' (non-MCP).
   */
  async getClient(cfg: DownstreamServerConfig, apiKey?: string): Promise<Client | null> {
    if (cfg.transport_type === 'legacy_http') return null;

    const cacheKey = apiKey ? `${cfg.id}:${apiKey}` : cfg.id;
    if (this._clients.has(cacheKey)) return this._clients.get(cacheKey)!;
    if (this._pendingConnects.has(cacheKey)) return this._pendingConnects.get(cacheKey)!;

    const connectPromise = this._connect(cfg, apiKey);
    this._pendingConnects.set(cacheKey, connectPromise);

    try {
      const client = await connectPromise;
      this._clients.set(cacheKey, client);
      return client;
    } finally {
      this._pendingConnects.delete(cacheKey);
    }
  }

  /**
   * Discover all tools from a downstream server and register them in the routing table.
   * Returns the list of tools or [] on failure.
   */
  async discoverTools(cfg: DownstreamServerConfig): Promise<DownstreamToolInfo[]> {
    if (cfg.transport_type === 'legacy_http') {
      // legacy_http servers don't speak real MCP; we read their schema from the DB instead
      return [];
    }

    let client: Client;
    try {
      const c = await this.getClient(cfg);
      if (!c) return [];
      client = c;
    } catch (err) {
      logger.warn(`[MCP Client Manager] Cannot connect to downstream ${cfg.name}: ${err}`);
      return [];
    }

    try {
      const result = await client.listTools();
      const tools: DownstreamToolInfo[] = [];

      for (const t of result.tools) {
        const gatewayName = this._makeGatewayName(cfg.name, t.name);
        const info: DownstreamToolInfo = {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          serverId: cfg.id,
          serverName: cfg.name,
          gatewayName,
        };
        tools.push(info);
        // Register route
        this._toolRoute.set(gatewayName, {
          serverId: cfg.id,
          serverName: cfg.name,
          originalName: t.name,
        });
      }

      // Update tenant tool list
      const existing = this._tenantTools.get(cfg.tenant_id) ?? [];
      // Remove old tools for this server, then add fresh
      const filtered = existing.filter(t => t.serverId !== cfg.id);
      this._tenantTools.set(cfg.tenant_id, [...filtered, ...tools]);

      logger.info(`[MCP Client Manager] Discovered ${tools.length} tools from ${cfg.name}`);
      return tools;
    } catch (err) {
      logger.warn(`[MCP Client Manager] tools/list failed for ${cfg.name}: ${err}`);
      return [];
    }
  }

  /**
   * Call a tool on the correct downstream server.
   * gatewayToolName must be the namespaced form (e.g. "alpha__search").
   * Returns the MCP CallTool result content.
   */
  async callTool(
    gatewayToolName: string,
    args: Record<string, unknown>,
    cfg?: DownstreamServerConfig,
    apiKey?: string,
  ): Promise<{ content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean }> {
    const route = this._toolRoute.get(gatewayToolName);
    if (!route) {
      throw new Error(`Unknown gateway tool: ${gatewayToolName}`);
    }

    const cacheKey = apiKey ? `${route.serverId}:${apiKey}` : route.serverId;
    let client = this._clients.get(cacheKey);
    if (!client && cfg) {
      const connected = await this.getClient(cfg, apiKey);
      if (connected) client = connected;
    }

    if (!client) {
      throw new Error(`No connected client for server ${route.serverName} (${route.serverId})`);
    }

    const result = await client.callTool({
      name: route.originalName,
      arguments: args,
    });

    return result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  }

  /**
   * Get all tools visible to a tenant (from all their connected servers).
   */
  getToolsForTenant(tenantId: string): DownstreamToolInfo[] {
    return this._tenantTools.get(tenantId) ?? [];
  }

  /**
   * Look up routing info for a gateway tool name.
   */
  getRoute(gatewayToolName: string) {
    return this._toolRoute.get(gatewayToolName) ?? null;
  }

  /**
   * Disconnect a specific server and clean up its routes.
   */
  async disconnectServer(serverId: string, tenantId?: string): Promise<void> {
    for (const [key, client] of this._clients.entries()) {
      if (key === serverId || key.startsWith(`${serverId}:`)) {
        try { await client.close(); } catch { /* ignore */ }
        this._clients.delete(key);
      }
    }

    // Remove all routes for this server
    for (const [key, route] of this._toolRoute.entries()) {
      if (route.serverId === serverId) this._toolRoute.delete(key);
    }

    // Remove from tenant tool list
    if (tenantId) {
      const existing = this._tenantTools.get(tenantId) ?? [];
      this._tenantTools.set(tenantId, existing.filter(t => t.serverId !== serverId));
    }
  }

  /**
   * Close all connected clients and clear routing tables.
   */
  async closeAll(): Promise<void> {
    for (const [key, client] of this._clients.entries()) {
      try { await client.close(); } catch { /* ignore */ }
      this._clients.delete(key);
    }
    this._toolRoute.clear();
    this._tenantTools.clear();
  }

  /**
   * Register legacy tools (from tool_schema stored in DB) into the routing table.
   * Used for backward-compat HTTP servers that aren't real MCP.
   */
  registerLegacyTools(cfg: DownstreamServerConfig, toolNames: string[]): DownstreamToolInfo[] {
    const tools: DownstreamToolInfo[] = [];
    for (const name of toolNames) {
      const gatewayName = this._makeGatewayName(cfg.name, name);
      const info: DownstreamToolInfo = {
        name,
        serverId: cfg.id,
        serverName: cfg.name,
        gatewayName,
      };
      tools.push(info);
      this._toolRoute.set(gatewayName, {
        serverId: cfg.id,
        serverName: cfg.name,
        originalName: name,
      });
    }

    const existing = this._tenantTools.get(cfg.tenant_id) ?? [];
    const filtered = existing.filter(t => t.serverId !== cfg.id);
    this._tenantTools.set(cfg.tenant_id, [...filtered, ...tools]);

    return tools;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _connect(cfg: DownstreamServerConfig, apiKey?: string): Promise<Client> {
    const client = new Client(
      { name: 'mcp-gateway', version: '1.0.0' },
      { capabilities: {} },
    );

    let transport;
    if (cfg.transport_type === 'stdio') {
      if (!cfg.stdio_command) throw new Error(`stdio_command required for stdio server ${cfg.name}`);
      transport = new StdioClientTransport({
        command: cfg.stdio_command,
        args: cfg.stdio_args ?? [],
        env: {
          ...process.env,
          ...(cfg.stdio_env ?? {}),
          ...(apiKey ? { MCP_API_KEY: apiKey } : {}),
        } as Record<string, string>,
        stderr: 'pipe',
      });
    } else if (cfg.transport_type === 'http') {
      if (!cfg.base_url) throw new Error(`base_url required for http server ${cfg.name}`);
      const opts: { requestInit?: RequestInit } = {};
      if (apiKey) {
        opts.requestInit = {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        };
      }
      transport = new StreamableHTTPClientTransport(new URL(cfg.base_url), opts);
    } else {
      throw new Error(`Unsupported transport_type: ${cfg.transport_type}`);
    }

    await client.connect(transport);
    logger.info(`[MCP Client Manager] Connected to downstream ${cfg.name} via ${cfg.transport_type}`);
    return client;
  }

  /**
   * Create a safe, unique gateway tool name.
   * Format: "<serverSlug>__<toolName>"
   * This prevents cross-server collisions when two servers expose the same tool name.
   */
  private _makeGatewayName(serverName: string, toolName: string): string {
    const slug = serverName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30);
    return `${slug}__${toolName}`;
  }
}

// Export singleton
export const mcpClientManager = new McpClientManager();
