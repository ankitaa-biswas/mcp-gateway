/**
 * admin.routes.ts
 *
 * Routes:
 *   GET  /api/admin/logs               → paginated list of all tool_call_logs
 *   GET  /api/admin/logs/:userId       → logs filtered by a specific user
 *   POST /api/admin/blocklist          → add a tool name to the safety blocklist
 *   GET  /api/admin/blocklist          → list all blocklisted tools
 *   DELETE /api/admin/blocklist/:name  → remove a tool from the blocklist
 *
 * All routes require: authenticate + requireRole('admin')
 */

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth.middleware';
import { getDatabase } from '../db/database';
import { AppError } from '../middleware/errorHandler';
import { seedDemoUsers } from '../db/userSeeder';

export const adminRouter = Router();

// Apply auth + admin role to every route in this router
adminRouter.use(authenticate, requireRole('admin'));

// ── Pagination helper ─────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>) {
  const limit = Math.min(Math.max(1, Number(query['limit'] ?? 50)), 200);
  const offset = Math.max(0, Number(query['offset'] ?? 0));
  return { limit, offset };
}

function formatLog(row: Record<string, unknown>) {
  return {
    ...row,
    input_params: (() => { try { return JSON.parse(row['input_params'] as string); } catch { return {}; } })(),
    output: row['output'] ? (() => { try { return JSON.parse(row['output'] as string); } catch { return row['output']; } })() : null,
    was_blocked: Boolean(row['was_blocked']),
  };
}

// ── GET /api/admin/logs ───────────────────────────────────────────────────────

adminRouter.get('/logs', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const tenantId = req.user!.tenantId;
    const db = getDatabase();

    const rows = db
      .prepare(`
        SELECT
          l.id, l.user_id, l.server_id, l.tool_name,
          l.input_params, l.output, l.timestamp,
          l.was_blocked, l.block_reason,
          u.email AS user_email
        FROM tool_call_logs l
        LEFT JOIN users u ON l.user_id = u.id
        WHERE l.tenant_id = ?
        ORDER BY l.timestamp DESC
        LIMIT ? OFFSET ?
      `)
      .all(tenantId, limit, offset) as Record<string, unknown>[];

    const total = (
      db.prepare('SELECT COUNT(*) as c FROM tool_call_logs WHERE tenant_id = ?').get(tenantId) as { c: number }
    ).c;

    res.json({
      data: rows.map(formatLog),
      pagination: { limit, offset, total, has_more: offset + rows.length < total },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/logs/:userId ───────────────────────────────────────────────

adminRouter.get('/logs/:userId', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const { userId } = req.params;
    const tenantId = req.user!.tenantId;
    const db = getDatabase();

    // Verify the target user belongs to this tenant
    const targetUser = db
      .prepare('SELECT id, email, role FROM users WHERE id = ? AND tenant_id = ?')
      .get(userId, tenantId) as { id: string; email: string; role: string } | undefined;

    if (!targetUser) throw new AppError(404, `User '${userId}' not found in your tenant`);

    const rows = db
      .prepare(`
        SELECT
          l.id, l.user_id, l.server_id, l.tool_name,
          l.input_params, l.output, l.timestamp,
          l.was_blocked, l.block_reason
        FROM tool_call_logs l
        WHERE l.user_id = ? AND l.tenant_id = ?
        ORDER BY l.timestamp DESC
        LIMIT ? OFFSET ?
      `)
      .all(userId, tenantId, limit, offset) as Record<string, unknown>[];

    const total = (
      db.prepare('SELECT COUNT(*) as c FROM tool_call_logs WHERE user_id = ? AND tenant_id = ?')
        .get(userId, tenantId) as { c: number }
    ).c;

    res.json({
      user: targetUser,
      data: rows.map(formatLog),
      pagination: { limit, offset, total, has_more: offset + rows.length < total },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/blocklist ─────────────────────────────────────────────────

const BlocklistAddSchema = z.object({
  tool_name: z.string().min(1).max(120),
  reason: z.string().min(1).max(500).default('Added by admin'),
});

adminRouter.post('/blocklist', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { tool_name, reason } = BlocklistAddSchema.parse(req.body);
    const db = getDatabase();

    db.prepare(`
      INSERT INTO safety_blocklist (tool_name, reason, added_by)
      VALUES (?, ?, ?)
      ON CONFLICT(tool_name) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by
    `).run(tool_name, reason, req.user!.userId);

    res.status(201).json({
      message: `Tool '${tool_name}' added to safety blocklist`,
      tool_name,
      reason,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/blocklist ──────────────────────────────────────────────────

adminRouter.get('/blocklist', (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT tool_name, reason, added_by, added_at FROM safety_blocklist ORDER BY added_at DESC')
      .all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/admin/blocklist/:name ─────────────────────────────────────────

adminRouter.delete('/blocklist/:name', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const toolName = req.params['name'];
    const db = getDatabase();
    const result = db.prepare('DELETE FROM safety_blocklist WHERE tool_name = ?').run(toolName);

    if (result.changes === 0) {
      throw new AppError(404, `Tool '${toolName}' is not in the blocklist`);
    }

    res.json({ message: `Tool '${toolName}' removed from blocklist` });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/seed-users ────────────────────────────────────────────────
// Dev convenience: seed demo users (admin / analyst / viewer) into current tenant

adminRouter.post('/seed-users', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    // Reset flag so seed will run
    db.prepare("DELETE FROM _seed_flags WHERE key = 'demo_users_v1'").run();
    seedDemoUsers(req.user!.tenantId);
    res.json({
      message: 'Demo users seeded',
      users: [
        { email: 'admin@demo.com',   role: 'admin',   password: 'demo-password123' },
        { email: 'analyst@demo.com', role: 'analyst', password: 'demo-password123' },
        { email: 'viewer@demo.com',  role: 'viewer',  password: 'demo-password123' },
      ],
    });
  } catch (err) {
    next(err);
  }
});
// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Returns all users in the tenant with their tool call count
adminRouter.get('/users', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const db = getDatabase();

    const rows = db
      .prepare(`
        SELECT 
          u.id, u.email, u.role, u.created_at,
          COUNT(l.id) as call_count
        FROM users u
        LEFT JOIN tool_call_logs l ON u.id = l.user_id
        WHERE u.tenant_id = ?
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `)
      .all(tenantId);
      
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
// Returns tool calls grouped by day for the last 7 days
adminRouter.get('/stats', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const db = getDatabase();

    // Group by date string (YYYY-MM-DD) and was_blocked
    const rows = db
      .prepare(`
        SELECT 
          DATE(timestamp) as date,
          was_blocked,
          COUNT(*) as count
        FROM tool_call_logs
        WHERE tenant_id = ? 
          AND timestamp >= date('now', '-7 days')
        GROUP BY DATE(timestamp), was_blocked
        ORDER BY date ASC
      `)
      .all(tenantId) as { date: string; was_blocked: number; count: number }[];

    // Format into a recharts friendly array: [{ date: '...', allowed: X, blocked: Y }]
    const grouped = rows.reduce((acc, row) => {
      if (!acc[row.date]) acc[row.date] = { date: row.date, allowed: 0, blocked: 0 };
      if (row.was_blocked) {
        acc[row.date].blocked += row.count;
      } else {
        acc[row.date].allowed += row.count;
      }
      return acc;
    }, {} as Record<string, { date: string; allowed: number; blocked: number }>);

    res.json(Object.values(grouped));
  } catch (err) {
    next(err);
  }
});
