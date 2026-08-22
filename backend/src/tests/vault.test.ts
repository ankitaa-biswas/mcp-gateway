/**
 * vault.test.ts
 *
 * Tests: Credential Vault — encrypt/decrypt, HTTP routes, tamper detection
 *
 * Covers:
 *  ✓ encrypt/decrypt round-trip produces original plaintext
 *  ✓ encrypting the same plaintext twice yields different ciphertexts (fresh IV)
 *  ✓ tampered ciphertext is rejected (AES-GCM auth tag mismatch)
 *  ✓ tampered auth tag is rejected
 *  ✓ POST /api/vault/store succeeds and does NOT return plaintext key
 *  ✓ GET /api/vault/retrieve/:id returns the correct decrypted key
 *  ✓ GET /api/vault/retrieve/:id for missing credential returns 404
 *  ✓ DELETE /api/vault/:id removes the credential
 *  ✓ DELETE /api/vault/:id for nonexistent credential returns 404
 *  ✓ GET /api/vault/keys lists server IDs with stored credentials
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './helpers/testApp';
import { seedFixtures, seedCredential, TOKENS, IDS } from './helpers/fixtures';
import { encrypt, decrypt } from '../services/vaultService';
import { v4 as uuidv4 } from 'uuid';

const app = createTestApp();

beforeEach(() => {
  seedFixtures();
});

// ── Crypto primitives ─────────────────────────────────────────────────────────

describe('Vault crypto — encrypt/decrypt', () => {
  it('encrypt+decrypt round-trip reproduces original plaintext', () => {
    const original = 'sk-my-super-secret-api-key-12345';
    const payload = encrypt(original);
    const decrypted = decrypt(payload);
    expect(decrypted).toBe(original);
  });

  it('two encryptions of the same plaintext produce different ciphertexts (fresh IV)', () => {
    const key = 'same-key-every-time';
    const p1 = encrypt(key);
    const p2 = encrypt(key);
    // IVs must differ (random per call)
    expect(p1.iv).not.toBe(p2.iv);
    // Ciphertexts also differ because IV is part of the key stream
    expect(p1.ciphertext).not.toBe(p2.ciphertext);
  });

  it('tampered ciphertext causes decrypt to throw (auth tag mismatch)', () => {
    const payload = encrypt('secret-value');
    // Flip the first byte of the ciphertext
    const tamperedBytes = Buffer.from(payload.ciphertext, 'base64');
    tamperedBytes[0] ^= 0xff;
    const tampered = { ...payload, ciphertext: tamperedBytes.toString('base64') };

    expect(() => decrypt(tampered)).toThrow();
  });

  it('tampered auth tag causes decrypt to throw', () => {
    const payload = encrypt('secret-value');
    const tamperedTag = Buffer.alloc(16, 0xab).toString('base64'); // wrong tag
    expect(() => decrypt({ ...payload, authTag: tamperedTag })).toThrow();
  });

  it('tampered IV causes decrypt to throw', () => {
    const payload = encrypt('secret-value');
    const tamperedIv = Buffer.alloc(12, 0x00).toString('base64');
    expect(() => decrypt({ ...payload, iv: tamperedIv })).toThrow();
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

describe('Vault HTTP routes', () => {
  it('POST /api/vault/store returns 201 and does NOT expose the plaintext key', async () => {
    const res = await request(app)
      .post('/api/vault/store')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ server_id: IDS.serverA, api_key: 'my-secret-api-key' });

    expect(res.status).toBe(201);
    // The response body must NOT contain the raw plaintext
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('my-secret-api-key');
    // Should return credential_id and server_id
    expect(res.body).toHaveProperty('credential_id');
    expect(res.body.server_id).toBe(IDS.serverA);
  });

  it('GET /api/vault/retrieve/:id returns the correct decrypted key', async () => {
    const SECRET = 'round-trip-secret-99';
    seedCredential(IDS.adminA, IDS.serverA, SECRET);

    const res = await request(app)
      .get(`/api/vault/retrieve/${IDS.serverA}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(res.body.api_key).toBe(SECRET);
    expect(res.body.server_id).toBe(IDS.serverA);
  });

  it('GET /api/vault/retrieve/:id returns 404 for missing credential', async () => {
    const res = await request(app)
      .get(`/api/vault/retrieve/${IDS.serverA}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(404);
  });

  it('GET /api/vault/retrieve with nonexistent UUID returns 404', async () => {
    const res = await request(app)
      .get(`/api/vault/retrieve/${uuidv4()}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(404);
  });

  it('GET /api/vault/keys lists server IDs for which the user has credentials', async () => {
    seedCredential(IDS.adminA, IDS.serverA, 'key-for-serverA');

    const res = await request(app)
      .get('/api/vault/keys')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toContain(IDS.serverA);
  });

  it('DELETE /api/vault/:id removes the credential (200)', async () => {
    seedCredential(IDS.adminA, IDS.serverA, 'to-be-deleted');

    const delRes = await request(app)
      .delete(`/api/vault/${IDS.serverA}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);
    expect(delRes.status).toBe(200);

    // Confirm it is gone
    const getRes = await request(app)
      .get(`/api/vault/retrieve/${IDS.serverA}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /api/vault/:id for nonexistent credential returns 404', async () => {
    const res = await request(app)
      .delete(`/api/vault/${uuidv4()}`)
      .set('Authorization', `Bearer ${TOKENS.adminA()}`);

    expect(res.status).toBe(404);
  });

  it('POST /api/vault/store with invalid UUID for server_id returns 400', async () => {
    const res = await request(app)
      .post('/api/vault/store')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ server_id: 'not-a-uuid', api_key: 'some-key' });

    expect(res.status).toBe(400);
  });

  it('POST /api/vault/store with empty api_key returns 400', async () => {
    const res = await request(app)
      .post('/api/vault/store')
      .set('Authorization', `Bearer ${TOKENS.adminA()}`)
      .send({ server_id: IDS.serverA, api_key: '' });

    expect(res.status).toBe(400);
  });
});
