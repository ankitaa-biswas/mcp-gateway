import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDatabase } from '../db/database';
import { signToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';

export const authRouter = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────
const RegisterSchema = z.object({
  tenantName: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  tenantSlug: z.string(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password + (process.env['PASSWORD_SALT'] || 'mcp-salt')).digest('hex');
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantName, email, password } = RegisterSchema.parse(req.body);
    const db = getDatabase();

    const slug = toSlug(tenantName);
    const tenantId = uuidv4();
    const userId = uuidv4();

    const insertTenant = db.prepare(`
      INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)
    `);
    const insertUser = db.prepare(`
      INSERT INTO users (id, tenant_id, email, password_hash, role)
      VALUES (?, ?, ?, ?, 'admin')
    `);

    const runBoth = db.transaction(() => {
      insertTenant.run(tenantId, tenantName, slug);
      insertUser.run(userId, tenantId, email, hashPassword(password));
    });

    runBoth();

    const token = signToken({ userId, tenantId, email, role: 'admin' });

    res.status(201).json({
      message: 'Tenant and admin user created',
      token,
      tenant: { id: tenantId, name: tenantName, slug },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, tenantSlug } = LoginSchema.parse(req.body);
    const db = getDatabase();

    const tenant = db
      .prepare('SELECT * FROM tenants WHERE slug = ? AND is_active = 1')
      .get(tenantSlug) as { id: string; name: string; slug: string } | undefined;

    if (!tenant) throw new AppError(404, 'Tenant not found');

    const user = db
      .prepare('SELECT * FROM users WHERE tenant_id = ? AND email = ? AND is_active = 1')
      .get(tenant.id, email) as
      | { id: string; email: string; role: string; password_hash: string }
      | undefined;

    if (!user || user.password_hash !== hashPassword(password)) {
      throw new AppError(401, 'Invalid credentials');
    }

    const token = signToken({
      userId: user.id,
      tenantId: tenant.id,
      email: user.email,
      role: user.role,
    });

    res.json({ token, user: { id: user.id, email: user.email, role: user.role }, tenant });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
import { authenticate, AuthRequest } from '../middleware/auth.middleware';

authRouter.get('/me', authenticate, (req: AuthRequest, res: Response) => {
  res.json({
    user: req.user,
  });
});

