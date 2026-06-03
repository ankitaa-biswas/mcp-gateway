import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';
import { searchTools, initializeIndex } from '../services/searchService';

export const mcpRouter = Router();
mcpRouter.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────
const CreateServerSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().url(),
  api_key: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
});

// ── GET /api/mcp/servers ──────────────────────────────────────────────────────
mcpRouter.get('/servers', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const servers = db
      .prepare(`
        SELECT id, name, base_url, is_active, capabilities, created_at
        FROM mcp_servers WHERE tenant_id = ?
      `)
      .all(req.user!.tenantId)
      .map((s) => {
        const row = s as Record<string, unknown>;
        return { ...row, capabilities: JSON.parse(row['capabilities'] as string) };
      });

    res.json(servers);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mcp/servers ─────────────────────────────────────────────────────
mcpRouter.post('/servers', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = CreateServerSchema.parse(req.body);
    const db = getDatabase();

    const id = uuidv4();

    // 1. Fetch tool schema from the downstream MCP server
    let toolSchemaString = '{}';
    try {
      const response = await fetch(`${body.base_url}/schema`);
      if (response.ok) {
        const json = await response.json();
        toolSchemaString = JSON.stringify(json);
      } else {
        console.warn(`[Gateway] Failed to fetch schema from ${body.base_url}: ${response.status}`);
      }
    } catch (e) {
      console.warn(`[Gateway] Network error fetching schema from ${body.base_url}`, e);
    }

    // 2. Insert into database
    db.prepare(`
      INSERT INTO mcp_servers (id, tenant_id, name, base_url, api_key, capabilities, tool_schema)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user!.tenantId, body.name, body.base_url, body.api_key ?? null, JSON.stringify(body.capabilities), toolSchemaString);

    res.status(201).json({
      id,
      name: body.name,
      base_url: body.base_url,
      capabilities: body.capabilities,
    });
    
    // Rebuild index to include new server's tools
    initializeIndex();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mcp/servers/:id ────────────────────────────────────────────────────
mcpRouter.get('/servers/:id', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const serverRow = db
      .prepare(`
        SELECT id, name, base_url, is_active, capabilities, tool_schema, created_at
        FROM mcp_servers WHERE id = ? AND tenant_id = ?
      `)
      .get(req.params.id, req.user!.tenantId) as Record<string, unknown> | undefined;

    if (!serverRow) {
      throw new AppError(404, 'MCP server not found');
    }

    const server = {
      ...serverRow,
      capabilities: JSON.parse(serverRow['capabilities'] as string),
      tool_schema: JSON.parse(serverRow['tool_schema'] as string)
    };

    res.json(server);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/mcp/servers/:id ───────────────────────────────────────────────
mcpRouter.delete('/servers/:id', requireRole('admin', 'superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const server = db
      .prepare('SELECT id, tenant_id FROM mcp_servers WHERE id = ?')
      .get(req.params.id) as { id: string; tenant_id: string } | undefined;

    if (!server) throw new AppError(404, 'MCP server not found');
    if (server.tenant_id !== req.user!.tenantId && req.user!.role !== 'superadmin') {
      throw new AppError(403, 'Cannot delete another tenant\'s server');
    }

    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
    res.status(204).send();
    
    // Rebuild index to remove deleted server's tools
    initializeIndex();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mcp/tools/search ──────────────────────────────────────────────────
mcpRouter.get('/tools/search', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const query = (req.query['q'] as string) || '';
    const results = searchTools(req.user!.tenantId, query);
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mcp/audit-logs ───────────────────────────────────────────────────
mcpRouter.get('/audit-logs', requireRole('admin', 'superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
    const db = getDatabase();

    const logs = db
      .prepare(`
        SELECT al.id, al.action, al.resource, al.metadata, al.created_at,
               u.email as user_email
        FROM audit_logs al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE al.tenant_id = ?
        ORDER BY al.created_at DESC
        LIMIT ?
      `)
      .all(req.user!.tenantId, limit);

    res.json(logs);
  } catch (err) {
    next(err);
  }
});
