/**
 * auth.test.ts
 *
 * Tests: Authentication — /api/auth/register, /api/auth/login, /api/auth/me
 *
 * Covers:
 *  ✓ Valid registration creates tenant + returns JWT
 *  ✓ Valid login returns JWT
 *  ✓ Invalid password is rejected with 401
 *  ✓ Unknown tenant slug is rejected with 404
 *  ✓ Protected route (/me) rejects missing Authorization header (401)
 *  ✓ Protected route (/me) rejects malformed Authorization header (401)
 *  ✓ Protected route (/me) rejects expired/invalid JWT (401)
 *  ✓ Valid JWT accesses /me and returns payload
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { signToken } from '../utils/jwt';
import jwt from 'jsonwebtoken';

const app = createTestApp();

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_TENANT = `auth-test-tenant-${Date.now()}`;
const TEST_EMAIL  = `user-${Date.now()}@auth.test`;
const TEST_PASS   = 'StrongPass99!';

let authToken = '';
let tenantSlug = '';

// ── Registration ──────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('creates a new tenant + admin user and returns a JWT', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ tenantName: TEST_TENANT, email: TEST_EMAIL, password: TEST_PASS });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('tenant');
    expect(res.body.tenant.name).toBe(TEST_TENANT);

    authToken = res.body.token as string;
    tenantSlug = res.body.tenant.slug as string;
  });

  it('rejects duplicate tenant name with 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ tenantName: TEST_TENANT, email: `other-${Date.now()}@auth.test`, password: TEST_PASS });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/tenant/i);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ tenantName: TEST_TENANT });
    expect(res.status).toBe(400);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    // Ensure the tenant exists (registration may have run in a parallel describe)
    if (!tenantSlug) {
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ tenantName: `${TEST_TENANT}-2`, email: TEST_EMAIL, password: TEST_PASS });
      tenantSlug = reg.body.tenant.slug;
    }
  });

  it('returns a JWT for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASS, tenantSlug });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.user.role).toBe('admin');
  });

  it('rejects wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword!', tenantSlug });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it('rejects unknown tenant slug with 404', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASS, tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tenant not found/i);
  });

  it('rejects wrong email (user does not exist) with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@nowhere.test', password: TEST_PASS, tenantSlug });

    expect(res.status).toBe(401);
  });
});

// ── /api/auth/me — JWT guard ──────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns the JWT payload for a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toHaveProperty('email', TEST_EMAIL);
    expect(res.body.user).toHaveProperty('role', 'admin');
  });

  it('rejects requests with no Authorization header (401)', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing or malformed/i);
  });

  it('rejects "Bearer " with no token (401)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('rejects a JWT signed with a different secret (401)', async () => {
    const fakeToken = jwt.sign(
      { userId: 'x', tenantId: 'y', email: 'hack@evil.com', role: 'admin' },
      'wrong-secret',
      { expiresIn: '1h' },
    );
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${fakeToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired JWT (401)', async () => {
    // Build a token that has already expired (negative expiresIn uses past timestamp)
    const expiredToken = signToken({
      userId: 'x', tenantId: 'y', email: 'old@user.test', role: 'analyst',
    });
    // Manually create via jsonwebtoken with expiresIn -1s
    const immediatelyExpired = jwt.sign(
      { userId: 'x', tenantId: 'y', email: 'old@user.test', role: 'analyst' },
      process.env['JWT_SECRET'] ?? 'test-secret-key-for-vitest-only',
      { expiresIn: -1 } as jwt.SignOptions,
    );
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${immediatelyExpired}`);
    expect(res.status).toBe(401);

    // Suppress unused warning
    void expiredToken;
  });

  it('rejects a completely malformed token string (401)', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.jwt.at.all');
    expect(res.status).toBe(401);
  });
});
