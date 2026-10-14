import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFetcher } from '../src/net/fetcher.js';
import { runScript, type ScriptRun, type ScriptRunInput } from '../src/modules/external/sandbox.js';
import {
  prepareScriptFetch,
  scriptFetch,
  scriptManifestSchema,
  SCRIPT_LIMITS,
  type ScriptManifest,
} from '../src/modules/external/script.js';

/**
 * The script module sandbox (RFC 017 §7), against the attacks published for
 * other JavaScript sandboxes (`fixtures/scripts/hostile/README.md`), a real
 * loopback server and the real SSRF-guarded fetcher.
 *
 * Every run is a real worker thread running real QuickJS. Nothing here stubs
 * the interpreter, because a sandbox test that does is testing the stub.
 */

const HOSTILE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scripts', 'hostile');
const hostile = (name: string): string => readFileSync(join(HOSTILE, name), 'utf8');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const refuseAll: ScriptRunInput['fetch'] = async () => {
  throw new Error('This test fetches nothing.');
};
const run = (source: string, extra: Partial<ScriptRunInput> = {}): Promise<ScriptRun> =>
  runScript({ source, config: {}, now: NOW, timeZone: 'Europe/London', fetch: refuseAll, ...extra });

const textOf = (outcome: ScriptRun): string => {
  if (!outcome.ok) throw new Error(`the run failed: ${outcome.reason} ${outcome.detail}`);
  const panel = outcome.panel as { kind: string; text?: string } | undefined;
  return panel?.text ?? '';
};

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

interface Heard {
  readonly path: string;
  readonly authorization: string | undefined;
}

