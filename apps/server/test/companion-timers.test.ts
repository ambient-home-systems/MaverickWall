import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { issueCompanionToken } from '../src/api/companion.js';
import type { Manifest } from '../src/api/manifest.js';
import { panelInput } from '../src/epaper/widgets.js';
import { DONE_SHOWN_MS, timersModule } from '../src/modules/timers/index.js';
import { messagesModule } from '../src/modules/messages/index.js';
import { durationWords } from '../src/http/companion.js';

/**
 * Timers and messages (plan items M2.2, M5.1, M5.2, decision MD7): started and
 * sent from a phone with the companion token, or from the admin; drawn by every
 * wall with the widget; cleared from a wall only where that wall allows it, and
 * then only a timer that has finished.
 *
 * A real app and database, a clock the test moves, and a paired wall's own
 * token — because what the feature promises is a sequence over time, and the
 * manifest is where a wall learns any of it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let household = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const START = Date.UTC(2026, 9, 6, 9, 0, 0);

interface Harness {
  readonly db: SqliteDatabase;
  readonly clock: { at: number };
  readonly token: string;
  readonly phone: (path: string, body: unknown, init?: { form?: boolean }) => Promise<Response>;
  readonly admin: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; etag: string }>;
  readonly wall: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly allowClear: (on: boolean) => void;
}

async function harness(): Promise<Harness> {
  const n = ++household;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-timers-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    START,
    START,
  );
  // The wizard runs on the real clock, because the bootstrap code is stamped by
  // it; the test's own clock starts once the household exists.
  const clock = { at: Date.now() };
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'f'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.17.${n}.1`,
    setupToken,
    dataDir,
    now: () => clock.at,
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
    email: `timers${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  clock.at = START;
  const token = issueCompanionToken(db, keyring, userId, clock.at);

  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Wall', ?, 'panels', ?, ?, ?)`,
  ).run(display.tokenHash, START, START, START);

  return {
    db,
    clock,
    token,
    phone: async (path, body, init = {}) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': init.form === true ? 'application/x-www-form-urlencoded' : 'application/json',
          },
          body:
            init.form === true
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body),
        }),
      ),
    admin,
    form,
    manifest: async () => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${display.token}` } }),
      );
      return { body: (await response.json()) as Manifest, etag: response.headers.get('etag') ?? '' };
    },
    wall: async (path, fields) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${display.token}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(fields).toString(),
        }),
      ),
    allowClear: (on) => {
      db.prepare('UPDATE screens SET allow_clear = ? WHERE id = ?').run(on ? 1 : 0, 'wall');
    },
  };
}

type Panel<K extends string, T> = Record<K, T[]>;
const timersIn = (manifest: Manifest): { key: string; label?: string; startedAt: number; endsAt: number }[] =>
  ((manifest.panels['timers'] as Panel<'timers', { key: string; label?: string; startedAt: number; endsAt: number }> | undefined)
    ?.timers ?? []);
const messagesIn = (manifest: Manifest): { key: string; text: string; expiresAt: number }[] =>
  ((manifest.panels['messages'] as Panel<'messages', { key: string; text: string; expiresAt: number }> | undefined)
    ?.messages ?? []);

describe('a timer from a phone', () => {
  it('starts, reaches the manifest as an end instant, and is said back in words', async () => {
    const h = await harness();
    const before = await h.manifest();
    // Nothing running is no panel at all, so a household with no timers sends
    // the document it always sent.
    expect(before.body.panels['timers']).toBeUndefined();

    const response = await h.phone('/companion/timers', { minutes: 10, label: 'Pasta' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = (await response.json()) as { ok: boolean; id: string; endsAt: number; message: string };
    expect(answer).toEqual({
      ok: true,
      id: expect.stringMatching(/^tm-[0-9a-f]{12}$/),
      endsAt: START + 10 * 60_000,
      message: 'Pasta timer set for 10 minutes.',
    });

    const after = await h.manifest();
    expect(timersIn(after.body)).toEqual([
      { key: answer.id, label: 'Pasta', startedAt: START, endsAt: START + 10 * 60_000 },
    ]);
    expect(after.etag).not.toBe(before.etag);
  });

  it('takes seconds, or minutes as a form field, and leaves the label out when none was given', async () => {
    const h = await harness();
    const seconds = await h.phone('/companion/timers', { seconds: 90 });
    expect(((await seconds.json()) as { message: string }).message).toBe('Timer set for 90 seconds.');
    const form = await h.phone('/companion/timers', { minutes: '5' }, { form: true });
    expect(((await form.json()) as { message: string }).message).toBe('Timer set for 5 minutes.');
    const timers = timersIn((await h.manifest()).body);
    expect(timers.map((timer) => timer.endsAt - START)).toEqual([90_000, 300_000]);
    expect(timers.every((timer) => !('label' in timer))).toBe(true);
  });

  it.each([
    ['both minutes and seconds', { minutes: 1, seconds: 30 }],
    ['neither', { label: 'Pasta' }],
    ['no time at all', { minutes: 0 }],
    ['more than a day', { minutes: 1441 }],
    ['under ten seconds', { seconds: 5 }],
    ['a fraction', { minutes: 2.5 }],
    ['a word for a number', { minutes: 'ten' }],
    ['a label too long', { minutes: 1, label: 'x'.repeat(41) }],
    ['a control character', { minutes: 1, label: 'Pasta\u0007' }],
    ['a key it does not know', { minutes: 1, sound: 'bell' }],
  ])('refuses %s, and starts nothing', async (_name, body) => {
    const h = await harness();
    const response = await h.phone('/companion/timers', body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('bad-body');
    expect(h.db.prepare('SELECT count(*) AS n FROM timers').get()).toEqual({ n: 0 });
  });

  it('refuses a fifth timer with a sentence', async () => {
    const h = await harness();
    for (let i = 1; i <= 4; i++) expect((await h.phone('/companion/timers', { minutes: i })).status).toBe(200);
    const fifth = await h.phone('/companion/timers', { minutes: 5 });
    expect(fifth.status).toBe(409);
    expect(((await fifth.json()) as { message: string }).message).toBe(
      'There are already 4 timers on the walls. End or clear one first.',
    );
  });

  it('ends by label without case, every timer with it; by id; or all; and says when nothing matched', async () => {
    const h = await harness();
    await h.phone('/companion/timers', { minutes: 10, label: 'Pasta' });
    await h.phone('/companion/timers', { minutes: 12, label: 'pasta' });
    const eggs = (await (await h.phone('/companion/timers', { minutes: 3, label: 'Eggs' })).json()) as { id: string };
    await h.phone('/companion/timers', { minutes: 20 });

    const byLabel = await h.phone('/companion/timers/end', { label: 'PASTA' });
    expect(await byLabel.json()).toEqual({ ok: true, ended: 2, message: '2 timers ended.' });
    expect((await h.phone('/companion/timers/end', { id: eggs.id })).status).toBe(200);
    expect(timersIn((await h.manifest()).body)).toHaveLength(1);
    expect(await (await h.phone('/companion/timers/end', { all: true })).json()).toEqual({
      ok: true,
      ended: 1,
      message: 'Timer ended.',
    });
    const nothing = await h.phone('/companion/timers/end', { label: 'Pasta' });
    expect(nothing.status).toBe(404);
    // Exactly one way of saying which.
    expect((await h.phone('/companion/timers/end', { label: 'Pasta', all: true })).status).toBe(400);
    expect((await h.phone('/companion/timers/end', {})).status).toBe(400);
  });

  it('stays on the walls as done for half an hour, then leaves them, and the job deletes it', async () => {
    const h = await harness();
    await h.phone('/companion/timers', { minutes: 1, label: 'Tea' });
    h.clock.at = START + 60_000 + DONE_SHOWN_MS - 1;
    expect(timersIn((await h.manifest()).body)).toHaveLength(1);
    h.clock.at = START + 60_000 + DONE_SHOWN_MS;
    expect(timersIn((await h.manifest()).body)).toEqual([]);
    await timersModule.job!.run({ db: h.db, now: h.clock.at } as never);
    expect(h.db.prepare('SELECT count(*) AS n FROM timers').get()).toEqual({ n: 0 });
    expect((await h.manifest()).body.panels['timers']).toBeUndefined();
    // And a done one no longer counts towards the four.
    for (let i = 1; i <= 4; i++) expect((await h.phone('/companion/timers', { minutes: i })).status).toBe(200);
  });
});

describe('a message from a phone', () => {
  it('posts for an hour unless told otherwise, newest first, and goes when it expires', async () => {
    const h = await harness();
    const first = await h.phone('/companion/messages', { text: 'Back at 6' });
    expect(((await first.json()) as { message: string }).message).toBe('Posted for 1 hour.');
    h.clock.at = START + 1000;
    await h.phone('/companion/messages', { text: 'Bins tonight', minutes: 90 });
    expect(messagesIn((await h.manifest()).body).map((message) => message.text)).toEqual(['Bins tonight', 'Back at 6']);

    h.clock.at = START + 60 * 60_000;
    expect(messagesIn((await h.manifest()).body).map((message) => message.text)).toEqual(['Bins tonight']);
    await messagesModule.job!.run({ db: h.db, now: h.clock.at } as never);
    expect(h.db.prepare('SELECT body FROM messages').all()).toEqual([{ body: 'Bins tonight' }]);
  });

  it.each([
    ['no text', { minutes: 5 }],
    ['empty text', { text: '   ' }],
    ['too long', { text: 'x'.repeat(201) }],
    ['a control character', { text: 'Back\u0000 at 6' }],
    ['no time', { text: 'Hi', minutes: 0 }],
    ['more than a day', { text: 'Hi', minutes: 1441 }],
    ['a key it does not know', { text: 'Hi', colour: 'red' }],
  ])('refuses %s, and posts nothing', async (_name, body) => {
    const h = await harness();
    const response = await h.phone('/companion/messages', body);
    expect(response.status).toBe(400);
    expect(h.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('refuses a ninth, and clears one by id or all', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(((await (await h.phone('/companion/messages', { text: `Note ${i}` })).json()) as { id: string }).id);
    }
    expect((await h.phone('/companion/messages', { text: 'One more' })).status).toBe(409);
    expect(await (await h.phone('/companion/messages/clear', { id: ids[0] })).json()).toEqual({
      ok: true,
      cleared: 1,
      message: 'Message cleared.',
    });
    expect((await h.phone('/companion/messages/clear', { id: ids[0] })).status).toBe(404);
    expect(await (await h.phone('/companion/messages/clear', { all: 'true' }, { form: true })).json()).toEqual({
      ok: true,
      cleared: 7,
      message: '7 messages cleared.',
    });
  });
});

describe('clearing from a wall (MD7)', () => {
  it('is refused on a wall not allowed to, before the body is read', async () => {
    const h = await harness();
    const { id } = (await (await h.phone('/companion/timers', { minutes: 1 })).json()) as { id: string };
    h.clock.at = START + 120_000;
    const refused = await h.wall('/d/timers/clear', { timer: id });
    expect(refused.status).toBe(403);
    expect((await h.wall('/d/messages/clear', { message: 'ms-aaaaaaaaaaaa' })).status).toBe(403);
    expect(timersIn((await h.manifest()).body)).toHaveLength(1);
    // And the wall is not told it may: the field is absent, not false.
    expect((await h.manifest()).body.screen).not.toHaveProperty('allowClear');
  });

  it('clears a finished timer, never a running one, and a message, on a wall allowed to', async () => {
    const h = await harness();
    h.allowClear(true);
    expect((await h.manifest()).body.screen).toMatchObject({ allowClear: true });
    const { id } = (await (await h.phone('/companion/timers', { minutes: 1, label: 'Tea' })).json()) as { id: string };

    const running = await h.wall('/d/timers/clear', { timer: id });
    expect(running.status).toBe(409);
    expect(((await running.json()) as { message: string }).message).toBe(
      'That timer is still running. End it from a phone or the admin.',
    );
    expect(timersIn((await h.manifest()).body)).toHaveLength(1);

    h.clock.at = START + 61_000;
    expect((await h.wall('/d/timers/clear', { timer: id })).status).toBe(200);
    expect(timersIn((await h.manifest()).body)).toEqual([]);
    // Two walls pressing at once both mean the same thing.
    expect((await h.wall('/d/timers/clear', { timer: id })).status).toBe(200);
    expect((await h.wall('/d/timers/clear', { timer: 'tea' })).status).toBe(400);

    const { id: note } = (await (await h.phone('/companion/messages', { text: 'Back at 6' })).json()) as { id: string };
    expect((await h.wall('/d/messages/clear', { message: note })).status).toBe(200);
    expect(messagesIn((await h.manifest()).body)).toEqual([]);
    expect((await h.wall('/d/messages/clear', { message: 'Back at 6' })).status).toBe(400);
  });

  it('is offered on the wall’s own Touch controls, off by default, and saved', async () => {
    const h = await harness();
    const page = await (await h.admin('/admin/walls/wall')).text();
    expect(page).toMatch(/name="allow_clear"(?![^>]*checked)/);
    expect(page).toContain('Allow clearing timers and messages');
  });
});

describe('timers and messages in the admin', () => {
  it('lists what the walls show, with one Add to a page of its own', async () => {
    const h = await harness();
    const empty = await (await h.admin('/admin/timers')).text();
    expect(empty).toContain('No timers running.');
    expect(empty).toContain('No messages showing.');
    expect(empty).toContain('href="admin/timers/new"');
    expect(empty).not.toMatch(/<form[^>]*action="admin\/(timers|messages)"/);
    const add = await (await h.admin('/admin/timers/new')).text();
    expect(add).toMatch(/<form method="post" action="admin\/timers">/);
    expect(add).toMatch(/<form method="post" action="admin\/messages">/);
  });

  it('starts and ends a timer, and sends and clears a message', async () => {
    const h = await harness();
    const started = await h.form('/admin/timers', { minutes: '15', label: 'Bread' });
    expect(started.status).toBe(302);
    expect(started.headers.get('location')).toContain('saved=timer-started');
    const page = await (await h.admin('/admin/timers')).text();
    expect(page).toContain('Bread');
    // The household's own zone: 09:00 UTC on 6 October is 10:00 in London.
    expect(page).toContain('Ends at 10:15.');
    const id = (h.db.prepare('SELECT id FROM timers').get() as { id: string }).id;
    expect((await h.form(`/admin/timers/${id}/end`, {})).headers.get('location')).toContain('saved=timer-ended');
    expect((await h.form(`/admin/timers/${id}/end`, {})).headers.get('location')).not.toContain('saved=');

    expect((await h.form('/admin/messages', { text: 'Back at 6', minutes: '30' })).status).toBe(302);
    const message = (h.db.prepare('SELECT id, expires_at AS expiresAt FROM messages').get() as { id: string; expiresAt: number });
    expect(message.expiresAt).toBe(START + 30 * 60_000);
    expect((await h.form(`/admin/messages/${message.id}/clear`, {})).headers.get('location')).toContain(
      'saved=message-cleared',
    );
  });

  it('hands a refused form back with what was typed and why', async () => {
    const h = await harness();
    const refused = await h.form('/admin/messages', { text: 'Back at 6', minutes: '9999' });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('Between 1 and 1440 minutes.');
    expect(page).toContain('value="Back at 6"');
    expect(h.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('says what the token can now do, and how', async () => {
    const h = await harness();
    const page = await (await h.admin('/admin/companion')).text();
    expect(page).toContain('start and end timers, and send and clear messages');
    expect(page).toContain('/companion/timers');
    expect(page).toContain('/companion/messages/clear');
  });
});

describe('what is written down', () => {
  it('logs neither a label nor a message', async () => {
    const h = await harness();
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    await h.phone('/companion/timers', { minutes: 5, label: 'Secret santa' });
    await h.phone('/companion/messages', { text: 'Surprise party at 7' });
    await h.phone('/companion/messages', { text: 'Surprise party\u0007' });
    for (const line of lines) {
      expect(line).not.toContain('Secret santa');
      expect(line).not.toContain('Surprise party');
    }
  });
});

describe('on an e-paper panel', () => {
  const manifest = (generatedAt: number): Manifest =>
    ({
      generatedAt,
      timezone: 'Europe/London',
      panels: {
        timers: { timers: [{ key: 'tm-aaaaaaaaaaaa', label: 'Pasta', startedAt: START, endsAt: START + 10 * 60_000 }] },
        messages: {
          messages: [
            { key: 'ms-aaaaaaaaaaaa', text: 'Back at 6', postedAt: START, expiresAt: START + 60 * 60_000 },
          ],
        },
      },
    }) as unknown as Manifest;

  it('says when a timer ends, not how long is left, so a frame changes only when it finishes', () => {
    expect(panelInput('timers', manifest(START), {})).toEqual({ kind: 'panel', panel: ['Pasta: ends 10:10'] });
    expect(panelInput('timers', manifest(START + 9 * 60_000), {})).toEqual(panelInput('timers', manifest(START), {}));
    expect(panelInput('timers', manifest(START + 10 * 60_000), {})).toEqual({ kind: 'panel', panel: ['Pasta: done'] });
  });

  it('drops an expired message by the frame’s own time', () => {
    expect(panelInput('messages', manifest(START), {})).toEqual({ kind: 'panel', panel: ['Back at 6'] });
    expect(panelInput('messages', manifest(START + 60 * 60_000), {})).toEqual({ kind: 'panel', panel: [] });
  });
});

describe('durationWords', () => {
  it.each([
    [90_000, '90 seconds'],
    [1000, '1 second'],
    [60_000, '1 minute'],
    [600_000, '10 minutes'],
    [3_600_000, '1 hour'],
    [5_400_000, '1 hour 30 minutes'],
    [7_200_000, '2 hours'],
  ])('says %i ms as %s', (ms, words) => {
    expect(durationWords(ms)).toBe(words);
  });
});
