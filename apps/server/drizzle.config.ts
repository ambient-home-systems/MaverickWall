import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  // Only used by drizzle-kit's introspection commands; generation reads the
  // schema file, not a live database. The runtime path comes from DATA_DIR.
  dbCredentials: { url: './data/wall.db' },
  // Forward-only. Generated migrations are committed and never edited after
  // they ship, because somebody's kitchen calendar has already run them.
  strict: true,
} satisfies Config;
