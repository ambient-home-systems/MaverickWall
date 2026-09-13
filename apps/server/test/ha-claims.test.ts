import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { HA_SERVICES } from '../src/modules/homeassistant/client.js';

/**
 * The claims rule 12's amendment falsifies, and the reason they need a test.
 *
 * RFC 012's own appendix named four places this repository states a property the
 * amendment makes false. The true number was **ten**, and the six it missed are
 * the interesting half: a README heading, two paragraphs the supervisor renders
 * on the add-on page, a doc-comment above an unrelated network helper, a
 * section divider in the schema, and a bullet in the camera RFC. None of them
 * is a file anybody working on a to-do list has a reason to open.
 *
 * Nine of the ten are prose, and **prose does not fail to compile**. The one
 * thing that makes a stale claim findable is that its wording is distinctive,
 * so this scans for the *retired sentences* rather than for the new ones: a
 * replacement worded differently from what anybody predicted still passes, and
 * a revert does not.
 *
 * Three subjects, each read in the form it is actually served in. The admin
 * card is rendered through the real app with a real session, because that is
 * what somebody deciding whether to paste a token reads. `DOCS.md` is read as
 * text because the *supervisor* renders it, which makes it the claim most
 * households actually see. And `README.md` because it is the first page anybody
 * evaluating this product opens.
 *
 * The tenth claim, the boundary card's own wording, is asserted in
 * `homeassistant.test.ts` where it always was — it is the only one of the ten
 * that could not have gone stale quietly, and it is the argument for this file
 * covering the other nine.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * The sentences that are now false, verbatim.
 *
 * Each one was live somewhere in this repository before RFC 012 phase 1, and
 * each is a claim a household or a contributor could act on. Matched
 * case-insensitively, because a heading capitalises and a sentence does not.
 */
const RETIRED = [
  'cannot control anything',
  'no service calls',
  'never writes',
  'read-only, permanently',
  'no code in this application that writes',
];

async function adminHomeAssistantPage(): Promise<string> {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-claims-'));
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
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
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

  // A real session, through the real wizard. The page is behind the gate, and a
  // 302 to sign-in contains none of these sentences and would pass every
  // assertion below — which is why the status is checked too.
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const response = await call('/admin/home-assistant');
  expect(response.status).toBe(200);
  return response.text();
}

describe('nothing still promises Home Assistant is read-only', () => {
  it('not on the page a household reads before pasting a token', async () => {
    const html = await adminHomeAssistantPage();
    // It really is the page, not a redirect or an error shell.
    expect(html).toContain('Home Assistant');

    for (const sentence of RETIRED) {
      expect(html.toLowerCase(), `the served admin page still says "${sentence}"`).not.toContain(
        sentence,
      );
    }
  });

  it('not in the README', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').toLowerCase();
    for (const sentence of RETIRED) {
      expect(readme, `README.md still says "${sentence}"`).not.toContain(sentence);
    }
  });

  it('not in the add-on documentation the supervisor renders', () => {
    const docs = readFileSync(join(ROOT, 'addon', 'maverick-wall', 'DOCS.md'), 'utf8').toLowerCase();
    for (const sentence of RETIRED) {
      expect(docs, `DOCS.md still says "${sentence}"`).not.toContain(sentence);
    }
  });

  it('and the scan is looking at the right documents', () => {
    // A path that silently resolves to nothing passes for ever. Both files are
    // read again here rather than trusted, because a rename would otherwise
    // turn three assertions green by making them about an empty string.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const docs = readFileSync(join(ROOT, 'addon', 'maverick-wall', 'DOCS.md'), 'utf8');
    expect(readme.length).toBeGreaterThan(2000);
    expect(docs.length).toBeGreaterThan(1000);
    expect(readme).toContain('Home Assistant');
    expect(docs).toContain('Home Assistant');
    // And the sentences really were distinctive enough to find, which is the
    // premise the whole file rests on: each one is still present in the RFC
    // that records what it used to say.
    const rfc = readFileSync(
      join(ROOT, 'docs', 'rfc-012-home-assistant-to-do-lists.md'),
      'utf8',
    ).toLowerCase();
    for (const sentence of RETIRED) expect(rfc).toContain(sentence);
  });
});

describe('and the page says what it can do instead', () => {
  it('names the one permitted write, on the page', async () => {
    /*
     * The other direction, and it is not symmetry for its own sake.
     *
     * A claim deleted and not replaced is a screen that has stopped saying what
     * pasting a token here costs, which is worse than one that says it wrongly:
     * the whole reason this card is above the form is that it is the only thing
     * on the page somebody has to take on trust. Deleting the old sentence
     * satisfies every assertion above and leaves that hole.
     */
    const html = await adminHomeAssistantPage();
    expect(html).toContain(HA_SERVICES.write.replace('/', '.'));
    expect(html).toContain('to-do list');
    // And the refusals stay named, because "one write" without "and nothing
    // else" is not a boundary a household can read.
    expect(html).toContain('No switches, no scenes');
  });
});
