import 'dotenv/config';
import app from './app';
import { initializeDatabase } from './db/database';
import { logger } from './utils/logger';

const PORT = process.env.PORT ?? 4000;

async function bootstrap() {
  try {
    // Initialize SQLite database
    initializeDatabase();
    logger.info(' Database initialized');
    
    // Build the TF-IDF search index
    const { initializeIndex } = await import('./services/searchService');
    initializeIndex();

    app.listen(PORT, () => {
      logger.info(` MCP Gateway API running on http://localhost:${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV ?? 'development'}`);
    });
  } catch (error) {
    logger.error(' Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
