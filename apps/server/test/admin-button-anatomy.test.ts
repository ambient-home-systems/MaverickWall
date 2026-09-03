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
 * The one-character trap that made the Walls page look broken, asserted so it
 * cannot come back on any screen.
 *
 * The base button anatomy — 40px height, side padding, the corner, the 48px
 * pointer target, `text-decoration:none` — is granted by the selector
 * `button,.btn` alone. The variant classes `.btn-ghost` / `.btn-tonal` /
 * `.btn-text` / `.btn-danger` supply colour only, so on a `<button>` tag they
 * are safe (the tag carries the anatomy) and on an `<a>` they need `.btn`
 * beside them. An `<a class="btn-ghost">` with no `.btn` renders as a plain
 * underlined text fragment sitting between two real buttons — which is exactly
 * what "URL & recipes" was on the e-paper wall card, a filled button and a
 * form-wrapped danger button on either side of it at three different heights.
 *
 * A stylesheet test cannot see this — the classes are all present and correct
 * in the sheet; the fault is which element wears them. So this walks the markup
 * a household actually receives, the way `admin-icon-rules.test.ts` does, and
 * the second block holds the screen the bug lived on to no inline layout style
 * at all, because that markup was hand-typed `<div style="…gap:10px…">` trees
 * the token-drift test (which scans the stylesheet, not route output) was blind
 * to.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A fresh client address per harness: the auth rate limiter's counters are
// module-global and outlive an app, so a shared address 429s a later harness.
let clientNumber = 0;
const nextClientAddress = (): string => `10.19.19.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-btnanat-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = nextClientAddress();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  /** Signed in through the real wizard — the session every admin page needs. */
  const signedIn = async () => {
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    await form('/setup/household', { timezone: 'Europe/London' });
    const check = await call('/admin');
    expect(check.status, 'the harness must reach a signed-in /admin').toBe(200);
  };

  /** Draw real cards: a browser + e-paper wall, and one installed module. */
  const seedCards = async () => {
    await form('/admin/screens', { name: 'Kitchen' });
    // The e-paper wall is added on its own page's form: a name, a panel preset
    // and a rotation (newEpaperBody).
    await form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    // Install the key-less catalogue recipe so the Store draws an installed
    // moduleCard (its config defaults fill in when omitted).
    await form('/admin/modules/install/outside-temperature', { name: 'Outside temperature' });
  };

  return { call, form, signedIn, seedCards };
}

const PAGES = [
  '/admin',
  '/admin/calendars',
  '/admin/walls',
  '/admin/people',
  '/admin/shifts',
  '/admin/chores',
  '/admin/alerts',
  '/admin/modules',
  '/admin/epaper',
  '/admin/system',
];

const VARIANTS = ['btn-ghost', 'btn-tonal', 'btn-text', 'btn-danger'];

/** Every `<a>` tag in the document, with its class attribute (or ""). */
function anchorClasses(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const cls = /\bclass="([^"]*)"/.exec(match[0]);
    out.push(cls === null ? '' : match[0]);
  }
  return out;
}

function hasWord(classAttr: string, word: string): boolean {
  const cls = /\bclass="([^"]*)"/.exec(classAttr);
  if (cls === null) return false;
  return cls[1]!.split(/\s+/).includes(word);
}

describe('button anatomy on anchors', () => {
  it('every <a> carrying a button variant also carries the base .btn class', async () => {
    const h = await harness();
    await h.signedIn();
    await h.seedCards();

    const offenders: string[] = [];
    for (const path of PAGES) {
      const html = await (await h.call(path)).text();
      for (const anchor of anchorClasses(html)) {
        const variant = VARIANTS.find((v) => hasWord(anchor, v));
        if (variant === undefined) continue;
        if (!hasWord(anchor, 'btn')) offenders.push(`${path}: ${anchor}`);
      }
    }
    // A bare `<a class="btn-ghost">` gets none of the button anatomy and renders
    // as underlined text — the exact "looks broken" fault the Walls page shipped.
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('is looking at pages that actually render button-variant anchors', async () => {
    // The control: every assertion above passes over a page with no such anchors
    // at all, and a signed-out redirect has no body. The Overview's "Edit what
    // shows" / "Arrange layout" are `<a class="btn btn-ghost btn-sm">`, so a real
    // signed-in Overview must contain at least one correct one.
    const h = await harness();
    await h.signedIn();
    const html = await (await h.call('/admin')).text();
    const correct = anchorClasses(html).filter(
      (a) => VARIANTS.some((v) => hasWord(a, v)) && hasWord(a, 'btn'),
    );
    expect(correct.length).toBeGreaterThan(0);
  });
});

describe('the card screens carry no inline layout style', () => {
  // The Walls and Store card builders were hand-typed `<div style="…gap:10px…">`
  // trees — invisible to `admin-component-drift.test.ts`, which scans the served
  // stylesheet and never route output. This holds those screens to zero inline
  // layout styles so the drift cannot creep back on them. A custom property
  // (`--swatch`, `--w`) is a legitimate inline value a token cannot express and
  // is allowed; a raw `gap`/`margin`/`display`/`font-size` is not. The recipe
  // and install *forms* (their own URLs) keep a monospace code field and are not
  // in scope here.
  const CARD_PAGES = ['/admin/walls', '/admin/modules'] as const;
  const layout = /(^|;)\s*(display|flex|flex-wrap|gap|margin|padding|font-size|align-items|justify-content)\s*:/i;

  it('sets spacing, flex and font through classes, not style attributes', async () => {
    const h = await harness();
    await h.signedIn();
    await h.seedCards();

    for (const path of CARD_PAGES) {
      const html = await (await h.call(path)).text();
      const offenders: string[] = [];
      const re = /style="([^"]*)"/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) !== null) {
        if (layout.test(match[1]!)) offenders.push(match[1]!);
      }
      expect(offenders, `${path}\n${offenders.join('\n')}`).toEqual([]);
    }
  });
});
