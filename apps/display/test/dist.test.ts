import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built bundle, checked rather than the config that produces it.
 *
 * `pnpm test` builds first (vitest only transpiles), so `dist/` here is the
 * exact tree the image copies and the server serves publicly. A source map
 * is ~200KB of dead weight on a project with no error-reporting service to
 * send stack traces to, and it was shipping — checking the config setting
 * would prove intent, not the artifact a household actually gets.
 */
describe('the built display bundle', () => {
  it('carries no source maps', () => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
    const maps = readdirSync(dist).filter((f) => f.endsWith('.map'));
    expect(maps).toEqual([]);
  });
});
