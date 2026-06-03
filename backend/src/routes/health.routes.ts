import { Router, Request, Response } from 'express';
import { getDatabase } from '../db/database';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  let dbStatus = 'ok';
  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      database: dbStatus,
    },
  });
});
