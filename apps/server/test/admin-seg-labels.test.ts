import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * A segmented control's labels are the choices, so they have to be readable.
 *
 * Reported from a real screen: the Clock widget's "Time format" control drew
 * "ollow the househ" — 142px of label centred in a 111px segment, clipped at
 * *both* ends. The rule that produced it looked like a graceful degradation and
 * was not one:
 *
 *   .le-cfg-field .seg button{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 *
 * `text-overflow` needs inline content in a block container. A segment is
 * `display:inline-flex` with `justify-content:center`, so its label is an
 * anonymous *flex item* — the ellipsis never had anything to act on, and
 * nothing anywhere said so. The declaration read as a safety net that had not
 * been in place since it was written.
 *
 * An ellipsis would not have been a fix either. These labels *are* the options:
 * "Follow the hou…" is a choice a household cannot make. They wrap now.
 *
 * So this pins the absence, the way `admin-mobile-nav.test.ts` pins the absence
 * of the rules its redesign deleted — because there the absence is the fix, and
 * reinstating any of them would read as tidying up.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function stylesheet(): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-seglabel-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'c'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.11.0.${++n}`,
    setupToken,
    dataDir,
  });

  const html = await (await app.fetch(new Request('http://localhost/admin/sign-in'))).text();
  const opened = html.indexOf('<style>');
  const closed = html.indexOf('</style>', opened);
  expect(opened, 'the admin page must carry an inline stylesheet').toBeGreaterThan(-1);
  return html.slice(opened + '<style>'.length, closed);
}

/** The declarations of the one rule that styles a segment in the inspector. */
function segmentRule(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = pattern.exec(withoutComments); m !== null; m = pattern.exec(withoutComments)) {
    const selectors = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (selectors === '.le-cfg-field .seg button') return m[2] ?? '';
  }
  throw new Error('no rule for a segment inside the inspector — has it been renamed?');
}

describe('a segmented control in the widget inspector', () => {
  it('lets a long label wrap instead of clipping it', async () => {
    const body = segmentRule(await stylesheet());

    // The fault itself: a label that cannot wrap in a 111px segment is a label
    // clipped at both ends, because the segment centres it.
    expect(body, 'a segment label must be able to wrap').not.toMatch(/white-space\s*:\s*nowrap/);

    // And the declaration that made the clipping look intentional. It cannot
    // work here — the segment is a flex container — so having it back would
    // once again read as a safety net that is not in place.
    expect(body, 'text-overflow does nothing on a flex container').not.toMatch(/text-overflow/);

    // Growing is what wrapping needs; a fixed height would clip the second line
    // instead of the second half of the word, which is not an improvement.
    expect(body).toMatch(/height\s*:\s*auto/);
    expect(body).toMatch(/min-height\s*:/);

    // A single unbreakable word still has to stay inside its segment, since
    // there is no ellipsis to fall back on.
    expect(body).toMatch(/overflow-wrap\s*:\s*anywhere/);

    /*
     * The global rule avoids `overflow:hidden` deliberately — it would clip the
     * focus ring, which on a wall editor is the only affordance a keyboard has.
     * This scope had quietly put it back.
     */
    expect(body, 'overflow:hidden clips the focus ring').not.toMatch(/overflow\s*:\s*hidden/);
  });
});
