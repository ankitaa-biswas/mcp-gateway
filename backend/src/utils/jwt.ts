import jwt from 'jsonwebtoken';
import { logger } from './logger';

const JWT_SECRET = process.env.JWT_SECRET ?? 'mcp-gateway-dev-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY ?? '7d';

export interface JwtPayload {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch (err) {
    logger.warn('JWT verification failed:', err);
    throw new Error('Invalid or expired token');
  }
}
