import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createKeyring } from '../src/secrets/keyring.js';

import { adminStylesheet, stripComments } from './admin-stylesheet.js';

/**
 * Where motion is allowed, and where it is not — the server's half of the fence.
 *
 * `apps/display/test/motion.test.ts` holds a browser wall's motion to its scope
 * (plan P4.3, decision D7): every keyframe set and every binding inside
 * `@media (prefers-reduced-motion: no-preference)`, every binding under
 * `.canvas[data-motion="on"]`, keyframes that move `transform` and `opacity`
 * only, and `motion.ts` as the one module that says "animation". That file
 * reads the source and the built copy. This one draws the other three edges:
 *
 *  - **the wall's stylesheet as this server serves it** keeps the scope —
 *    fetched through the real app from `/assets/display.css`, because the
 *    served bytes are the ones a wall runs, and a server that one day
 *    assembled or rewrote that file on the way out would otherwise be a path
 *    round the display's own test;
 *  - **the panel path reaches no stylesheet at all**, which is what makes "an
 *    e-paper panel is always still" a fact about the artefact rather than a
 *    promise about the CSS somebody might add. An e-paper frame is a packed
 *    1-bit raster and a PNG; there is nowhere for a transition to live, and
 *    this says so out loud so that the day somebody serves an HTML page from
 *    `/d/epaper` the rule has to be re-argued rather than quietly lost;
 *  - **the admin keeps its motion**, which is deliberate and not an oversight.
 *    Three durations (120, 180, 260ms) and three easings, on a page with a
 *    pointer, on a device somebody is holding. What this holds it to is the
 *    property that makes it safe: every one of those declarations is inside
 *    `@media (prefers-reduced-motion: no-preference)`, so a household who has
 *    asked their system for less motion is served none. That half is
 *    unchanged by P4.3.
 *
 * The wall's rule and the admin's are still different, for a reason worth
 * writing once: a wall has no pointer, redraws every fifteen seconds and is
 * often a cheap tablet bolted up high, so its motion is decoration that must
 * never restart, never run for somebody who asked for less, and switch off per
 * wall; the admin is a settings screen somebody is touching, where the same
 * 180ms is the only thing telling them the tap landed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EPAPER = join(HERE, '..', 'src', 'epaper');

/** The declarations a stylesheet uses to move something. */
const MOTION = /(^|[;{}\s])(transition|animation)(-[a-z-]+)?\s*:/gi;

describe('the panel path', () => {
  const files = readdirSync(EPAPER).filter((f) => f.endsWith('.ts'));

  it('is a real directory of modules, so the sweep below is not empty', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('render.ts');
    expect(files).toContain('frame.ts');
  });

  for (const file of readdirSync(EPAPER).filter((f) => f.endsWith('.ts')).sort()) {
    it(`${file} carries no stylesheet and no motion`, () => {
      const source = stripComments(readFileSync(join(EPAPER, file), 'utf8'));
      expect(MOTION.test(source), `${file} declares a transition or an animation`).toBe(false);
      MOTION.lastIndex = 0;
      for (const pattern of [/@keyframes\b/i, /<style/i, /<link[^>]+stylesheet/i]) {
        expect(pattern.test(source), `${file} matches ${String(pattern)}`).toBe(false);
      }
    });
  }

  it('answers a panel with bytes rather than with a document', () => {
    /*
     * The endpoint a paired panel actually fetches. A dumb device holds no
     * cookie and runs no script, so `/d/epaper/<token>.{png,bin}` answers with
     * the packed raster or a PNG of it and refuses every other extension — and
     * that refusal is the reason there is no stylesheet on this path to lint.
     */
    const app = stripComments(readFileSync(join(HERE, '..', 'src', 'http', 'app.ts'), 'utf8'));
    const route = /app\.get\('\/d\/epaper\/:file'[\s\S]*?\n  \}\);/.exec(app)?.[0];
    expect(route, 'no /d/epaper route found — this file is reading the wrong source').toBeDefined();
    expect(route as string).toContain("ext !== 'png' && ext !== 'bin'");
    expect(/c\.html\(|text\/html/.test(route as string), 'the panel path serves HTML').toBe(false);
  });
});

/**
 * The extent of every `@media (prefers-reduced-motion: no-preference)` block
 * in a stylesheet, by matching braces from each block's own opening one.
 */
function reducedMotionExtents(css: string): [number, number][] {
  const extents: [number, number][] = [];
  const marker = '@media (prefers-reduced-motion: no-preference)';
  for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          extents.push([open, i]);
          break;
        }
      }
    }
  }
  return extents;
}

