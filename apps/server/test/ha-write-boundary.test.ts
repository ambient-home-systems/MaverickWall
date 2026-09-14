import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetcher } from '../src/net/fetcher.js';
import {
  callService,
  HA_SERVICES,
  type Connection,
} from '../src/modules/homeassistant/client.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

/**
 * Rule 12's mechanism, and the reason it needs one.
 *
 * Rule 12 used to read "Home Assistant integration is READ-ONLY. No service
 * calls, no control." The valuable thing about it was never its strictness — it
 * was that `grep` answered it. There was no POST to Home Assistant anywhere in
 * this repository, a person could confirm that in one command, and no reviewer
 * had to reason about intent.
 *
 * RFC 012 spends that property to buy a shopping list you can tick. This file
 * is what it is spent on.
 *
 * **Two halves, because they fail differently.** The constant says what may be
 * called; a third member appearing in it is the obvious regression and the easy
 * one to catch. The harder one is a *second door* — a `postJson` somewhere else
 * that never reads the constant at all — and a test for the allowlist alone
 * cannot see it, because a constant cannot see a call site that ignores it. So
 * the scan is for the door and the runtime check is for the list, and neither
 * substitutes for the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SERVER_SRC = 'apps/server/src';

/**
 * The adapter, named rather than pattern-matched.
 *
 * `net/fetcher.ts` *implements* `postJson`, so its own declaration contains the
 * token and is not a door. An exemption list of one, in the open, is honest —
 * and it is deliberately not "skip this file", which would let a real call
 * hide behind the declaration: the file is exempt for exactly one line, and
 * the assertion below says which one.
 */
const ADAPTER = `${SERVER_SRC}/net/fetcher.ts`;
const ADAPTER_DECLARATION = 'async postJson(request: PostJsonRequest): Promise<PostJsonOutcome> {';

/**
 * The second door RFC 013 §6.3 opened, and why this file had to grow a scan for
 * it.
 *
 * When this test was written, `fetch` was GET-only and `postJson` was the only
 * way a POST could leave this process — so scanning for `postJson(` scanned for
 * every POST. That stopped being true the moment `FetchRequest` gained a
 * `method`: `fetcher.fetch({ method: 'POST', url: haUrl, body })` is a POST at
 * a household's Home Assistant that never reads `HA_SERVICES`, and the scan
 * above cannot see it. It is the exact failure RFC 013 §6.3 warns about — two
 * RFCs each owning a slightly different version of one method allowlist.
 *
 * The scan is on the **call**, deliberately, and not on the token. A bare
 * `method: 'POST'` occurs in `http/app.ts`, where `authApi` builds an
 * in-process `Request` and hands it to Better Auth's handler — that never
 * touches a socket, so a token scan would report a false positive and buy an
 * exemption list, which is how a guard becomes a list somebody remembers to
 * shrink. A `.fetch(...)` call is the outbound boundary and nothing else is.
 */
const POST_METHOD = "method: 'POST'";

/**
 * The argument text of every `.fetch(` call in a file, brace-matched.
 *
 * Crude in the same way `enclosingFunction` above is crude, and for the same
 * reason: a real parse would answer a question nobody is asking. What is being
 * checked is whether any call site asks the guarded boundary for a POST.
 */
