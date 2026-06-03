import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';

export const tenantsRouter = Router();
tenantsRouter.use(authenticate);

const UpdateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  is_active: z.boolean().optional(),
});

// ── GET /api/tenants/me ───────────────────────────────────────────────────────
tenantsRouter.get('/me', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const tenant = db
      .prepare('SELECT id, name, slug, plan, is_active, created_at FROM tenants WHERE id = ?')
      .get(req.user!.tenantId);

    if (!tenant) throw new AppError(404, 'Tenant not found');
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tenants (admin only) ─────────────────────────────────────────────
tenantsRouter.get('/', requireRole('superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const db = getDatabase();
    const tenants = db.prepare('SELECT id, name, slug, plan, is_active, created_at FROM tenants').all();
    res.json(tenants);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tenants/:id ────────────────────────────────────────────────────
tenantsRouter.patch('/:id', requireRole('admin', 'superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    // Tenants can only update their own record unless superadmin
    if (req.user!.role !== 'superadmin' && req.user!.tenantId !== id) {
      throw new AppError(403, 'Cannot modify another tenant');
    }

    const updates = UpdateTenantSchema.parse(req.body);
    const db = getDatabase();

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
    if (updates.plan !== undefined) { setClauses.push('plan = ?'); values.push(updates.plan); }
    if (updates.is_active !== undefined) { setClauses.push('is_active = ?'); values.push(updates.is_active ? 1 : 0); }

    if (setClauses.length === 0) throw new AppError(400, 'No fields to update');

    setClauses.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE tenants SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT id, name, slug, plan, is_active, updated_at FROM tenants WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tenants/:id/users ────────────────────────────────────────────────
tenantsRouter.get('/:id/users', requireRole('admin', 'superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (req.user!.role !== 'superadmin' && req.user!.tenantId !== id) {
      throw new AppError(403, 'Cannot access another tenant\'s users');
    }

    const db = getDatabase();
    const users = db
      .prepare('SELECT id, email, role, is_active, created_at FROM users WHERE tenant_id = ?')
      .all(id);

    res.json(users);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tenants/:id/users ───────────────────────────────────────────────
const InviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

tenantsRouter.post('/:id/users', requireRole('admin', 'superadmin'), (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (req.user!.role !== 'superadmin' && req.user!.tenantId !== id) {
      throw new AppError(403, 'Cannot add users to another tenant');
    }

    const { email, role } = InviteUserSchema.parse(req.body);
    const db = getDatabase();

    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, password_hash, role)
      VALUES (?, ?, ?, 'PENDING_PASSWORD_RESET', ?)
    `).run(userId, id, email, role);

    res.status(201).json({ id: userId, email, role, tenant_id: id });
  } catch (err) {
    next(err);
  }
});