describe("the wall's stylesheet, as this server serves it", () => {
  let served: string;
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-motion-'));
    const { db } = openDatabase({ dataDir });
    try {
      runMigrations(db, { dataDir, migrationsFolder: join(HERE, '..', 'migrations'), waitTimeoutMs: 1000 });
      const app = createApp({
        db,
        appVersion: '0.1.0-test',
        bootNotices: [],
        auth: { secret: 'm'.repeat(32), baseUrl: 'http://localhost' },
        keyring: createKeyring(randomBytes(32)),
        fetcher: createFetcher(),
        clientAddress: () => `10.${[...randomBytes(3)].join('.')}`,
        setupToken: createSetupTokenHolder(() => {}),
        dataDir,
      });
      const response = await app.fetch(new Request('http://localhost/assets/display.css'));
      expect(response.status, 'the server did not serve the wall its stylesheet').toBe(200);
      served = stripComments(await response.text());
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('declares no transition anywhere', () => {
    expect(/(^|[;{}\s])transition(-[a-z-]+)?\s*:/i.test(served)).toBe(false);
  });

  it('keeps every keyframe set and every binding inside prefers-reduced-motion', () => {
    const extents = reducedMotionExtents(served);
    expect(extents.length, 'the wall has no reduced-motion block to move inside').toBeGreaterThan(0);
    const inside = (index: number): boolean => extents.some(([open, close]) => index > open && index < close);
    const outside: string[] = [];
    let counted = 0;
    for (const match of served.matchAll(/@(-[a-z]+-)?keyframes\b|(^|[;{}\s])animation(-[a-z-]+)?\s*:/gim)) {
      counted += 1;
      if (!inside(match.index ?? 0)) outside.push(served.slice(match.index ?? 0, (match.index ?? 0) + 60).trim());
    }
    expect(outside, 'the wall moves something outside prefers-reduced-motion').toEqual([]);
    expect(counted, 'nothing inside it either, so the check above is about nothing').toBeGreaterThan(2);
  });

  it('binds every animation under the wall\'s own Motion switch', () => {
    for (const [open, close] of reducedMotionExtents(served)) {
      const block = served.slice(open + 1, close);
      for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (rule[1] ?? '').trim();
        if (!/animation/.test(rule[2] ?? '') || /^(from|to|\d)/.test(selector)) continue;
        for (const one of selector.split(',')) {
          expect(one.trim(), 'a binding reaches past the Motion switch').toMatch(/^\.canvas\[data-motion="on"\][\s>]/);
        }
      }
    }
  });
});

describe('the admin keeps its motion, inside the preference that governs it', () => {
  it('still declares its three durations and three easings', () => {
    /*
     * Asserted as *present* rather than absent, which is unusual for a lint and
     * is the point: the wall's ban is not a general dislike of motion, and a
     * sweep that quietly took the admin's away with it would be a worse admin
     * for no reason. These are the chosen values; changing them is a decision,
     * and it should be one somebody makes here.
     */
    return adminStylesheet().then((css) => {
      for (const [token, value] of [
        ['--mw-dur-1', '120ms'],
        ['--mw-dur-2', '180ms'],
        ['--mw-dur-3', '260ms'],
      ] as const) {
        expect(css, `${token} is not ${value}`).toContain(`${token}:${value}`);
      }
      for (const token of ['--mw-ease:', '--mw-ease-out:', '--mw-ease-in:'] as const) {
        expect(css, `${token} is gone`).toContain(token);
      }
    });
  });

  it('puts every transition and every animation binding inside prefers-reduced-motion', () => {
    return adminStylesheet().then((raw) => {
      const css = stripComments(raw);
      const at = css.indexOf('@media (prefers-reduced-motion: no-preference)');
      expect(at, 'the admin has no reduced-motion block at all').toBeGreaterThan(-1);

      // Its extent, by matching braces from the block's own opening one.
      const open = css.indexOf('{', at);
      let depth = 0;
      let end = open;
      for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      expect(end, 'the reduced-motion block never closes').toBeGreaterThan(open);

      const outside: string[] = [];
      let inside = 0;
      for (const match of css.matchAll(MOTION)) {
        const index = match.index ?? 0;
        if (index > open && index < end) inside += 1;
        else outside.push(css.slice(index, index + 60).trim());
      }
      /*
       * A `@keyframes` set may be *declared* outside — `pl` is, above the block
       * — because a keyframe set nothing binds animates nothing. What must be
       * inside is every binding, which is what this counts.
       */
      expect(outside, 'the admin moves something outside prefers-reduced-motion').toEqual([]);
      // …and the block is not empty, or the assertion above is about nothing.
      expect(inside, 'no motion inside the block either').toBeGreaterThan(20);
    });
  });

  it('is never handed to a wall, which is what keeps the two rules apart', () => {
    // The admin's sheet is inlined into an admin page; a screen loads
    // `/assets/display.css` and nothing else. `apps/display/test/motion.test.ts`
    // holds the other end of that.
    const html = readFileSync(join(HERE, '..', '..', 'display', 'src', 'index.html'), 'utf8');
    expect(html).toContain('/assets/display.css');
    expect(/\/admin\//.test(html), 'the wall references an admin asset').toBe(false);
  });
});
