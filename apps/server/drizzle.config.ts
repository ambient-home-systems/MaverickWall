import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: { url: process.env['DATA_DIR'] ?? './data/wall.db' },
  // Forward-only. Generated migrations are committed and never edited after
  // they ship, because somebody's kitchen calendar has already run them.
  strict: true,
} satisfies Config;
