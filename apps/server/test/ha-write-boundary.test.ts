import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFetcher } from '../src/net/fetcher.js';
import {
  buildCall,
  callService,
  COVER_CLASSES,
  HA_SERVICES,
  type CallRequest,
  type Connection,
  type ControlKey,
  type HaCall,
  type ServiceKey,
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
 * RFC 012 spent that property to buy a shopping list you can tick, and RFC 018
 * (accepted 2026-10-05) widened the list into a table of verbs a wall may use on
 * things the household picked. This file is what both are spent on.
 *
 * **Three parts, because they fail differently.** The table says what may be
 * called, `buildCall` is the only thing that can make a call from it, and
 * `callService` is the only door. The rest of this note is from RFC 012 and
 * still holds for the door.
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
  it('has three call sites outside the JSON adapter — a webhook button with no body, Todoist, and a calendar sign-in', () => {
    /*
     * `fetch` grew a method in RFC 013 §6.3 and a POST through it would bypass
     * `HA_SERVICES` completely. For two releases nothing needed one and the
     * guard was zero. RFC 018 §9 (phase 5) is the one caller that does, and
     * said why in the commit that changed this line: a **webhook button** is
     * not a Home Assistant service call, so it does not go through the table —
     * it POSTs to an address the household set in the admin, behind the same
     * three switches. It is held here to exactly one file and to **no body**,
     * so a second caller, or a body on this one, fails this line again.
     *
     * Plan item M5.7 is the second, and it is not Home Assistant either: the
     * Todoist client's one `request()` posts to `TODOIST_API`, a constant in
     * that file and never an address anybody typed. It is held to one call, to
     * an address built on the endpoint's base, and — in the test below — to
     * the three paths it is allowed to post to.
     *
     * Plan item M5.11 is the third, and it is not Home Assistant either: the
     * one `postForm` in `oauth/token.ts` is every request that trades a code
     * or a refresh token with Google or Microsoft, and its address comes from
     * `targetUrl`, which builds it on the `OAuthEndpoints` constants and never
     * on anything a household typed. The test below holds `targetUrl` to those
     * three destinations.
     *
     * The adapter's own `POST: 'refuse'` in `REDIRECT_POLICY` and its
     * `method: 'POST'` when it builds `postJson`'s wire request are the
     * implementation and are not doors, so they are exempted by file and
     * counted rather than skipped — the same shape as the declaration
     * exemption above.
     */
    const posting: string[] = [];
    let calls = 0;
    let webhook: string | undefined;
    let todoist: string | undefined;
    let oauth: string | undefined;
    for (const file of filesUnder(SERVER_SRC)) {
      const name = relative(ROOT, file);
      for (const call of fetchCallArguments(readFileSync(file, 'utf8'))) {
        calls++;
        if (!call.includes(POST_METHOD)) continue;
        if (name === join('apps', 'server', 'src', 'modules', 'webhooks', 'index.ts') && webhook === undefined) {
          webhook = call;
          continue;
        }
        if (name === join('apps', 'server', 'src', 'modules', 'todoist', 'client.ts') && todoist === undefined) {
          todoist = call;
          continue;
        }
        if (name === join('apps', 'server', 'src', 'oauth', 'token.ts') && oauth === undefined) {
          oauth = call;
          continue;
        }
        posting.push(`${name}  ${call.slice(0, 120)}`);
      }
    }

    expect(
      posting,
      `a .fetch() asking for POST — a POST that never reads HA_SERVICES:\n${posting.join('\n')}`,
    ).toEqual([]);
    // The webhook press is there, and carries nothing a household typed.
    expect(webhook, 'the webhook button POST moved or vanished').toBeDefined();
    expect(webhook).not.toMatch(/\bbody\s*:/);
    // Todoist's one call is to its own fixed base, never a typed address.
    expect(todoist, 'the Todoist client POST moved or vanished').toBeDefined();
    expect(todoist).toMatch(/url: `\$\{endpoint\.base\}\$\{path\}`/);
    // A calendar sign-in's one call is to an address built from the endpoints.
    expect(oauth, 'the calendar sign-in POST moved or vanished').toBeDefined();
    expect(oauth).toContain('url: targetUrl(target, endpoints)');

    // And the scan is looking at something. A brace matcher that silently found
    // no calls would pass for ever, which is this project's own complaint about
    // an assertion no edit can turn red.
    expect(calls).toBeGreaterThan(10);
  });

  it('posts a calendar sign-in to Google’s token address and Microsoft’s two, and nowhere else', () => {
    const token = readFileSync(join(ROOT, SERVER_SRC, 'oauth', 'token.ts'), 'utf8');
    const start = token.indexOf('function targetUrl(');
    const body = token.slice(start, token.indexOf('\n}\n', start));
    const returns = [...body.matchAll(/return ([^;]+);/g)].map((match) => match[1]);
    expect(returns).toEqual([
      'endpoints.googleToken',
      '`${endpoints.microsoftLogin}/${encodeURIComponent(target.tenant)}/oauth2/v2.0/devicecode`',
      '`${endpoints.microsoftLogin}/${encodeURIComponent(target.tenant)}/oauth2/v2.0/token`',
    ]);
    const endpoints = readFileSync(join(ROOT, SERVER_SRC, 'oauth', 'endpoints.ts'), 'utf8');
    expect(endpoints).toContain("googleToken: 'https://oauth2.googleapis.com/token',");
    expect(endpoints).toContain("microsoftLogin: 'https://login.microsoftonline.com',");
  });

  it('posts to Todoist on three paths only: close, reopen and a new task', () => {
    // Nothing deletes, moves or edits: every POST the client makes names its path here.
    const client = readFileSync(join(ROOT, SERVER_SRC, 'modules', 'todoist', 'client.ts'), 'utf8');
    expect(client).toContain("export const TODOIST_API = 'https://api.todoist.com/api/v1';");
    const posts = [...client.matchAll(/await request\(([^;]*?)'POST'/gs)].map((match) => match[1] ?? '');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("${done ? 'close' : 'reopen'}");
    expect(posts[1]).toContain("'/tasks'");
  });
});


