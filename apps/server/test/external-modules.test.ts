import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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
import { pollExternalModules } from '../src/modules/external/index.js';
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * The third-party module path, end to end (docs/rfc-001-module-framework.md).
 *
 * A real HTTP module on loopback, added through the real admin route, polled by
 * the real job, and read back from the manifest a real screen polls. The tests
 * that matter are: a valid panel reaches the wall, and a body that is not Panel
 * Data is refused and never drawn.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

interface FakeModule {
  base: string;
  body: () => unknown;
  setBody: (b: unknown) => void;
  /** null means the module serves no `/signals` at all (a 404). */
  setSignals: (s: unknown) => void;
  /** Arbitrary JSON at `/data`, for a recipe to fetch and transform. */
  setData: (d: unknown) => void;
}

async function fakeModule(): Promise<FakeModule> {
  let current: unknown = { kind: 'stat', title: 'Bins', value: '2', caption: 'days' };
  let signals: unknown = null;
  let data: unknown = {};
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    if (url === '/maverick.json') {
      response.end(JSON.stringify({ name: 'Bin day', version: '1.0.0', contract: 1 }));
      return;
    }
    if (url === '/panel') {
      response.end(JSON.stringify(current));
      return;
    }
    if (url === '/data') {
      response.end(JSON.stringify(data));
      return;
    }
    if (url === '/signals') {
      // null: the module offers no signals, which a 404 tells the poll.
      if (signals === null) {
        response.writeHead(404);
        response.end('{}');
        return;
      }
      response.end(JSON.stringify(signals));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    body: () => current,
    setBody: (b) => {
      current = b;
    },
    setSignals: (s) => {
      signals = s;
    },
    setData: (d) => {
      data = d;
    },
  };
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ext-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher,
    clientAddress: () => `10.9.0.${++n}`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const form = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'H', email: `e${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  interface Interrupt {
    ruleId: string;
    source: string;
    action: string;
    title: string;
    severity: string;
    dismissible: boolean;
    wakeScreen: boolean;
    piercesNightMode: boolean;
  }
  const manifest = async (): Promise<{
    panels: Record<string, unknown>;
    display: { blocks: string[] };
    interrupts: Interrupt[];
  }> => {
    const issued = issueDisplayToken();
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('s1','Wall',?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
    ).run(issued.tokenHash, at, at, at);
    const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
    return (await res.json()) as {
      panels: Record<string, unknown>;
      display: { blocks: string[] };
      interrupts: Interrupt[];
    };
  };

  return { db, call, form, manifest, poll: () => pollExternalModules(db, fetcher) };
}

function moduleId(db: ReturnType<typeof openDatabase>['db']): string {
  return (db.prepare(`SELECT id FROM external_modules LIMIT 1`).get() as { id: string }).id;
}

describe('third-party modules', () => {
  it('adds a module, polls it, and draws its panel on the wall', async () => {
    const h = await harness();
    const mod = await fakeModule();

    const added = await h.form('/admin/modules', { url: mod.base });
    expect(added.status).toBe(302);

    const id = moduleId(h.db);
    const key = `ext:${id}`;

    // Its block is on the wall, and the module took its own name from /maverick.json.
    const before = await h.manifest();
    expect(before.display.blocks).toContain(key);
    const listed = await (await h.call('/admin/modules')).text();
    expect(listed).toContain('Bin day');

    // After a poll the manifest carries the validated panel under its key.
    await h.poll();
    const after = await h.manifest();
    expect(after.panels[key]).toEqual({ kind: 'stat', title: 'Bins', value: '2', caption: 'days' });
  });

  it('refuses a body that is not Panel Data, and records the error', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setBody({ kind: 'website', url: 'https://evil' });
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);

    await h.poll();
    const row = h.db.prepare(`SELECT panel, last_error FROM external_modules WHERE id = ?`).get(id) as {
      panel: string | null;
      last_error: string | null;
    };
    expect(row.panel).toBeNull();
    expect(row.last_error).not.toBeNull();
    // Nothing drawn: no panel under the key.
    expect((await h.manifest()).panels[`ext:${id}`]).toBeUndefined();
  });

  it('turning a module off takes its block off the wall; removing it deletes it', async () => {
    const h = await harness();
    const mod = await fakeModule();
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);
    const key = `ext:${id}`;

    await h.form(`/admin/modules/${id}/toggle`, {});
    expect((await h.manifest()).display.blocks).not.toContain(key);

    await h.form(`/admin/modules/${id}/remove`, {});
    expect(h.db.prepare(`SELECT count(*) c FROM external_modules`).get()).toEqual({ c: 0 });
  });
});

describe('module signals and interrupts', () => {
  const oneSignal = { signals: [{ key: 'bins', title: 'Bins out tonight' }] };

  it('does nothing until the household arms the module', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setSignals(oneSignal);
    await h.form('/admin/modules', { url: mod.base });
    await h.poll();

    // The signal is cached, but the module is unarmed (alerts_action defaults to
    // 'none'), so the wall shows no interrupt.
    const id = moduleId(h.db);
    const row = h.db
      .prepare(`SELECT signals, alerts_action FROM external_modules WHERE id = ?`)
      .get(id) as { signals: string | null; alerts_action: string };
    expect(row.signals).not.toBeNull();
    expect(row.alerts_action).toBe('none');
    expect((await h.manifest()).interrupts).toEqual([]);
    // No rule exists to fire it.
    expect(h.db.prepare(`SELECT count(*) c FROM interrupt_rules`).get()).toEqual({ c: 0 });
  });

  it('raises a banner once armed, carrying the module’s own title', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setSignals(oneSignal);
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);
    await h.poll();

    await h.form(`/admin/modules/${id}/alerts`, { action: 'banner' });

    const interrupts = (await h.manifest()).interrupts;
    expect(interrupts).toHaveLength(1);
    const it0 = interrupts[0]!;
    expect(it0.action).toBe('banner');
    expect(it0.title).toBe('Bins out tonight');
    expect(it0.source).toBe(`ext:${id}`);
    // The rule scoped to this module and only this module.
    expect(it0.ruleId).toBe(`extrule-${id}`);
  });

  it('caps a module to its chosen action however severe it claims to be', async () => {
    const h = await harness();
    const mod = await fakeModule();
    // The module claims Extreme — the severity that, on a weather rule, is a
    // waking takeover. It must not escalate a module past the household's cap.
    mod.setSignals({ signals: [{ key: 'flood', title: 'FLOOD', severity: 'Extreme' }] });
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);
    await h.poll();
    await h.form(`/admin/modules/${id}/alerts`, { action: 'banner' });

    const it0 = (await h.manifest()).interrupts[0]!;
    expect(it0.action).toBe('banner');
    // Never wakes a dark screen, never pierces night mode — reserved for real
    // safety alerts, unavailable to any module whatever it declares.
    expect(it0.wakeScreen).toBe(false);
    expect(it0.piercesNightMode).toBe(false);
    // And always clearable from the wall.
    expect(it0.dismissible).toBe(true);
  });

  it('an armed module still cannot trip a built-in weather rule', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setSignals({ signals: [{ key: 'x', title: 'Not a real warning', severity: 'Extreme' }] });
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);

    // Seed the shipped NWS ladder alongside the module's own armed rule.
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO interrupt_rules
           (id, name, enabled, trigger, conditions, action, priority, wake_screen,
            pierces_night_mode, min_dwell_sec, dismissible, reassert_after_sec,
            created_at, updated_at)
         VALUES ('nws-extreme','Extreme',1,'nws',?, 'takeover_and_wake', 100, 1, 1, 0, 0, NULL, ?, ?)`,
      )
      .run(JSON.stringify({ minSeverity: 'Extreme' }), at, at);
    await h.poll();
    await h.form(`/admin/modules/${id}/alerts`, { action: 'banner' });

    const interrupts = (await h.manifest()).interrupts;
    // The Extreme-claiming module signal fires only its own banner, never the
    // NWS takeover — source scoping keeps them apart.
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.source).toBe(`ext:${id}`);
    expect(interrupts[0]!.action).toBe('banner');
  });

  it('a 404 on /signals clears the cache; disarming removes the rule', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setSignals(oneSignal);
    await h.form('/admin/modules', { url: mod.base });
    const id = moduleId(h.db);
    await h.poll();
    await h.form(`/admin/modules/${id}/alerts`, { action: 'takeover' });
    expect((await h.manifest()).interrupts).toHaveLength(1);

    // The module drops its /signals endpoint entirely: the cache empties and the
    // interrupt goes with it.
    mod.setSignals(null);
    await h.poll();
    expect(
      (h.db.prepare(`SELECT signals FROM external_modules WHERE id = ?`).get(id) as {
        signals: string | null;
      }).signals,
    ).toBeNull();
    expect((await h.manifest()).interrupts).toEqual([]);

    // Disarming the module deletes its rule.
    await h.form(`/admin/modules/${id}/alerts`, { action: 'none' });
    expect(h.db.prepare(`SELECT count(*) c FROM interrupt_rules`).get()).toEqual({ c: 0 });
  });
});

