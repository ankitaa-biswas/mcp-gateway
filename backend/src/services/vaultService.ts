/**
 * vaultService.ts
 *
 * Handles AES-256-GCM encryption/decryption of API keys and all
 * credential CRUD operations against the SQLite `credentials` table.
 *
 * Encryption design:
 *  - Algorithm : AES-256-GCM  (authenticated encryption — no separate HMAC needed)
 *  - Key source : VAULT_MASTER_KEY env var (must be 64 hex chars = 32 raw bytes)
 *  - IV        : 12 random bytes per encryption call (GCM recommended length)
 *  - Storage   : encrypted_key | iv | auth_tag — all base64-encoded in the DB
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Master key ────────────────────────────────────────────────────────────────

function getMasterKey(): Buffer {
  const hex = process.env['VAULT_MASTER_KEY'];
  if (!hex) {
    throw new AppError(500, 'VAULT_MASTER_KEY is not set. Cannot access the credential vault.');
  }
  if (hex.length !== 64) {
    throw new AppError(
      500,
      `VAULT_MASTER_KEY must be 64 hex characters (32 bytes). Got ${hex.length} chars.`,
    );
  }
  return Buffer.from(hex, 'hex');
}

// ── Crypto primitives ─────────────────────────────────────────────────────────

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string;         // base64, 12 bytes
  authTag: string;    // base64, 16 bytes
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * A fresh random IV is generated for every call.
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12); // 96-bit IV — GCM standard

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16-byte tag authenticates ciphertext + IV

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt an AES-256-GCM payload produced by `encrypt()`.
 * Throws if the auth tag doesn't match (data tampered or wrong key).
 */
export function decrypt(payload: EncryptedPayload): string {
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new AppError(422, 'Decryption failed — auth tag mismatch. Data may be corrupted or the master key changed.');
  }
}

// ── DB row type ───────────────────────────────────────────────────────────────

interface CredentialRow {
  id: string;
  user_id: string;
  server_id: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  created_at: string;
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Encrypt `apiKey` and persist it for `userId` / `serverId`.
 * Upserts — if a credential already exists it is replaced atomically.
 */
export function storeKey(userId: string, serverId: string, apiKey: string, tenantId?: string): { id: string } {
  const db = getDatabase();

  // Verify the server belongs to the user's tenant via a joined lookup
  const query = tenantId
    ? db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ?').get(serverId, tenantId)
    : db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(serverId);
  const server = query as { id: string } | undefined;
  if (!server) throw new AppError(404, `MCP server '${serverId}' not found`);

  const payload = encrypt(apiKey);
  const id = uuidv4();

  // Use INSERT OR REPLACE so the UNIQUE(user_id, server_id) constraint acts as an upsert
  db.prepare(`
    INSERT INTO credentials (id, user_id, server_id, encrypted_key, iv, auth_tag)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, server_id) DO UPDATE SET
      id            = excluded.id,
      encrypted_key = excluded.encrypted_key,
      iv            = excluded.iv,
      auth_tag      = excluded.auth_tag,
      created_at    = datetime('now')
  `).run(id, userId, serverId, payload.ciphertext, payload.iv, payload.authTag);

  logger.info(`🔐 Credential stored  user=${userId} server=${serverId}`);
  return { id };
}

/**
 * Fetch and decrypt the API key for `userId` / `serverId`.
 * Returns the plaintext key — never expose the encrypted columns directly.
 */
export function getKey(userId: string, serverId: string): string {
  const db = getDatabase();

  const row = db
    .prepare('SELECT * FROM credentials WHERE user_id = ? AND server_id = ?')
    .get(userId, serverId) as CredentialRow | undefined;

  if (!row) {
    throw new AppError(404, `No credential found for server '${serverId}'`);
  }

  const plaintext = decrypt({
    ciphertext: row.encrypted_key,
    iv: row.iv,
    authTag: row.auth_tag,
  });

  logger.info(`🔓 Credential retrieved user=${userId} server=${serverId}`);
  return plaintext;
}

/**
 * Delete the stored credential for `userId` / `serverId`.
 * Returns true if a row was deleted, false if none existed.
 */
export function deleteKey(userId: string, serverId: string): boolean {
  const db = getDatabase();

  const result = db
    .prepare('DELETE FROM credentials WHERE user_id = ? AND server_id = ?')
    .run(userId, serverId);

  if (result.changes === 0) {
    throw new AppError(404, `No credential found for server '${serverId}' to delete`);
  }

  logger.info(`🗑️  Credential deleted  user=${userId} server=${serverId}`);
  return true;
}

/**
 * Fetch all server IDs for which the user has stored a credential.
 */
export function getKeysForUser(userId: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT server_id FROM credentials WHERE user_id = ?')
    .all(userId) as { server_id: string }[];
  
  return rows.map(r => r.server_id);
}