/** A loopback host that records every request, and echoes the Authorization header back in a header of its own. */
async function host(address: string): Promise<{ base: string; heard: Heard[] }> {
  const heard: Heard[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    heard.push({ path: request.url ?? '', authorization: request.headers.authorization });
    if ((request.url ?? '').startsWith('/big')) {
      response.setHeader('content-type', 'text/plain');
      response.end('x'.repeat(SCRIPT_LIMITS.responseBytes + 10));
      return;
    }
    if ((request.url ?? '').startsWith('/missing')) {
      response.statusCode = 404;
      response.end('no');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-echo', request.headers.authorization ?? '');
    response.end(JSON.stringify({ ok: true, rows: [3, 4, 5] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  const at = server.address();
  if (at === null || typeof at === 'string') throw new Error('no port');
  return { base: `http://${address}:${at.port}`, heard };
}

const manifest = (input: Record<string, unknown>): ScriptManifest =>
  scriptManifestSchema.parse({ name: 'Test', contract: 1, ...input });

describe('a run that does not stop ends, and the server carries on', () => {
  it.each([
    ['loop.js', 'cpu'],
    ['redos.js', 'cpu'],
    ['memory.js', 'memory'],
    ['recursion.js', 'stack'],
  ])('%s ends as %s, inside its own limits', async (file, reason) => {
    const outcome = await run(hostile(file));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe(reason);
    expect(outcome.error).not.toContain('InternalError');
    // Stopped by the interpreter's own limits, well before the wall time.
    expect(outcome.timing.wallMs).toBeLessThan(SCRIPT_LIMITS.wallMs / 2);
    if (reason === 'cpu') expect(outcome.timing.cpuMs).toBeLessThan(SCRIPT_LIMITS.cpuMs + 100);
  });

  it('ends a run that waits for ever, at its wall time, by ending its thread', async () => {
    const outcome = await run(hostile('never.js'), { limits: { wallMs: 1500 } });
    expect(outcome).toMatchObject({ ok: false, reason: 'time' });
    expect(outcome.timing.wallMs).toBeGreaterThanOrEqual(1500);
    expect(outcome.timing.wallMs).toBeLessThan(4000);
  });

  it('runs a good script straight after every one of them', async () => {
    const outcomes = await Promise.all(
      ['loop.js', 'memory.js', 'recursion.js'].map((file) => run(hostile(file))),
    );
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
    const good = await run(`export default function run(ctx) { return { panel: { kind: 'text', text: 'fine at ' + ctx.now } }; }`);
    expect(textOf(good)).toBe(`fine at ${NOW}`);
  });
});

describe('a script reaches nothing of the host', () => {
  it('finds no process, require or host function behind ctx.fetch', async () => {
    expect(textOf(await run(hostile('escape-constructor.js')))).toBe('reached: nothing');
  });

  it('finds nothing of the host behind an error a host call threw', async () => {
    const text = textOf(
      await run(hostile('escape-rejection.js'), {
        fetch: scriptFetch(createFetcher(), manifest({ hosts: ['example.com'] }), {}, () => 5000),
      }),
    );
    // The refusal is an Error made inside the interpreter: its constructor
    // chain is the interpreter's, and so is the global it leads to.
    expect(text).toBe('reached: nothing / Error');
  });

  it('cannot import anything', async () => {
    const outcome = await run(`import fs from 'fs';\nexport default function run() { return {}; }`);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    if (!outcome.ok) expect(outcome.detail).toContain('cannot import');
  });

  it('leaves nothing for the next run, and two runs at once cannot see each other', async () => {
    const source = hostile('pollute.js');
    expect(textOf(await run(source))).toBe('seen: undefined,undefined');
    expect(textOf(await run(source))).toBe('seen: undefined,undefined');
    const together = await Promise.all([run(source), run(source), run(source)]);
    expect(together.map(textOf)).toEqual(['seen: undefined,undefined', 'seen: undefined,undefined', 'seen: undefined,undefined']);
  });

  it('is handed a frozen ctx', async () => {
    const text = textOf(
      await run(`export default function run(ctx) {
        'use strict';
        let changed = 0;
        try { ctx.fetch = null; changed++; } catch (e) {}
        try { ctx.config.extra = 1; changed++; } catch (e) {}
        return { panel: { kind: 'text', text: 'changed ' + changed + ' ' + Object.isFrozen(ctx) } };
      }`, { config: { a: '1' } }),
    );
    expect(text).toBe('changed 0 true');
  });
});

describe('what a run hands back is read by the wall’s schemas, and rejected rather than coerced', () => {
  it('refuses an output over its size before any schema reads it', async () => {
    expect(await run(hostile('huge-output.js'))).toMatchObject({ ok: false, reason: 'output' });
  });

  it.each([
    ['a misshapen panel', `{ panel: { kind: 'text', text: 7 } }`, 'panel.text'],
    ['a key the panel does not have', `{ panel: { kind: 'text', text: 'x', colour: 'red' } }`, 'panel'],
    ['a key the output does not have', `{ panel: { kind: 'text', text: 'x' }, html: '<b>' }`, 'html'],
    ['nothing at all', `{}`, 'return a panel'],
    ['a signal with no key', `{ signals: [{ title: 'x' }] }`, 'signals'],
  ])('refuses %s', async (_what, value, where) => {
    const outcome = await run(`export default async function run() { return ${value}; }`);
    expect(outcome).toMatchObject({ ok: false, reason: 'shape', error: 'The module returned something the wall cannot draw.' });
    if (!outcome.ok) expect(outcome.detail).toContain(where);
  });

  it('takes a good panel and good signals', async () => {
    const outcome = await run(`export default async function run() {
      return { panel: { kind: 'stat', value: '4', title: 'Bins' }, signals: [{ key: 'bins', title: 'Bins out tonight', severity: 'Minor' }] };
    }`);
    expect(outcome).toMatchObject({
      ok: true,
      panel: { kind: 'stat', value: '4', title: 'Bins' },
      signals: { signals: [{ key: 'bins', title: 'Bins out tonight', severity: 'Minor' }] },
    });
  });

  it('says a syntax error is one, and a missing default function', async () => {
    expect(await run(`export default function run( {`)).toMatchObject({ ok: false, reason: 'syntax' });
    expect(await run(`export default 3;`)).toMatchObject({ ok: false, reason: 'no-run' });
    const thrown = await run(`export default function run() { throw new Error('the feed changed'); }`);
    expect(thrown).toMatchObject({ ok: false, reason: 'error', error: 'The module’s code stopped with an error.' });
    if (!thrown.ok) expect(thrown.detail).toBe('Error: the feed changed');
  });

  it('gives a wall-clock reading in the household’s zone, which QuickJS has no Intl for', async () => {
    const text = textOf(
      await run(`export default function run(ctx) { const t = ctx.local(ctx.now); return { panel: { kind: 'text', text: [t.year, t.month, t.day, t.hour, t.minute, t.weekday].join(' ') } }; }`, {
        timeZone: 'Pacific/Chatham',
      }),
    );
    // 12:00 UTC on Wednesday 14 October 2026 is 01:45 on Thursday the 15th in Chatham.
    expect(text).toBe('2026 10 15 1 45 4');
  });
});

describe('ctx.fetch reaches only the hosts the script declared, through the guard', () => {
  it('refuses an undeclared host before anything leaves', async () => {
    const a = await host('127.0.0.1');
    const fetch = scriptFetch(createFetcher(), manifest({ hosts: ['127.0.0.2'], allowLan: true }), {}, () => 5000);
    const outcome = await run(
      `export default async function run(ctx) {
        try { await ctx.fetch(ctx.config.to); return { panel: { kind: 'text', text: 'reached' } }; }
        catch (e) { return { panel: { kind: 'text', text: e.message } }; }
      }`,
      { fetch, config: { to: `${a.base}/` } },
    );
    expect(textOf(outcome)).toBe('127.0.0.1 is not one of this module’s hosts.');
    expect(a.heard).toEqual([]);
  });

  it('refuses a loopback or private host it declared, until the household allows its network', async () => {
    const a = await host('127.0.0.1');
    const source = `export default async function run(ctx) {
      try { const res = await ctx.fetch(ctx.config.to); return { panel: { kind: 'text', text: 'got ' + (await res.json()).rows.length } }; }
      catch (e) { return { panel: { kind: 'text', text: 'refused' } }; }
    }`;
    const closed = scriptFetch(createFetcher(), manifest({ hosts: ['127.0.0.1'] }), {}, () => 5000);
    expect(textOf(await run(source, { fetch: closed, config: { to: `${a.base}/` } }))).toBe('refused');
    expect(a.heard).toEqual([]);
    const open = scriptFetch(createFetcher(), manifest({ hosts: ['127.0.0.1'], allowLan: true }), {}, () => 5000);
    expect(textOf(await run(source, { fetch: open, config: { to: `${a.base}/` } }))).toBe('got 3');
    expect(a.heard).toHaveLength(1);
  });

  it('allows five fetches a run and refuses the sixth', async () => {
    const a = await host('127.0.0.1');
    const fetch = scriptFetch(createFetcher(), manifest({ hosts: ['127.0.0.1'], allowLan: true }), {}, () => 5000);
    const outcome = await run(
      `export default async function run(ctx) {
        let n = 0;
        try { for (let i = 0; i < 9; i++) { await ctx.fetch(ctx.config.to); n++; } } catch (e) { return { panel: { kind: 'text', text: n + ': ' + e.message } }; }
        return { panel: { kind: 'text', text: 'all ' + n } };
      }`,
      { fetch, config: { to: `${a.base}/` } },
    );
    expect(textOf(outcome)).toBe('5: A run may fetch at most 5 times.');
    expect(a.heard).toHaveLength(5);
  });

  it('refuses an answer over a megabyte, and hands a 404 back as an answer', async () => {
    const a = await host('127.0.0.1');
    const fetch = scriptFetch(createFetcher(), manifest({ hosts: ['127.0.0.1'], allowLan: true }), {}, () => 5000);
    const outcome = await run(
      `export default async function run(ctx) {
        const missing = await ctx.fetch(ctx.config.to + '/missing');
        let big = 'read';
        try { await ctx.fetch(ctx.config.to + '/big'); } catch (e) { big = 'refused'; }
        return { panel: { kind: 'text', text: missing.ok + ' ' + missing.status + ' ' + big } };
      }`,
      { fetch, config: { to: a.base } },
    );
    expect(textOf(outcome)).toBe('false 404 refused');
  });

  it('never lets a script see a secret, by ctx, by its host’s echo, or by sending it elsewhere', async () => {
    const secretHost = await host('127.0.0.1');
    const otherHost = await host('127.0.0.2');
    const secret = 'mw-test-secret-4f2a9c';
    const fetch = scriptFetch(
      createFetcher(),
      manifest({
        hosts: ['127.0.0.1', '127.0.0.2'],
        allowLan: true,
        secrets: [{ key: 'token', label: 'Token', host: '127.0.0.1' }],
      }),
      { token: secret },
      () => 5000,
    );
    const outcome = await run(hostile('secret-hunt.js'), {
      fetch,
      config: { secret_host: secretHost.base, other_host: otherHost.base },
    });
    expect(textOf(outcome)).toBe('other=refused');
    // The host it was declared for was sent it, and only that host.
    expect(secretHost.heard).toEqual([{ path: '/echo', authorization: `Bearer ${secret}` }]);
    expect(otherHost.heard.length).toBeGreaterThan(0);
    for (const heard of otherHost.heard) {
      expect(heard.authorization).toBeUndefined();
      expect(heard.path).toMatch(/^\/leak\?d=/);
      expect(decodeURIComponent(heard.path)).not.toContain(secret);
    }
    // And it really did send everything it could see.
    expect(decodeURIComponent(otherHost.heard.map((h) => h.path.slice('/leak?d='.length)).join(''))).toContain('ctx.fetch()=');
  });
});

describe('prepareScriptFetch', () => {
  const m = manifest({
    hosts: ['api.example.com', 'cdn.example.com'],
    secrets: [{ key: 'key', label: 'Key', host: 'api.example.com' }],
  });
  const ask = (url: string, headers?: Record<string, string>) =>
    prepareScriptFetch(m, { key: 'k1' }, { url, options: headers === undefined ? {} : { headers } });

  it('fills a secret only for its own host, and never in the address', () => {
    expect(ask('https://api.example.com/x', { a: 'Bearer {secret:key}' })).toMatchObject({ ok: true, headers: { a: 'Bearer k1' } });
    expect(ask('https://cdn.example.com/x', { a: 'Bearer {secret:key}' })).toEqual({ ok: false, error: 'The secret key is for api.example.com only.' });
    expect(ask('https://api.example.com/x?k={secret:key}')).toEqual({ ok: false, error: 'A secret goes in a header, never in the address.' });
    expect(ask('https://api.example.com/x?k=%7Bsecret:key%7D')).toEqual({ ok: false, error: 'A secret goes in a header, never in the address.' });
    expect(ask('https://api.example.com/x', { a: '{secret:other}' })).toEqual({ ok: false, error: 'There is no secret called other.' });
  });

  it('compares the host exactly, and refuses a password in an address', () => {
    expect(ask('https://evil.api.example.com/')).toMatchObject({ ok: false });
    expect(ask('https://api.example.com.evil.net/')).toMatchObject({ ok: false });
    expect(ask('https://user:pw@api.example.com/')).toMatchObject({ ok: false });
    expect(ask('not an address')).toMatchObject({ ok: false });
  });
});

describe('the manifest', () => {
  it('refuses a secret for a host it does not declare, a host twice, and a host with a port or a path', () => {
    const parse = (input: Record<string, unknown>) => scriptManifestSchema.safeParse({ name: 'x', contract: 1, ...input }).success;
    expect(parse({ hosts: ['a.example'], secrets: [{ key: 'k', label: 'K', host: 'b.example' }] })).toBe(false);
    expect(parse({ hosts: ['a.example', 'a.example'] })).toBe(false);
    expect(parse({ hosts: ['a.example:8080'] })).toBe(false);
    expect(parse({ hosts: ['a.example/path'] })).toBe(false);
    expect(parse({ hosts: ['A.example'] })).toBe(false);
    expect(parse({ hosts: ['a.example'], secrets: [{ key: 'k', label: 'K', host: 'a.example' }] })).toBe(true);
    expect(parse({ hosts: [], nonsense: 1 })).toBe(false);
  });
});