describe('the module catalogue (Phase A1)', () => {
  it('lists the built-in catalogue on the Browse page', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/modules/browse')).text();
    expect(html).toContain('Countdown');
    expect(html).toContain('by Maverick Wall');
    // Install deep-links back to the add form with the entry id.
    expect(html).toContain('admin/modules?install=countdown-example#add');
  });

  it('Install pre-fills the add form from the catalogue entry', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/modules?install=countdown-example')).text();
    // The entry's suggested address is filled in, and its install hint is shown.
    expect(html).toContain('value="http://localhost:9000"');
    expect(html).toContain('examples/example-module');
  });

  it('an unknown install id just shows the ordinary add form', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/modules?install=nope')).text();
    // No prefilled value, and the page still renders.
    expect(html).not.toContain('value="http://localhost:9000"');
    expect(html).toContain('Add a module');
  });

  it('a recipe entry offers a config-prompt install, and installs a recipe row', async () => {
    const h = await harness();
    // The install page renders an input per config field, its default pre-filled.
    const form = await (await h.call('/admin/modules/install/outside-temperature')).text();
    expect(form).toContain('Install Outside temperature');
    expect(form).toContain('name="cfg_lat"');
    expect(form).toContain('value="51.5074"');
    expect(form).toContain('name="cfg_lon"');

    // Submitting the household's values creates a recipe row with that config —
    // no JSON pasted. (Not polled: it would reach the real Open-Meteo feed.)
    const added = await h.form('/admin/modules/install/outside-temperature', {
      name: 'Weather',
      cfg_lat: '40.7',
      cfg_lon: '-74.0',
    });
    expect(added.status).toBe(302);

    const row = h.db
      .prepare(`SELECT kind, name, config FROM external_modules LIMIT 1`)
      .get() as { kind: string; name: string; config: string };
    expect(row.kind).toBe('recipe');
    expect(row.name).toBe('Weather');
    expect(JSON.parse(row.config)).toEqual({ lat: '40.7', lon: '-74.0' });
  });

  it('the Browse page routes a recipe entry to its install page, a service to the form', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/modules/browse')).text();
    // Recipe → dedicated install page; service → the pre-fill deep link.
    expect(html).toContain('admin/modules/install/outside-temperature');
    expect(html).toContain('admin/modules?install=countdown-example#add');
  });

  it('an unknown or service id on the recipe install route redirects to Browse', async () => {
    const h = await harness();
    expect((await h.call('/admin/modules/install/countdown-example')).status).toBe(302);
    expect((await h.call('/admin/modules/install/nope')).status).toBe(302);
  });

  it('an installed catalogue module works end to end through the add form', async () => {
    // The catalogue is discovery, not a separate install path: it fills the same
    // form, which adds the same kind of module. Prove the module it points at is
    // real by running it and drawing its panel.
    const h = await harness();
    const mod = await fakeModule();
    await h.form('/admin/modules', { url: mod.base, name: 'Countdown' });
    const id = moduleId(h.db);
    await h.poll();
    expect((await h.manifest()).panels[`ext:${id}`]).toEqual({
      kind: 'stat',
      title: 'Bins',
      value: '2',
      caption: 'days',
    });
  });
});

