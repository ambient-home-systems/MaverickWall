import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { issueCompanionToken } from '../src/api/companion.js';
import { RECIPES_URL } from '../src/http/admin-companion.js';

/**
 * The phone and automations page, held to the routes it documents (plan item
 * M2.4).
 *
 * A recipe for an iOS Shortcut or a Home Assistant `rest_command` is copied
 * into somebody's phone or configuration and then forgotten, so one that has
 * drifted from the server fails silently, months later, in a kitchen. Every
 * request on the page — each `http` block, and each `rest_command` with its
 * payload template rendered from the automation that calls it — is sent to a
 * real app with a real token, and none may be refused for its shape.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS = join(ROOT, 'apps/server/migrations');
const PAGE = readFileSync(join(ROOT, 'docs/phone-and-automations.md'), 'utf8');

interface Example {
  readonly path: string;
  readonly body: unknown;
}

/** Every ```http block: `POST /companion/…`, headers, a blank line, a JSON body. */
export function httpExamples(markdown: string): Example[] {
  const out: Example[] = [];
  for (const match of markdown.matchAll(/```http\n([\s\S]*?)```/g)) {
    const [head = '', body = ''] = (match[1] ?? '').split(/\n\n/);
    const request = /^POST (\/companion\/[a-z/-]+)$/m.exec(head);
    if (request?.[1] === undefined) throw new Error(`an http block that is not a companion POST:\n${head}`);
    out.push({ path: request[1], body: JSON.parse(body) });
  }
  return out;
}

/** `!secret name` read as a marker, so the test can see which secret a header names. */
const SECRET = [{ tag: '!secret', resolve: (name: string) => `SECRET:${name}` }];
const yamlBlocks = (markdown: string): unknown[] =>
  [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parseYaml(m[1] ?? '', { customTags: SECRET }));

interface RestCommand {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly content_type: string;
  readonly payload: string;
}

/**
 * A payload template rendered the way Home Assistant renders it for the two
 * filters the page uses: `tojson` writes a quoted JSON string, `int` a number.
 * Any other template is refused, so the page cannot grow one this does not
 * understand and still pass.
 */