function fetchCallArguments(source: string): string[] {
  const calls: string[] = [];
  const token = '.fetch(';
  for (let at = source.indexOf(token); at !== -1; at = source.indexOf(token, at + 1)) {
    let depth = 0;
    for (let i = at + token.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(at, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

/** The one door. */
const DOOR = `${SERVER_SRC}/modules/homeassistant/client.ts`;

function filesUnder(path: string): string[] {
  const full = join(ROOT, path);
  const stat = statSync(full);
  if (stat.isFile()) return [full];
  const out: string[] = [];
  for (const name of readdirSync(full)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const child = join(full, name);
    if (statSync(child).isDirectory()) out.push(...filesUnder(join(path, name)));
    else if (name.endsWith('.ts')) out.push(child);
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every line in the server's source carrying the token, with its location. */
function postJsonHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of filesUnder(SERVER_SRC)) {
    const name = relative(ROOT, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        if (text.includes('postJson(')) hits.push({ file: name, line: index + 1, text: text.trim() });
      });
  }
  return hits;
}

/**
 * Which function a line is inside, by the nearest declaration above it.
 *
 * Crude on purpose. A real parse would be more correct and would answer a
 * question nobody is asking: what is being checked is whether the call sites
 * are all in one place, and a nesting this misreads is a file already shaped
 * badly enough to be worth a second look.
 */
function enclosingFunction(lines: string[], lineNumber: number): string {
  for (let i = lineNumber - 1; i >= 0; i--) {
    const match = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i] ?? '');
    if (match) return match[1] ?? '?';
  }
  return '<top level>';
}

describe('the source scan: one door, and it is this one', () => {
  it('has exactly one call site, in the Home Assistant client', () => {
    const calls = postJsonHits().filter(
      (hit) => !(hit.file === ADAPTER && hit.text === ADAPTER_DECLARATION),
    );

    expect(
      calls.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`),
      'postJson( outside the Home Assistant client:\n' +
        calls.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join('\n'),
    ).toHaveLength(1);
    expect(calls[0]?.file).toBe(DOOR);
  });

  it('holds that call inside one function', () => {
    const lines = readFileSync(join(ROOT, DOOR), 'utf8').split('\n');
    const inside = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter((row) => row.text.includes('postJson('))
      .map((row) => enclosingFunction(lines, row.line));

    // Not "at least one is callService": a second function in this same file
    // posting its own path is the identical fault one door along, and would
    // pass a check that only looked for the name it expected.
    expect(new Set(inside)).toEqual(new Set(['callService']));
  });

  it('exempts the adapter for one line and no more', () => {
    // The exemption has to point at something, or it is a comment — and if the
    // declaration is ever reworded this test says so rather than quietly
    // widening to cover the whole file.
    const adapter = readFileSync(join(ROOT, ADAPTER), 'utf8');
    expect(adapter).toContain(ADAPTER_DECLARATION);
    expect(adapter.split('\n').filter((line) => line.includes('postJson(')).length).toBe(1);
  });

  it('is looking at something — the scan itself can go blind', () => {
    // A file list that silently resolves to nothing passes for ever, which is
    // this project's own complaint about an assertion no edit can turn red.
    const files = filesUnder(SERVER_SRC).map((file) => relative(ROOT, file));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(DOOR);
    expect(files).toContain(ADAPTER);
    expect(postJsonHits().length).toBeGreaterThan(0);
  });
});

describe('the other way a POST could leave', () => {
  it('has no call site at all outside the JSON adapter', () => {
    /*
     * `fetch` grew a method in RFC 013 §6.3 and a POST through it would bypass
     * `HA_SERVICES` completely. Nothing needs one — CalDAV speaks `PROPFIND`
     * and `REPORT` — so the honest guard is zero rather than an allowlist, and
     * a future caller that genuinely wants one has to change this line and say
     * why in the same commit.
     *
     * The adapter's own `POST: 'refuse'` in `REDIRECT_POLICY` and its
     * `method: 'POST'` when it builds `postJson`'s wire request are the
     * implementation and are not doors, so they are exempted by file and
     * counted rather than skipped — the same shape as the declaration
     * exemption above.
     */
    const posting: string[] = [];
    let calls = 0;
    for (const file of filesUnder(SERVER_SRC)) {
      const name = relative(ROOT, file);
      for (const call of fetchCallArguments(readFileSync(file, 'utf8'))) {
        calls++;
        if (call.includes(POST_METHOD)) posting.push(`${name}  ${call.slice(0, 120)}`);
      }
    }

    expect(
      posting,
      `a .fetch() asking for POST — a POST that never reads HA_SERVICES:\n${posting.join('\n')}`,
    ).toEqual([]);

    // And the scan is looking at something. A brace matcher that silently found
    // no calls would pass for ever, which is this project's own complaint about
    // an assertion no edit can turn red.
    expect(calls).toBeGreaterThan(10);
  });
});

describe('the allowlist', () => {
  it('has exactly two members, and exactly one of them is the write', () => {
    expect(Object.keys(HA_SERVICES).sort()).toEqual(['read', 'write']);
    expect(Object.values(HA_SERVICES)).toEqual(['todo/get_items', 'todo/update_item']);

    // The rule is about writes rather than about service calls, and this is
    // where that distinction is a fact rather than a sentence in a document:
    // `get_items` cannot change anything in a house and `update_item` can.
    const writes = Object.entries(HA_SERVICES).filter(([role]) => role === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toBe('todo/update_item');
  });

  it('is frozen', () => {
    // Not decoration: this is what a test can read where `grep` used to answer.
    expect(Object.isFrozen(HA_SERVICES)).toBe(true);
  });

  it('names nothing that could reach anything but a to-do list', () => {
    // The firebreak, spelled out. RFC 012 §2.3: the moment one POST exists,
    // "it is just one more service" is an argument available for ever.
    for (const service of Object.values(HA_SERVICES)) {
      expect(service.startsWith('todo/')).toBe(true);
    }
    for (const refused of [
      'light',
      'switch',
      'cover',
      'lock',
      'alarm_control_panel',
      'climate',
      'scene',
      'script',
      'automation',
      'camera',
    ]) {
      expect(Object.values(HA_SERVICES).some((s) => s.startsWith(`${refused}/`))).toBe(false);
    }
    // And the three inside `todo` that are refused here rather than for ever.
    for (const later of ['todo/add_item', 'todo/remove_item', 'todo/remove_completed_items']) {
      expect(Object.values(HA_SERVICES)).not.toContain(later);
    }
  });
});

afterAll(closeFakeHomeAssistants);

describe('the runtime half: what was actually posted', () => {
  async function connected(): Promise<{ connection: Connection; ha: Awaited<ReturnType<typeof fakeHomeAssistant>> }> {
    const ha = await fakeHomeAssistant();
    return {
      ha,
      connection: {
        mode: 'manual',
        baseUrl: `${ha.base}/api`,
        token: TOKEN,
        policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
        host: '127.0.0.1',
      },
    };
  }

  it('reads a list, and every path it asked for is on the allowlist', async () => {
    const { ha, connection } = await connected();
    const result = await callService(
      createFetcher(),
      connection,
      HA_SERVICES.read,
      { entity_id: 'todo.shopping' },
      { returnResponse: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answered = JSON.parse(result.body) as {
      service_response: Record<string, { items: { uid: string; summary: string }[] }>;
    };
    /*
     * Two of the three, not three: asked with no `status`, Home Assistant
     * answers `needs_action` alone, and the fake honours that default. `i-3`
     * is completed. It is why the module names both statuses on every read
     * (`todo-lists.test.ts`) — a reader relying on the default could never draw
     * a ticked item, and `showDone` would be a switch that does nothing.
     */
    expect(answered.service_response['todo.shopping']?.items.map((i) => i.uid)).toEqual([
      'i-1',
      'i-2',
    ]);

    /*
     * The assertion this file exists for, and it is stated as a subset rather
     * than as an equality: what matters is that nothing left the list, not that
     * everything on the list was used.
     */
    const permitted = new Set(Object.values(HA_SERVICES).map((s) => `/api/services/${s}`));
    expect(ha.posts.length).toBeGreaterThan(0);
    for (const post of ha.posts) expect(permitted.has(post.path)).toBe(true);
  });

  it('writes one item, and still posts nowhere else', async () => {
    const { ha, connection } = await connected();
    const result = await callService(createFetcher(), connection, HA_SERVICES.write, {
      entity_id: 'todo.shopping',
      item: 'i-2',
      status: 'completed',
    });

    expect(result.ok).toBe(true);
    // The uid is the identity, so the *second* Milk is the one that moved and
    // the first is untouched. Matching by summary returns the first hit, and
    // that is a bug nobody can reproduce on their own list.
    expect(ha.todo['todo.shopping']?.items.map((i) => i.status)).toEqual([
      'needs_action',
      'completed',
      'completed',
    ]);

    const permitted = new Set(Object.values(HA_SERVICES).map((s) => `/api/services/${s}`));
    expect(ha.posts.map((p) => p.path)).toEqual(['/api/services/todo/update_item']);
    for (const post of ha.posts) expect(permitted.has(post.path)).toBe(true);
  });

  it('reaches no service call at all across the whole read path', async () => {
    // The reads this application already does are GETs and stay GETs. If a
    // module ever starts reaching Home Assistant through a service call without
    // going through `callService`, this is the assertion that notices.
    const { ha, connection } = await connected();
    const fetcher = createFetcher();
    const { call } = await import('../src/modules/homeassistant/client.js');
    await call(fetcher, connection, '/');
    await call(fetcher, connection, '/states');
    await call(fetcher, connection, '/calendars');

    expect(ha.posts).toEqual([]);
  });

  it('says what went wrong in the upstream’s own words', async () => {
    // §7.4: the tick failing is fine, the tick failing silently is not. This is
    // the whole reason `postJson` keeps a non-2xx body where `fetch` does not.
    const { connection } = await connected();
    const result = await callService(createFetcher(), connection, HA_SERVICES.write, {
      entity_id: 'todo.read_only',
      item: 'r-1',
      status: 'completed',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('does not support this service');
  });

  it('names the one 400 that is our fault rather than theirs', async () => {
    // A `get_items` without `?return_response` is the single failure on this
    // path that means our request was malformed. Home Assistant answers a bare
    // 400 and puts the diagnosis in the prose, so this is the one place in the
    // client matched on wording.
    const { connection } = await connected();
    const result = await callService(createFetcher(), connection, HA_SERVICES.read, {
      entity_id: 'todo.shopping',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not asked correctly');
    expect(result.suggestion).toContain('fault in Maverick Wall');
  });
});
