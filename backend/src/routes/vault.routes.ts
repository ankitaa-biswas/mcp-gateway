import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth.middleware';
import { storeKey, getKey, deleteKey, getKeysForUser } from '../services/vaultService';
import { AppError } from '../middleware/errorHandler';

export const vaultRouter = Router();

// All vault endpoints require a valid JWT
vaultRouter.use(authenticate);

// ── Validation schemas ────────────────────────────────────────────────────────

const StoreKeySchema = z.object({
  server_id: z.string().uuid('server_id must be a valid UUID'),
  api_key: z.string().min(1, 'api_key cannot be empty'),
});

// ── POST /api/vault/store ─────────────────────────────────────────────────────
/**
 * Encrypt and store an API key for the authenticated user.
 *
 * Body: { server_id: string, api_key: string }
 *
 * The raw api_key is NEVER persisted. Only the AES-256-GCM ciphertext,
 * its IV, and GCM auth tag are written to the database.
 */
vaultRouter.post('/store', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { server_id, api_key } = StoreKeySchema.parse(req.body);
    const userId = req.user!.userId;
    const tenantId = req.user!.tenantId;

    const result = storeKey(userId, server_id, api_key, tenantId);

    res.status(201).json({
      message: 'API key encrypted and stored successfully',
      credential_id: result.id,
      server_id,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vault/retrieve/:serverId ─────────────────────────────────────────
/**
 * Decrypt and return the stored API key for the authenticated user.
 *
 * The decrypted key is returned once per request; it is never cached.
 * Callers should treat the response as a secret and not log it.
 */
vaultRouter.get('/retrieve/:serverId', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    if (!serverId) throw new AppError(400, 'serverId param is required');

    const userId = req.user!.userId;
    const apiKey = getKey(userId, serverId);

    res.json({
      server_id: serverId,
      api_key: apiKey,
      // Remind consumers this is sensitive
      _note: 'Handle this value as a secret. Do not log or expose it.',
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vault/keys ───────────────────────────────────────────────────────
/**
 * Return a list of server IDs for which the authenticated user has stored credentials.
 */
vaultRouter.get('/keys', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const keys = getKeysForUser(userId);
    res.json(keys);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/vault/:serverId ───────────────────────────────────────────────
/**
 * Permanently remove a stored credential.
 * Users can only delete their own credentials.
 */
vaultRouter.delete('/:serverId', (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { serverId } = req.params;
    if (!serverId) throw new AppError(400, 'serverId param is required');

    const userId = req.user!.userId;
    deleteKey(userId, serverId);

    res.status(200).json({
      message: 'Credential deleted successfully',
      server_id: serverId,
    });
  } catch (err) {
    next(err);
  }
});