function render(payload: string, data: Record<string, unknown>): string {
  return payload.replace(/\{\{\s*([a-z_]+)\s*\|\s*(tojson|int)\s*\}\}/g, (_all, name: string, filter: string) => {
    const value = data[name];
    if (value === undefined) throw new Error(`the payload uses ${name}, which nothing sends`);
    return filter === 'int' ? String(Math.trunc(Number(value))) : JSON.stringify(String(value));
  });
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function household(): Promise<{
  readonly db: SqliteDatabase;
  readonly send: (path: string, body: string, authorization: string) => Promise<Response>;
  readonly authorization: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-companion-docs-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const created = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(created, created);
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'f'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => '10.24.0.1',
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
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
    admin(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: 'docs@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  const token = issueCompanionToken(db, keyring, userId, Date.now());

  // The wall the page's examples name, so a wall request has something to find.
  const now = Date.now();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, ?, ?)`,
  ).run(issueDisplayToken().tokenHash, now, now, now);

  return {
    db,
    authorization: `Bearer ${token}`,
    send: async (path, body, authorization) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body,
        }),
      ),
  };
}

/** What every companion answer is: JSON with `ok` and a sentence, and never a complaint about its shape. */
async function expectUnderstood(response: Response, what: string): Promise<{ ok: boolean; error?: string }> {
  const answer = (await response.json()) as { ok: boolean; error?: string; message: string };
  expect(typeof answer.ok, what).toBe('boolean');
  expect(typeof answer.message, what).toBe('string');
  expect(answer.error, `${what}: ${answer.message}`).not.toBe('bad-body');
  expect(response.status, `${what}: ${answer.message}`).not.toBe(400);
  return answer;
}

describe('docs/phone-and-automations.md', () => {
  const examples = httpExamples(PAGE);
  const blocks = yamlBlocks(PAGE) as Record<string, unknown>[];
  const routes = [
    ...readFileSync(join(ROOT, 'apps/server/src/http/companion.ts'), 'utf8').matchAll(/app\.post\('(\/companion\/[a-z/-]+)'/g),
  ].map((m) => m[1]);

  it('shows a request for every companion route, and for no route that is not one', () => {
    expect(routes.length).toBeGreaterThanOrEqual(9);
    expect([...new Set(examples.map((one) => one.path))].sort()).toEqual([...routes].sort());
  });

  it('sends every request on the page to a real server, and none is refused for its shape', async () => {
    const house = await household();
    for (const example of examples) {
      const response = await house.send(example.path, JSON.stringify(example.body), house.authorization);
      const answer = await expectUnderstood(response, example.path);
      // The ones that need nothing set up beyond a wall named Kitchen do what they say.
      if (/^\/companion\/(timers|messages|walls\/refresh)/.test(example.path)) {
        expect(answer.ok, example.path).toBe(true);
      }
    }
    // The timer it started and the message it sent were ended and cleared by the page's own next examples.
    expect(house.db.prepare('SELECT count(*) AS n FROM timers').get()).toEqual({ n: 0 });
    expect(house.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('keeps the token in secrets.yaml, with Bearer in front, and every rest_command reads it from there', () => {
    const secrets = blocks.find((block) => 'maverick_wall_authorization' in block);
    expect(secrets?.['maverick_wall_authorization']).toMatch(/^Bearer mwc_/);
    const commands = blocks.flatMap((block) => Object.values((block['rest_command'] ?? {}) as Record<string, RestCommand>));
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      expect(command.method).toBe('post');
      expect(command.content_type).toBe('application/json');
      expect(command.headers).toEqual({ authorization: 'SECRET:maverick_wall_authorization' });
      expect(new URL(command.url).pathname).toMatch(/^\/companion\//);
    }
  });

  it('renders every rest_command the way Home Assistant would, sends it, and none is refused for its shape', async () => {
    const house = await household();
    const commands = Object.assign(
      {},
      ...blocks.map((block) => (block['rest_command'] ?? {}) as Record<string, RestCommand>),
    ) as Record<string, RestCommand>;
    // The data each command is called with: from the page's own automations, else a plain example.
    const calls = new Map<string, Record<string, unknown>>();
    for (const block of blocks) {
      for (const automation of (block['automation'] ?? []) as { actions: { action: string; data?: Record<string, unknown> }[] }[]) {
        for (const step of automation.actions) {
          const name = step.action.replace(/^rest_command\./, '');
          expect(commands[name], `${step.action} is not a rest_command on the page`).toBeDefined();
          calls.set(name, step.data ?? {});
        }
      }
    }
    const fallback: Record<string, unknown> = { list: 'Shopping', item: 'Bread "seeded"', minutes: 10, label: 'Pasta', text: 'Dinner' };
    for (const [name, command] of Object.entries(commands)) {
      const body = render(command.payload, calls.get(name) ?? fallback);
      // A template this does not render is one Home Assistant would render some other way.
      expect(body, `${name}: a template the page should not use`).not.toMatch(/\{\{|\{%/);
      expect(() => JSON.parse(body), `${name}: ${body}`).not.toThrow();
      const response = await house.send(new URL(command.url).pathname, body, house.authorization);
      await expectUnderstood(response, name);
    }
    expect(calls.size).toBeGreaterThanOrEqual(2);
  });

  it('is the page the admin’s link names, on the site the docs are published at', () => {
    const pages = readFileSync(join(ROOT, 'apps/docs/src/pages.ts'), 'utf8');
    const site = /SITE_URL = '([^']+)'/.exec(pages)?.[1];
    expect(RECIPES_URL).toBe(`${site}phone-and-automations.html`);
    expect(pages).toContain(`source: 'docs/phone-and-automations.md',\n        slug: 'phone-and-automations',`);
  });

  it('renders a quote in an item as JSON rather than breaking the body', () => {
    const body = render('{"item": {{ item | tojson }}}', { item: 'Bread "seeded"' });
    expect(JSON.parse(body)).toEqual({ item: 'Bread "seeded"' });
  });
});
