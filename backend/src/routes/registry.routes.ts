import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { seedRegistry } from '../db/registrySeeder';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';

export const registryRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ServerRow {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  capabilities: string;
  tool_schema: string;
  owner_id: string | null;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  transport_type: string | null;
  stdio_command: string | null;
  stdio_args: string | null;
  stdio_env: string | null;
}

function parseServer(row: ServerRow) {
  return {
    ...row,
    is_active: Boolean(row.is_active),
    capabilities: JSON.parse(row.capabilities) as string[],
    tool_schema: JSON.parse(row.tool_schema) as Record<string, unknown>,
    transport_type: row.transport_type ?? 'legacy_http',
    stdio_args: row.stdio_args ? (JSON.parse(row.stdio_args) as string[]) : null,
  };
}

// ── Validation schemas ────────────────────────────────────────────────────────

const RegisterServerSchema = z.object({
  name: z.string().min(1).max(120),
  base_url: z.string().url('base_url must be a valid URL'),
  capabilities: z.array(z.string()).default([]),
  tool_schema: z.record(z.unknown()).default({}),
  // MCP transport configuration (v2)
  transport_type: z.enum(['stdio', 'http', 'legacy_http']).default('legacy_http'),
  stdio_command: z.string().optional(),
  stdio_args: z.array(z.string()).optional(),
  // stdio_env is intentionally NOT accepted in body — provide via server config, not client-supplied JSON
});

// ── GET /api/servers ─────────────────────────────────────────────────────────
/**
 * List all active MCP servers visible to the authenticated user's tenant.
 * Public within tenant — no admin role required.
 */
registryRouter.get('/', authenticate, (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();

    // Try seeding lazily if no servers exist yet
    const count = (db.prepare('SELECT COUNT(*) as c FROM mcp_servers WHERE tenant_id = ?').get(req.user!.tenantId) as { c: number }).c;
    if (count === 0) {
      // Seed requires a real user — skip silently if user doesn't exist yet
      try {
        seedRegistry(req.user!.tenantId, req.user!.userId);
      } catch {
        // Will seed after first real user is created
      }
    }

    const rows = db
      .prepare(`
        SELECT id, name, base_url, is_active, capabilities, tool_schema,
               owner_id, tenant_id, created_at, updated_at
        FROM mcp_servers
        WHERE tenant_id = ? AND is_active = 1
        ORDER BY name ASC
      `)
      .all(req.user!.tenantId) as ServerRow[];

    res.json(rows.map(parseServer));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/servers/:id ─────────────────────────────────────────────────────
/**
 * Get full details for a single MCP server including its tool schema.
 */
registryRouter.get('/:id', authenticate, (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();

    const row = db
      .prepare(`
        SELECT id, name, base_url, is_active, capabilities, tool_schema,
               owner_id, tenant_id, created_at, updated_at
        FROM mcp_servers
        WHERE id = ? AND tenant_id = ?
      `)
      .get(req.params['id'], req.user!.tenantId) as ServerRow | undefined;

    if (!row) throw new AppError(404, `MCP server '${req.params['id']}' not found`);

    res.json(parseServer(row));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/servers ─────────────────────────────────────────────────────────
/**
 * Register a new MCP server in the registry (admin only).
 * The registering user becomes the owner_id.
 */
registryRouter.post(
  '/',
  authenticate,
  requireRole('admin', 'superadmin'),
  (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const body = RegisterServerSchema.parse(req.body);
      const db = getDatabase();

      const id = uuidv4();
      db.prepare(`
        INSERT INTO mcp_servers
          (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id,
           transport_type, stdio_command, stdio_args)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.user!.tenantId,
        body.name,
        body.base_url,
        JSON.stringify(body.capabilities),
        JSON.stringify(body.tool_schema),
        req.user!.userId,
        body.transport_type,
        body.stdio_command ?? null,
        body.stdio_args ? JSON.stringify(body.stdio_args) : null,
      );

      const created = db
        .prepare('SELECT * FROM mcp_servers WHERE id = ?')
        .get(id) as ServerRow;

      res.status(201).json(parseServer(created));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/servers/seed ────────────────────────────────────────────────────
/**
 * Manually trigger the registry seed (admin only, idempotent).
 * Useful for development reset.
 */
registryRouter.post(
  '/seed',
  authenticate,
  requireRole('admin', 'superadmin'),
  (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // Reset seed flag first so seedRegistry will run
      const db = getDatabase();
      db.prepare("DELETE FROM _seed_flags WHERE key = 'registry_v1'").run();

      seedRegistry(req.user!.tenantId, req.user!.userId);
      res.json({ message: 'Registry seeded with 5 demo MCP servers' });
    } catch (err) {
      next(err);
    }
  },
);
