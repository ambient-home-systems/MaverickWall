import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One string, written twice, in two packages that cannot import each other.
 *
 * The server stamps `schema-degraded` on the notice it sends when it could not
 * read its own database, and the display keys on that exact code to decide two
 * things that this branch exists to get right: that the stand-in is never
 * *stored* over the household's last good calendar, and that it never
 * *replaces* one already on the glass. Rename it on one side and both faults
 * come back silently — the wall would draw the stand-in, save it, and a reload
 * would have nothing left to fall back to, with every test still green,
 * because each package would be internally consistent.
 *
 * The display bundle has no dependencies and no bundler (plain `tsc` with
 * `rootDir` pinned to its own `src`), so it cannot import a shared constant and
 * a server test cannot import from it without failing `tsconfig.test.json`.
 * Same seam, same answer as `epaper-ladder-parity.test.ts`: read both files and
 * compare what each one actually says.
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', 'src', 'http', 'app.ts');
const DISPLAY = join(here, '..', '..', 'display', 'src', 'manifest.ts');

describe('the degraded-manifest notice code', () => {
  it('is the same string on both sides of the wire', () => {
    const server = readFileSync(APP, 'utf8');
    const display = readFileSync(DISPLAY, 'utf8');

    // The server's, off the notice it actually builds.
    const sent = /const schemaNotice: ManifestNotice = \{[\s\S]*?code:\s*'([^']+)'/.exec(server);
    expect(sent, 'the schema notice moved or was renamed — this test needs updating with it')
      .not.toBeNull();

    // The display's, off the constant it actually reads.
    const read = /const STAND_IN_NOTICE = '([^']+)'/.exec(display);
    expect(read, 'the display no longer names the code it keys on').not.toBeNull();

    expect(read?.[1], 'a rename on one side silently un-fixes both stand-in faults').toBe(
      sent?.[1],
    );
  });
});
