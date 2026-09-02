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
import { icon } from '../src/http/html.js';

/**
 * Where an icon is allowed in the admin, asserted rather than written down.
 *
 * The set is Lucide now, and swapping a set is the moment to say what it is
 * for. An icon here earns its place only as the **primary identifier of a
 * repeated destination or control** — the nav rows, the drawer's own opener,
 * the overflow control, the close control, the back and chevron affordances.
 * Three placements are banned outright, and each of the three was live:
 *
 *  - **inside a tinted rounded square.** `.ic` was a 34px accent-coloured tile
 *    on a panel ground, on all three Overview stat cards, all three status
 *    rows, and beside two wall names. It is gone, and so is its rule;
 *  - **beside a heading.** Those same tiles sat next to the card's own name,
 *    which is what identifies it. An icon there is the sentence twice, once in
 *    a language the reader has to learn;
 *  - **as decoration in an empty state.** Nothing did this, and it is the
 *    obvious thing to add to a page that says "nothing here yet".
 *
 * Driven through the real app rather than by reading the source: what matters
 * is the markup a household receives, and a rule about placement is a rule
 * about markup. The pages walked are the ones with cards, headings and empty
 * states in them — a fresh install has all three on every one of them.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/*
 * A fresh client address per harness. The auth rate limiter's counters live in
 * module-global memory, so they outlive an app and even its database — with one
 * address shared across the file, the fourth harness here cannot sign up, and
 * every page it then asks for is a redirect with no body. That reads as "the
 * page carries no stylesheet", which is a long way from the cause.
 */
let clientNumber = 0;
const nextClientAddress = (): string => `10.13.13.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-iconrules-'));
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
    auth: { secret: 'm'.repeat(32), baseUrl: 'http://localhost' },
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

  /** Signed in, through the real wizard — the session every admin page needs. */
  const signedIn = async () => {
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    await form('/setup/household', { timezone: 'Europe/London' });
    // Fail here, where the cause is legible, rather than in whichever
    // assertion first trips over an empty redirect body.
    const check = await call('/admin');
    expect(check.status, 'the harness must reach a signed-in /admin').toBe(200);
  };

  return { call, form, setupToken, jar, signedIn };
}

/** Every `<svg>` in the document, with the markup around it. */
function svgs(html: string): { readonly tag: string; readonly at: number }[] {
  const out: { tag: string; at: number }[] = [];
  const re = /<svg[\s\S]*?<\/svg>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push({ tag: match[0], at: match.index });
  return out;
}

/**
 * The innermost element of one of `tags` still open around an offset.
 *
 * The tag name has to end at a delimiter, which is not fastidiousness: `<p` is
 * a prefix of `<path`, so the first draft reported every nav icon as sitting
 * inside a paragraph — it had found the `<path>` of the *previous* icon and a
 * `</p>` somewhere after it. A crude matcher that is confidently wrong about
 * every case is worse than no matcher, because it reads as a failing rule.
 */
function enclosing(html: string, at: number, tags: readonly string[]): string | null {
  for (const tag of tags) {
    let open = -1;
    const re = new RegExp(`<${tag}(?=[\\s>])`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && match.index < at) open = match.index;
    if (open < 0) continue;
    const close = html.indexOf(`</${tag}>`, open);
    if (close > at) return tag;
  }
  return null;
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
  '/admin/system',
];

describe('the admin icon set', () => {
  it('is Lucide: strokes on a 24 grid, and no Material path survives', () => {
    // The two sets are told apart by the viewBox alone. Material Symbols draws
    // filled outlines on a 960 grid with the origin at the baseline
    // (`0 -960 960 960`); Lucide draws strokes on `0 0 24 24`. A single
    // surviving entry from the old set would read as an icon that is simply
    // heavier than its neighbours, which is exactly the kind of thing nobody
    // reports and nobody fixes.
    const svg = icon('calendars');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).not.toContain('0 -960 960 960');
  });

  it('draws nothing at all for a key nobody defined', () => {
    // The `chores` glyph was hand-drawn because the old set had no checklist.
    // Lucide has one, so the hand-drawn entry is gone; asking for a key that no
    // longer exists must be a gap and never a broken `<svg>`.
    expect(icon('chores')).toContain('<svg');
    expect(icon('sparkles')).toBe('');
  });
});

describe('where an icon may appear', () => {
  it('is never inside a tinted rounded square, on any admin page', async () => {
    const h = await harness();
    await h.signedIn();
    for (const path of PAGES) {
      const html = await (await h.call(path)).text();
      expect(html, path).not.toContain('class="ic"');
      expect(html, path).not.toContain('class="ic ');
    }
  });

  it('is never beside a heading', async () => {
    const h = await harness();
    await h.signedIn();
    for (const path of PAGES) {
      const html = await (await h.call(path)).text();
      for (const svg of svgs(html)) {
        const inside = enclosing(html, svg.at, ['h1', 'h2', 'h3', 'h4']);
        expect(inside, `${path}: an icon inside <${inside}>`).toBeNull();
      }
    }
  });

  it('is never decoration in an empty state', async () => {
    // A fresh install *is* the empty state: no calendars, no people, no rota,
    // no chores, no modules. That is the whole reason this walks a new
    // household rather than a seeded one.
    const h = await harness();
    await h.signedIn();
    for (const path of PAGES) {
      const html = await (await h.call(path)).text();
      for (const svg of svgs(html)) {
        const inside = enclosing(html, svg.at, ['p']);
        expect(inside, `${path}: an icon inside a paragraph`).toBeNull();
      }
    }
  });

  it('is looking at pages that actually have icons in them', async () => {
    // Every assertion above is satisfied by a page with no icons at all, and a
    // signed-out redirect has no body. This is the control.
    const h = await harness();
    await h.signedIn();
    const html = await (await h.call('/admin')).text();
    expect(svgs(html).length).toBeGreaterThan(10);
    expect(html).toContain('viewBox="0 0 24 24"');
  });
});
