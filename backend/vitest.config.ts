import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run in Node — no jsdom needed for API tests
    environment: 'node',

    // Global env injected before any module is loaded
    // DB_PATH=:memory: means every test process gets a fresh SQLite database
    // that is completely isolated from ./data/mcp_gateway.db
    env: {
      NODE_ENV: 'test',
      DB_PATH: ':memory:',
      JWT_SECRET: 'test-secret-key-for-vitest-only',
      JWT_EXPIRY: '1h',
      PASSWORD_SALT: 'test-salt',
      VAULT_MASTER_KEY: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      CORS_ORIGIN: 'http://localhost:5173',
    },

    // Test file locations
    include: ['src/tests/**/*.test.ts'],

    // Each test file gets its own isolated module registry
    // This ensures the DB singleton and rate-limit Map reset between files
    isolate: true,

    // Timeout generous enough for proxy stub tests
    testTimeout: 15000,

    // Run test files sequentially to avoid SQLite in-memory conflicts
    // (each file still gets its own DB via isolate:true)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
