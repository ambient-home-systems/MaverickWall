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
 * P2.1: one place for "Add", on every list screen.
 *
 * The create action used to be in three places depending on the screen: the
 * app bar on Themes, a row of buttons under the header on Walls, and an inline
 * form at the foot of the page everywhere else. The last was deliberate — a
 * filled "Add" in the app bar competed with the form's own filled "Add" on the
 * same screen, two primaries for one act — and the rule this file holds is the
 * answer to that objection rather than a reversal of it: a list page's only
 * create action is **one** app-bar button labelled "Add …", it leads to a
 * page of its own, and the list page carries no create form. One primary,
 * because there is one form, and it is elsewhere.
 *
 * "No create form" is asserted against the POST endpoints that *create* on each
 * screen, and those endpoints are then required to be reachable from the add
 * page — so a list page cannot pass by the table naming the wrong endpoint, and
 * an add page that lost its form fails rather than making the list look clean.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.25.25.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-add-placement-'));
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
    auth: { secret: 'q'.repeat(32), baseUrl: 'http://localhost' },
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

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  /*
   * One person, so every conditional add form that used to exist is drawn:
   * Work Schedule only drew "Add a rotation" when there was somebody to give a
   * rotation to, and a walk of an empty household would have seen no form on
   * that page with or without this change. Each list is read before this as
   * well as after, because an empty list takes the other branch — an empty
   * state where the rows would be — and a form reinstated on either branch is
   * the fault.
   */
  const seedPerson = async (): Promise<void> => {
    expect((await form('/admin/people', { name: 'Sam', color: '#4C7FD1' })).status).toBe(302);
  };
  return { call, seedPerson };
}

/** Follow a relative href the way a browser resolves it against `<base href="/">`. */
const resolve = (href: string): string => `/${href.split('#')[0]}`;

/** Every `<form method="post" action="…">` action on a page, in order. */
const postActions = (html: string): string[] =>
  [...html.matchAll(/<form\b[^>]*\bmethod="post"[^>]*\baction="([^"]*)"/g)].map(
    (m) => m[1] as string,
  );

/** Every same-app `href` on a page, relative, as the page wrote it. */
const links = (html: string): string[] =>
  [...html.matchAll(/\bhref="(admin\/[^"]*)"/g)].map((m) => m[1] as string);

interface ListScreen {
  /** The list page. */
  readonly path: string;
  /**
   * The POST endpoints that create a row of this screen's kind. None may be the
   * action of a form on the list page, and every one must be the action of a
   * form on the add page or one page further (a chooser's destinations).
   */
  readonly creates: readonly string[];
  /**
   * A screen whose half of P2.1 has not landed. Its test is `it.fails`: it is
   * expected to fail today and to start passing — and so to fail as an
   * `it.fails` — the moment its session lands, which is when this flag comes
   * off.
   */
  readonly todo?: string;
}

const SCREENS: readonly ListScreen[] = [
  { path: '/admin/calendars', creates: ['admin/calendars', 'admin/calendars/caldav'] },
  { path: '/admin/people', creates: ['admin/people'] },
  { path: '/admin/shifts', creates: ['admin/shifts/new'] },
  { path: '/admin/shifts/types', creates: ['admin/shifts/types', 'admin/shifts/types/preset'] },
  { path: '/admin/chores', creates: ['admin/chores'] },
  { path: '/admin/themes', creates: ['admin/themes', 'admin/themes/generate'] },
  // TODO(S06): Walls and the Home Assistant screens are P2.1's second half and
  // P2.2. Each fails today on the first assertion: no app-bar "Add …" action.
  { path: '/admin/walls', creates: ['admin/screens', 'admin/epaper'], todo: 'S06' },
  { path: '/admin/home-assistant/readings', creates: ['admin/home-assistant/entities'], todo: 'S06' },
  { path: '/admin/home-assistant/calendars', creates: ['admin/home-assistant/calendars'], todo: 'S06' },
  { path: '/admin/home-assistant/lists', creates: ['admin/home-assistant/lists'], todo: 'S06' },
  { path: '/admin/home-assistant/alerts', creates: ['admin/home-assistant/rules'], todo: 'S06' },
];

describe('every list page puts its one "Add …" in the app bar, and its form elsewhere', () => {
  for (const screen of SCREENS) {
    const test = screen.todo === undefined ? it : it.fails;
    const name =
      screen.todo === undefined
        ? screen.path
        : `${screen.path} — expected to fail until ${screen.todo} (TODO(${screen.todo}))`;
    test(name, async () => {
      const h = await harness();
      const before = await (await h.call(screen.path)).text();
      await h.seedPerson();
      const response = await h.call(screen.path);
      expect(response.status, `${screen.path} answers`).toBe(200);
      const html = await response.text();

      const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)?.[1];
      expect(header, `${screen.path} has an app bar`).toBeDefined();
      const actions = [...(header as string).matchAll(/<a class="btn[^"]*" href="([^"]*)">([^<]*)<\/a>/g)];
      expect(actions.length, `${screen.path} carries exactly one app-bar action`).toBe(1);
      const [, href, label] = actions[0] as RegExpMatchArray;
      expect(label, 'the verb is "Add"').toMatch(/^Add /);
      expect(href, 'and it leads to a /new route').toMatch(/^admin\/[a-z/-]+\/new$/);

      for (const [state, page] of [
        ['with nobody in the house', before],
        ['with somebody in it', html],
      ] as const) {
        const onList = postActions(page.slice(page.indexOf('</header>')));
        for (const create of screen.creates) {
          expect(
            onList,
            `${screen.path}, ${state}, carries no create form posting to ${create}`,
          ).not.toContain(create);
        }
      }

      // The add page answers, and it — or a page it offers — carries every one.
      const add = await h.call(resolve(href as string));
      expect(add.status, `${href} answers with a page, not a redirect`).toBe(200);
      const addHtml = await add.text();
      const reachable = new Set(postActions(addHtml));
      for (const next of links(addHtml).filter((one) => one.startsWith(`${href as string}/`))) {
        const deeper = await h.call(resolve(next));
        expect(deeper.status, `${next} answers`).toBe(200);
        for (const action of postActions(await deeper.text())) reachable.add(action);
      }
      for (const create of screen.creates) {
        expect([...reachable], `${href} (or a page it offers) posts to ${create}`).toContain(create);
      }
    });
  }
});