describe('recipe modules (Phase B1)', () => {
  it('runs a recipe against a real feed and draws the transformed panel', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setData({ bitcoin: { gbp: 51234.5 } });
    // allowLan lets the recipe reach the loopback test server, the way a
    // household would grant a recipe pointed at a service on their own network.
    const manifest = JSON.stringify({
      name: 'Bitcoin',
      contract: 1,
      fetch: { url: `${mod.base}/data`, allowLan: true },
      panel: { kind: 'stat', title: 'Bitcoin', value: '{bitcoin.gbp | currency:GBP}', caption: 'GBP' },
    });
    const added = await h.form('/admin/modules/recipe', { manifest });
    expect(added.status).toBe(302);

    const id = moduleId(h.db);
    // It is a recipe row, and its block is on the wall.
    const row = h.db.prepare(`SELECT kind FROM external_modules WHERE id = ?`).get(id) as {
      kind: string;
    };
    expect(row.kind).toBe('recipe');

    await h.poll();
    expect((await h.manifest()).panels[`ext:${id}`]).toEqual({
      kind: 'stat',
      title: 'Bitcoin',
      value: '£51234.50',
      caption: 'GBP',
    });
  });

  it('refuses a loopback fetch unless the recipe opted into the LAN', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setData({ x: 1 });
    // No allowLan → public https only. The SSRF guard blocks the loopback fetch.
    const manifest = JSON.stringify({
      name: 'Blocked',
      contract: 1,
      fetch: { url: `${mod.base}/data` },
      panel: { kind: 'stat', value: '{x}' },
    });
    await h.form('/admin/modules/recipe', { manifest });
    const id = moduleId(h.db);
    await h.poll();

    const row = h.db.prepare(`SELECT panel, last_error FROM external_modules WHERE id = ?`).get(id) as {
      panel: string | null;
      last_error: string | null;
    };
    expect(row.panel).toBeNull();
    expect(row.last_error).not.toBeNull();
  });

  it('rejects an invalid recipe at the form, adding nothing', async () => {
    const h = await harness();
    const res = await h.form('/admin/modules/recipe', {
      // `evil` is not an allowed formatter.
      manifest: JSON.stringify({
        name: 'x',
        contract: 1,
        fetch: { url: 'https://example.com/x' },
        panel: { kind: 'stat', value: '{a | evil}' },
      }),
    });
    expect(res.status).toBe(400);
    expect(h.db.prepare(`SELECT count(*) c FROM external_modules`).get()).toEqual({ c: 0 });
  });

  it('a recipe signal raises a banner once armed, and nothing until then', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setData({ alert: { active: true, id: 'w1', river: 'Thames' } });
    const manifest = JSON.stringify({
      name: 'Flood',
      contract: 1,
      fetch: { url: `${mod.base}/data`, allowLan: true },
      panel: { kind: 'text', text: 'Flood watch' },
      signals: [{ when: 'alert.active', key: '{alert.id}', title: 'Flood: {alert.river}' }],
    });
    await h.form('/admin/modules/recipe', { manifest });
    const id = moduleId(h.db);
    await h.poll();

    // Signals are cached, but nothing fires until the household arms the module.
    expect((await h.manifest()).interrupts).toEqual([]);

    await h.form(`/admin/modules/${id}/alerts`, { action: 'banner' });
    const interrupts = (await h.manifest()).interrupts;
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.action).toBe('banner');
    expect(interrupts[0]!.title).toBe('Flood: Thames');
    expect(interrupts[0]!.source).toBe(`ext:${id}`);
  });

  it('a recipe signal clears when its `when` stops holding', async () => {
    const h = await harness();
    const mod = await fakeModule();
    mod.setData({ alert: { active: true, id: 'w1', river: 'Thames' } });
    const manifest = JSON.stringify({
      name: 'Flood',
      contract: 1,
      fetch: { url: `${mod.base}/data`, allowLan: true },
      panel: { kind: 'text', text: 'Flood watch' },
      signals: [{ when: 'alert.active', key: '{alert.id}', title: 'Flood: {alert.river}' }],
    });
    await h.form('/admin/modules/recipe', { manifest });
    const id = moduleId(h.db);
    await h.poll();
    await h.form(`/admin/modules/${id}/alerts`, { action: 'banner' });
    expect((await h.manifest()).interrupts).toHaveLength(1);

    // The gauge drops. A recipe honours its own polling interval, so simulate
    // its next due time rather than polling twice in the same millisecond.
    mod.setData({ alert: { active: false, id: 'w1', river: 'Thames' } });
    h.db.prepare(`UPDATE external_modules SET last_polled_at = 0 WHERE id = ?`).run(id);
    await h.poll();
    expect((await h.manifest()).interrupts).toEqual([]);
  });
});