/**
 * RFC 018 §5, transcribed: every row the table may hold, and nothing else.
 * A row added to `services.ts` without being added here, or the other way
 * round, is the failure this exists to catch — the table is the rule.
 */
const EXPECTED_TABLE: Record<string, unknown> = {
  'todo.read': { service: 'todo/get_items', kind: 'read', reach: 'server', data: ['status'], returnResponse: true },
  'todo.tick': { service: 'todo/update_item', kind: 'write', reach: 'wall', data: ['item', 'status'], returnResponse: false },
  'todo.add': { service: 'todo/add_item', kind: 'write', reach: 'companion', data: ['item'], returnResponse: false },
  'weather.forecasts': { service: 'weather/get_forecasts', kind: 'read', reach: 'server', data: ['type'], returnResponse: true },
  'light.toggle': { service: 'light/toggle', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'light.brightness': { service: 'light/turn_on', kind: 'write', reach: 'wall', data: ['brightness_pct'], returnResponse: false },
  'light.colour': { service: 'light/turn_on', kind: 'write', reach: 'wall', data: ['rgb_color'], returnResponse: false },
  'light.colour_temp': { service: 'light/turn_on', kind: 'write', reach: 'wall', data: ['color_temp_kelvin'], returnResponse: false },
  'switch.toggle': { service: 'switch/toggle', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'fan.toggle': { service: 'fan/toggle', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'fan.speed': { service: 'fan/set_percentage', kind: 'write', reach: 'wall', data: ['percentage'], returnResponse: false },
  'cover.open': { service: 'cover/open_cover', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'cover.close': { service: 'cover/close_cover', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'cover.stop': { service: 'cover/stop_cover', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'cover.position': { service: 'cover/set_cover_position', kind: 'write', reach: 'wall', data: ['position'], returnResponse: false },
  'scene.run': { service: 'scene/turn_on', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'script.run': { service: 'script/turn_on', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'media_player.play_pause': { service: 'media_player/media_play_pause', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'media_player.next': { service: 'media_player/media_next_track', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'media_player.previous': { service: 'media_player/media_previous_track', kind: 'write', reach: 'wall', data: [], returnResponse: false },
  'media_player.volume': { service: 'media_player/volume_set', kind: 'write', reach: 'wall', data: ['volume_level'], returnResponse: false },
};

/** What rule 12 never permits, as entities a table row might be steered at. */
const NEVER = [
  'lock.front_door',
  'alarm_control_panel.house',
  'input_boolean.vacation_mode',
  'climate.hall',
  'button.gate_open',
  'input_button.doorbell',
  'valve.water_main',
  'siren.alarm',
  'camera.porch',
  'automation.morning',
  'update.core',
  'notify.mobile',
] as const;

const CONTROL_KEYS = (Object.keys(HA_SERVICES) as ServiceKey[]).filter(
  (key): key is ControlKey =>
    !['todo.read', 'todo.tick', 'todo.add', 'weather.forecasts'].includes(key),
);

const MEDIA_ALL = 1 | 4 | 16 | 32 | 16384;

/** One request per control row that `buildCall` should accept. */
const ELIGIBLE: Record<ControlKey, Extract<CallRequest, { key: ControlKey }>> = {
  'light.toggle': { key: 'light.toggle', entityId: 'light.kitchen', attributes: { supported_color_modes: ['onoff'] } },
  'light.brightness': { key: 'light.brightness', entityId: 'light.kitchen', attributes: { supported_color_modes: ['brightness'] }, value: 40 },
  'light.colour': { key: 'light.colour', entityId: 'light.kitchen', attributes: { supported_color_modes: ['hs', 'color_temp'] }, value: [255, 128, 0] },
  'light.colour_temp': { key: 'light.colour_temp', entityId: 'light.kitchen', attributes: { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, value: 2700 },
  'switch.toggle': { key: 'switch.toggle', entityId: 'switch.kettle', attributes: {} },
  'fan.toggle': { key: 'fan.toggle', entityId: 'fan.bedroom', attributes: {} },
  'fan.speed': { key: 'fan.speed', entityId: 'fan.bedroom', attributes: { supported_features: 1 }, value: 50 },
  'cover.open': { key: 'cover.open', entityId: 'cover.lounge_blind', attributes: { device_class: 'blind', supported_features: 15 } },
  'cover.close': { key: 'cover.close', entityId: 'cover.lounge_blind', attributes: { device_class: 'blind', supported_features: 15 } },
  'cover.stop': { key: 'cover.stop', entityId: 'cover.lounge_blind', attributes: { device_class: 'blind', supported_features: 15 } },
  'cover.position': { key: 'cover.position', entityId: 'cover.lounge_blind', attributes: { device_class: 'blind', supported_features: 15 }, value: 30 },
  'scene.run': { key: 'scene.run', entityId: 'scene.movie_time', attributes: {} },
  'script.run': { key: 'script.run', entityId: 'script.good_night', attributes: {} },
  'media_player.play_pause': { key: 'media_player.play_pause', entityId: 'media_player.kitchen', attributes: { supported_features: MEDIA_ALL } },
  'media_player.next': { key: 'media_player.next', entityId: 'media_player.kitchen', attributes: { supported_features: MEDIA_ALL } },
  'media_player.previous': { key: 'media_player.previous', entityId: 'media_player.kitchen', attributes: { supported_features: MEDIA_ALL } },
  'media_player.volume': { key: 'media_player.volume', entityId: 'media_player.kitchen', attributes: { supported_features: MEDIA_ALL }, value: 50 },
};

describe('the allowlist', () => {
  it('is exactly RFC 018 §5, row by row, data keys included', () => {
    expect(JSON.parse(JSON.stringify(HA_SERVICES))).toEqual(EXPECTED_TABLE);
  });

  it('is frozen, and so is every row and every row’s data', () => {
    // Not decoration: this is what a test can read where `grep` used to answer.
    expect(Object.isFrozen(HA_SERVICES)).toBe(true);
    for (const row of Object.values(HA_SERVICES)) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.data)).toBe(true);
    }
  });

  it('asks for an answer on exactly the reads', () => {
    // A read without `?return_response` is refused by Home Assistant with a
    // bare 400, and a write with it is refused too. The row decides, so no
    // caller can get either wrong.
    for (const row of Object.values(HA_SERVICES)) {
      expect(row.returnResponse).toBe(row.kind === 'read');
    }
  });

  it('has no row for anything rule 12 never permits', () => {
    const services = Object.values(HA_SERVICES).map((row) => row.service);
    for (const domain of [...NEVER.map((id) => id.slice(0, id.indexOf('.'))), 'hassio', 'homeassistant']) {
      expect(services.some((service) => service.startsWith(`${domain}/`)), domain).toBe(false);
    }
    // Inside `todo`, the two deletes stay out; and dismissing a persistent
    // notification waits for a WebSocket client (RFC 018 OQ9).
    for (const later of ['todo/remove_item', 'todo/remove_completed_items', 'persistent_notification/dismiss']) {
      expect(services).not.toContain(later);
    }
  });

  it('lets only the companion API add to a list', () => {
    // RFC 018 §5.2 (MD10): the wall has no keyboard and never reaches this row.
    const adders = Object.entries(HA_SERVICES).filter(([, row]) => row.service === 'todo/add_item');
    expect(adders.map(([key, row]) => [key, row.reach])).toEqual([['todo.add', 'companion']]);
  });

  it('builds the add in one function, which only the companion route calls', () => {
    /*
     * The row's `reach` is a label; this is the fact under it. One place in the
     * source builds a `todo.add` call, `addTodoItem`, and the one file that
     * calls `addTodoItem` is the companion route — behind a companion token,
     * outside `/d/*`, where no display token is ever read. A wall route that
     * started calling it would be a wall that adds, and this goes red first.
     */
    const builders: string[] = [];
    const callers: string[] = [];
    for (const file of filesUnder(SERVER_SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        if (/key:\s*'todo\.add'/.test(text) && !text.includes('readonly key')) {
          builders.push(`${relative(ROOT, file)}:${enclosingFunction(lines, index + 1)}`);
        }
        if (/\baddTodoItem\(/.test(text) && !/function addTodoItem\(/.test(text)) {
          callers.push(relative(ROOT, file));
        }
      });
    }
    expect(builders).toEqual([`${SERVER_SRC}/modules/todo/index.ts:addTodoItem`]);
    expect(callers).toEqual([`${SERVER_SRC}/http/companion.ts`]);
    const route = readFileSync(join(ROOT, `${SERVER_SRC}/http/companion.ts`), 'utf8');
    expect(route).toContain(`app.post('/companion/todo/add'`);
    expect(route).not.toMatch(/['`]\/d\//);
  });
});

describe('buildCall: the only constructor', () => {
  it('is the only place a call is registered, in the source', () => {
    // The runtime check at the door is only as good as the registry behind it.
    // A second `ISSUED.add(` — or the registry exported — would let something
    // other than `buildCall` mint a call the door accepts.
    const servicesFile = `${SERVER_SRC}/modules/homeassistant/services.ts`;
    const lines = readFileSync(join(ROOT, servicesFile), 'utf8').split('\n');
    const adds = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter((row) => row.text.includes('ISSUED.add('));
    expect(adds).toHaveLength(1);
    expect(enclosingFunction(lines, adds[0]!.line)).toBe('buildCall');
    for (const file of filesUnder(SERVER_SRC)) {
      if (relative(ROOT, file) === servicesFile) continue;
      expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toContain('ISSUED');
    }
  });

  it('accepts one request per control row, with exactly its row’s data and one entity', () => {
    expect(CONTROL_KEYS).toHaveLength(17);
    for (const key of CONTROL_KEYS) {
      const built = buildCall(ELIGIBLE[key]);
      expect(built.ok, key).toBe(true);
      if (!built.ok) continue;
      const row = HA_SERVICES[key];
      expect(built.call.service).toBe(row.service);
      expect(Object.keys(built.call.body)).toEqual(['entity_id', ...row.data]);
      expect(typeof built.call.body['entity_id']).toBe('string');
      expect(Object.isFrozen(built.call)).toBe(true);
      expect(Object.isFrozen(built.call.body)).toBe(true);
    }
  });

  it('refuses every control row aimed at anything rule 12 never permits', () => {
    // The refusal matrix: every row, steered at every forbidden domain.
    for (const key of CONTROL_KEYS) {
      for (const entityId of NEVER) {
        const built = buildCall({ ...ELIGIBLE[key], entityId });
        expect(built.ok, `${key} → ${entityId}`).toBe(false);
        if (!built.ok) expect(built.code).toBe('wrong-domain');
      }
    }
  });

  it('refuses a row aimed at another permitted domain', () => {
    // A light row cannot switch a switch: the domain is the row's, not the caller's.
    const built = buildCall({ ...ELIGIBLE['light.toggle'], entityId: 'switch.kettle' });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe('wrong-domain');
  });

  it('takes one entity id and nothing that names a set', () => {
    for (const entityId of ['all', 'light.*', 'light.kitchen,lock.front_door', 'Light.Kitchen', 'light.', '.kitchen', 'light kitchen', '']) {
      const built = buildCall({ ...ELIGIBLE['light.toggle'], entityId });
      expect(built.ok, JSON.stringify(entityId)).toBe(false);
    }
  });

  it('moves only covers that shade a room, and refuses one that does not say what it is', () => {
    const cover = ELIGIBLE['cover.open'];
    for (const deviceClass of COVER_CLASSES) {
      expect(buildCall({ ...cover, attributes: { device_class: deviceClass, supported_features: 15 } }).ok, deviceClass).toBe(true);
    }
    for (const key of ['cover.open', 'cover.close', 'cover.stop', 'cover.position'] as const) {
      for (const deviceClass of ['garage', 'gate', 'door', 'window', 'damper', undefined]) {
        const built = buildCall({
          ...ELIGIBLE[key],
          attributes: { ...(deviceClass === undefined ? {} : { device_class: deviceClass }), supported_features: 15 },
        });
        expect(built.ok, `${key} ${deviceClass ?? 'unset'}`).toBe(false);
        if (!built.ok) expect(built.code).toBe('not-eligible');
      }
    }
  });

  it('refuses a row whose feature the entity does not report', () => {
    const unsupported: [ControlKey, Record<string, unknown>][] = [
      ['light.brightness', { supported_color_modes: ['onoff'] }],
      ['light.colour', { supported_color_modes: ['brightness', 'color_temp'] }],
      ['light.colour_temp', { supported_color_modes: ['hs'] }],
      ['light.colour_temp', { supported_color_modes: ['color_temp'] }],
      ['fan.speed', { supported_features: 0 }],
      ['cover.open', { device_class: 'blind', supported_features: 2 | 4 | 8 }],
      ['cover.close', { device_class: 'blind', supported_features: 1 | 4 | 8 }],
      ['cover.stop', { device_class: 'blind', supported_features: 1 | 2 | 4 }],
      ['cover.position', { device_class: 'blind', supported_features: 1 | 2 | 8 }],
      ['media_player.play_pause', { supported_features: 4 | 16 | 32 }],
      ['media_player.next', { supported_features: MEDIA_ALL & ~32 }],
      ['media_player.previous', { supported_features: MEDIA_ALL & ~16 }],
      ['media_player.volume', { supported_features: MEDIA_ALL & ~4 }],
    ];
    for (const [key, attributes] of unsupported) {
      const built = buildCall({ ...ELIGIBLE[key], attributes });
      expect(built.ok, `${key} ${JSON.stringify(attributes)}`).toBe(false);
      if (!built.ok) expect(built.code).toBe('not-eligible');
    }
  });

  it('refuses a value out of bounds rather than clamping it', () => {
    const cases: [ControlKey, unknown, boolean][] = [
      ['light.brightness', 1, true],
      ['light.brightness', 100, true],
      ['light.brightness', 0, false],
      ['light.brightness', 101, false],
      ['light.brightness', 40.5, false],
      ['light.brightness', '40', false],
      ['light.brightness', undefined, false],
      ['light.colour', [0, 0, 0], true],
      ['light.colour', [255, 255, 255], true],
      ['light.colour', [256, 0, 0], false],
      ['light.colour', [-1, 0, 0], false],
      ['light.colour', [255, 0], false],
      ['light.colour_temp', 2000, true],
      ['light.colour_temp', 6500, true],
      ['light.colour_temp', 1999, false],
      ['light.colour_temp', 6501, false],
      ['fan.speed', 0, true],
      ['fan.speed', 100, true],
      ['fan.speed', 101, false],
      ['cover.position', 0, true],
      ['cover.position', 100, true],
      ['cover.position', -1, false],
      ['media_player.volume', 0, true],
      ['media_player.volume', 100, true],
      ['media_player.volume', 101, false],
    ];
    for (const [key, value, accepted] of cases) {
      const built = buildCall({ ...ELIGIBLE[key], value: value as number });
      expect(built.ok, `${key} ${JSON.stringify(value)}`).toBe(accepted);
      if (!built.ok) expect(built.code).toBe('bad-value');
    }
  });

  it('sends volume as Home Assistant’s 0.0–1.0, from the wall’s 0–100', () => {
    const built = buildCall({ ...ELIGIBLE['media_player.volume'], value: 35 });
    expect(built.ok && built.call.body).toEqual({ entity_id: 'media_player.kitchen', volume_level: 0.35 });
  });

  it('adds to a list only when the list allows it, and only text it can stand behind', () => {
    const canCreate = { supported_features: 1 | 4 };
    const add = (text: string, attributes: unknown = canCreate) =>
      buildCall({ key: 'todo.add', entityId: 'todo.shopping', text, attributes });
    const ok = add('  Milk  ');
    expect(ok.ok && ok.call.body).toEqual({ entity_id: 'todo.shopping', item: 'Milk' });
    expect(add('Milk', { supported_features: 4 }).ok).toBe(false);
    expect(add('   ').ok).toBe(false);
    expect(add('x'.repeat(256)).ok).toBe(false);
    expect(add('x'.repeat(255)).ok).toBe(true);
    expect(add('Milk\u0007').ok).toBe(false);
  });

  it('names a to-do item by its uid and both statuses on a read', () => {
    const tick = buildCall({ key: 'todo.tick', entityId: 'todo.shopping', item: 'i-2', done: true });
    expect(tick.ok && tick.call.body).toEqual({ entity_id: 'todo.shopping', item: 'i-2', status: 'completed' });
    const read = buildCall({ key: 'todo.read', entityId: 'todo.shopping' });
    expect(read.ok && read.call.body).toEqual({ entity_id: 'todo.shopping', status: ['needs_action', 'completed'] });
    expect(buildCall({ key: 'todo.tick', entityId: 'light.kitchen', item: 'i-2', done: true }).ok).toBe(false);
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

  /** Build a call the test expects `buildCall` to accept. */
  function built(request: CallRequest): HaCall {
    const result = buildCall(request);
    if (!result.ok) throw new Error(`buildCall refused ${request.key}: ${result.message}`);
    return result.call;
  }

  const permitted = new Set(Object.values(HA_SERVICES).map((row) => `/api/services/${row.service}`));

  it('reads a list, asking for its answer, and every path it asked for is on the allowlist', async () => {
    const { ha, connection } = await connected();
    const result = await callService(createFetcher(), connection, built({ key: 'todo.read', entityId: 'todo.shopping' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answered = JSON.parse(result.body) as {
      service_response: Record<string, { items: { uid: string; summary: string; status: string }[] }>;
    };
    // Both statuses, because the row names both: `i-3` is completed and comes
    // back. A reader relying on Home Assistant's default would never see it.
    expect(answered.service_response['todo.shopping']?.items.map((i) => i.uid)).toEqual(['i-1', 'i-2', 'i-3']);

    /*
     * The assertion this file exists for, stated as a subset rather than as an
     * equality: what matters is that nothing left the list, not that
     * everything on the list was used. And the read asked for its answer —
     * the one 400 that used to be our fault rather than theirs cannot be
     * built any more, because the row decides it.
     */
    expect(ha.posts.length).toBeGreaterThan(0);
    for (const post of ha.posts) {
      expect(permitted.has(post.path)).toBe(true);
      expect(post.query).toBe('return_response');
    }
  });

  it('writes one item, and still posts nowhere else', async () => {
    const { ha, connection } = await connected();
    const result = await callService(
      createFetcher(),
      connection,
      built({ key: 'todo.tick', entityId: 'todo.shopping', item: 'i-2', done: true }),
    );

    expect(result.ok).toBe(true);
    // The uid is the identity, so the *second* Milk is the one that moved and
    // the first is untouched. Matching by summary returns the first hit, and
    // that is a bug nobody can reproduce on their own list.
    expect(ha.todo['todo.shopping']?.items.map((i) => i.status)).toEqual([
      'needs_action',
      'completed',
      'completed',
    ]);
    expect(ha.posts.map((p) => p.path)).toEqual(['/api/services/todo/update_item']);
    expect(ha.posts[0]?.query).toBe('');
  });

  it('posts each control row exactly as its row says, and nothing else', async () => {
    // Phase 1 has no caller for these, so this is the only place they are
    // ever posted: one call per row, against a fake that refuses them all
    // (it has no lights). What is asserted is what left, not what answered.
    const { ha, connection } = await connected();
    const fetcher = createFetcher();
    for (const key of CONTROL_KEYS) {
      await callService(fetcher, connection, built(ELIGIBLE[key]));
    }
    expect(ha.posts.map((post) => post.path)).toEqual(
      CONTROL_KEYS.map((key) => `/api/services/${HA_SERVICES[key].service}`),
    );
    CONTROL_KEYS.forEach((key, index) => {
      const body = JSON.parse(ha.posts[index]?.body ?? '{}') as Record<string, unknown>;
      expect(Object.keys(body), key).toEqual(['entity_id', ...HA_SERVICES[key].data]);
      expect(body['entity_id'], key).toBe(ELIGIBLE[key].entityId);
      expect(ha.posts[index]?.query, key).toBe('');
    });
    for (const post of ha.posts) expect(permitted.has(post.path)).toBe(true);
  });

  it('refuses at the door a call nobody built, and posts nothing', async () => {
    // The type makes a hand-built call a compile error; this is the run-time
    // half, which a cast cannot get round.
    const { ha, connection } = await connected();
    const forged = {
      key: 'light.toggle',
      service: 'lock/unlock',
      body: { entity_id: 'lock.front_door' },
      returnResponse: false,
    } as unknown as HaCall;
    const result = await callService(createFetcher(), connection, forged);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('not a call Maverick Wall makes');
    // And a copy of a real call is not that call.
    const copy = { ...built(ELIGIBLE['light.toggle']) } as HaCall;
    expect((await callService(createFetcher(), connection, copy)).ok).toBe(false);
    expect(ha.posts).toEqual([]);
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
    // RFC 012 §7.4: the tick failing is fine, the tick failing silently is not.
    const { connection } = await connected();
    const result = await callService(
      createFetcher(),
      connection,
      built({ key: 'todo.tick', entityId: 'todo.read_only', item: 'r-1', done: true }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('does not support this service');
  });
});
