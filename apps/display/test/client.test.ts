import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  createManifestClient,
  isRenderableManifest,
  isStandInManifest,
  keepHeld,
  shouldAdoptStored,
  shouldKeepHeld,
} from '../src/manifest.js';
import { createClock } from '../src/clock.js';
import { mix, themeAt, themeTokens } from '../src/theme.js';

/**
 * The polling client, against a real HTTP server.
 *
 * A stubbed fetch would not exercise conditional requests at all, and the ETag
 * round trip is the whole reason an idle wall is cheap. This project has
 * already found one bug by pointing something at a real socket rather than a
 * mock.
 */

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const MANIFEST = {
  manifestVersion: 1,
  appVersion: '0.1.0-test',
  generatedAt: Date.parse('2026-07-15T09:00:00Z'),
  timezone: 'Europe/London',
  theme: { active: 'board' },
  window: { from: '2026-07-14', to: '2026-08-24' },
  days: [{ date: '2026-07-15', shifts: [], events: [] }],
  people: [],
  sources: [],
  notices: [],
  weather: null,
  interrupts: [],
};

interface Behaviour {
  etag?: string;
  status?: number;
  body?: unknown;
  /** Sent verbatim, for the reply that is not JSON at all. */
  raw?: string;
  /** Withheld, for the reply that did not come from this wall's server. */
  noServerTime?: boolean;
  serverTime?: number;
}

async function serverWith(behaviour: () => Behaviour): Promise<string> {
  const server = createServer((request, response) => {
    const next = behaviour();
    const etag = next.etag ?? '"v1"';
    const headers: Record<string, string> = { 'content-type': 'application/json', etag };
    if (next.noServerTime !== true) {
      headers['x-server-time'] = String(next.serverTime ?? Date.now());
    }
    if (next.status !== undefined && next.status !== 200) {
      response.writeHead(next.status, headers);
      if (next.status === 304) {
        response.end();
        return;
      }
      response.end(next.raw ?? JSON.stringify(next.body ?? { error: 'nope' }));
      return;
    }
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    response.end(JSON.stringify(next.body ?? MANIFEST));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/d/manifest`;
}

describe('polling', () => {
  it('fetches once, then gets a 304 for an unchanged wall', async () => {
    const url = await serverWith(() => ({}));
    const client = createManifestClient((input, init) => fetch(input, init), url);

    const first = await client.poll();
    expect(first.status).toBe('fresh');

    const second = await client.poll();
    expect(second.status).toBe('unchanged');
  });

  /*
   * A refusal and an unreachable server both arrive as `failed`, and only one
   * of them can explain itself.
   *
   * `/d/manifest` answers 503 with a sentence written for somebody standing in
   * a kitchen when it cannot build a wall, and every non-2xx body used to be
   * thrown away unread — so a screen with nothing cached could only say it was
   * not reaching a server that was up and answering it. This runs against a
   * real server returning the route's real body.
   */
  it("keeps the sentence a refusal came with, and none of a body that has none", async () => {
    const said = 'This wall could not be built just now. The screen will try again shortly.';
    let behaviour: Behaviour = { status: 503, body: { error: 'unavailable', message: said } };
    const url = await serverWith(() => behaviour);
    const client = createManifestClient((input, init) => fetch(input, init), url);

    const refused = await client.poll();
    expect(refused.status).toBe('failed');
    expect(refused).toHaveProperty('serverSaid', said);
    // A refusal is not an unreachable server, and the wall behaves differently
    // for each: this is what tells them apart.
    expect(refused).toHaveProperty('answered', true);
    // And the diagnostic stays diagnostic — it is never the thing drawn.
    expect(refused).toHaveProperty('reason', 'server answered 503');

    // A body with nothing to say leaves the display to its own wording rather
    // than putting `undefined` or an error code on a wall.
    behaviour = { status: 500, body: { error: 'oops' } };
    expect(await client.poll()).not.toHaveProperty('serverSaid');

    // Including a reply that is not JSON at all, which is what a proxy in
    // front of a stopped container answers with.
    behaviour = { status: 502, raw: '<html>a proxy said no</html>' };
    expect(await client.poll()).not.toHaveProperty('serverSaid');
  });

  /*
   * And a reply is not the same thing as a reply from *this wall's server*.
   *
   * A captive portal answers 200 with its own page and a proxy in front of a
   * stopped container answers its own 5xx — both are HTTP replies, and neither
   * means the wall is reaching anything. Reading them as contact would leave a
   * genuinely cut-off wall with no offline banner and a watchdog that could
   * never fire. `x-server-time` is the mark: `/d/manifest` sets it on every
   * answer it gives, refusals included, and nothing in between has a reason to.
   */
  it('does not mistake a captive portal or a proxy for its own server', async () => {
    let behaviour: Behaviour = { noServerTime: true, body: { hello: 'from the hotel wifi' } };
    const url = await serverWith(() => behaviour);
    const client = createManifestClient((input, init) => fetch(input, init), url);

    const portal = await client.poll();
    expect(portal.status, 'a 200 that is not a manifest').toBe('failed');
    expect(portal).toHaveProperty('answered', false);

    behaviour = { status: 502, noServerTime: true, raw: '<html>a proxy said no</html>' };
    const proxy = await client.poll();
    expect(proxy.status).toBe('failed');
    expect(proxy).toHaveProperty('answered', false);

    // And a proxy that answers in JSON does not get to speak for the server:
    // its sentence would be drawn on a wall with this product's authority.
    behaviour = {
      status: 503,
      noServerTime: true,
      body: { message: 'Upstream unavailable — contact your network administrator.' },
    };
    const talkative = await client.poll();
    expect(talkative).toHaveProperty('answered', false);
    expect(talkative, "a stranger's sentence is not the server's").not.toHaveProperty('serverSaid');

    // And the same 502 *with* the mark is this wall's server refusing.
    behaviour = { status: 502, body: { error: 'unavailable' } };
    expect(await client.poll()).toHaveProperty('answered', true);
  });

  /*
   * And the mark decides the two things the household actually reads.
   *
   * A 401 is the most destructive answer the display acts on — it drops the
   * manifest, puts the code-entry form up and latches it — so a hotel portal
   * asking for its own credentials must not be able to take a calendar off a
   * wall and ask the household to pair it again. And a `message` in a body that
   * is not ours must never be drawn as this server's explanation: that is a
   * stranger's sentence with the product's authority behind it.
   */
  it('will not let something else unpair a screen or speak for the server', async () => {
    const said = 'Sign in to HotelWiFi to continue.';
    let behaviour: Behaviour = { status: 401, noServerTime: true, body: { message: said } };
    const url = await serverWith(() => behaviour);
    const client = createManifestClient((input, init) => fetch(input, init), url);

    const stranger = await client.poll();
    expect(stranger.status, 'unpairing is ours to say').toBe('failed');
    expect(stranger).toHaveProperty('answered', false);
    expect(stranger, 'and so is what the wall reads').not.toHaveProperty('serverSaid');

    // The identical 401 carrying the mark is this server revoking a token.
    behaviour = { status: 401, body: { error: 'unauthorized' } };
    expect((await client.poll()).status).toBe('unpaired');
  });

  it('knows an unreachable server from one that refused', async () => {
    // Nothing listening at all: the port is closed the moment the server is.
    const url = await serverWith(() => ({}));
    const client = createManifestClient((input, init) => fetch(input, init), url);
    // Only the one this test just made — `servers` is the suite's whole list,
    // and closing all of them would take other tests' servers with it.
    await new Promise<void>((resolve) => servers[servers.length - 1]?.close(() => resolve()));

    const unreachable = await client.poll();
    expect(unreachable.status).toBe('failed');
    expect(
      unreachable,
      'this is the one that means "not reaching the server", and the other is not',
    ).toHaveProperty('answered', false);
  });

  it('carries server time on a 304 as well as a 200', async () => {
    // A display that is correctly getting 304s all day would otherwise never
    // correct its clock drift.
    const at = Date.parse('2026-07-15T09:00:00Z');
    const url = await serverWith(() => ({ serverTime: at }));
    const client = createManifestClient((input, init) => fetch(input, init), url);

    await client.poll();
    const unchanged = await client.poll();
    expect(unchanged.status).toBe('unchanged');
    expect(unchanged).toHaveProperty('serverTime', at);
  });

  it('picks up a new document when the ETag moves', async () => {
    let version = 1;
    const url = await serverWith(() => ({ etag: `"v${version}"` }));
    const client = createManifestClient((input, init) => fetch(input, init), url);

    expect((await client.poll()).status).toBe('fresh');
    expect((await client.poll()).status).toBe('unchanged');
    version = 2;
    expect((await client.poll()).status).toBe('fresh');
  });

  it('reports an unpaired screen distinctly from a failure', async () => {
    // One means "show the pairing message", the other means "keep what you
    // have". Collapsing them would blank a working wall on a 500.
    const url = await serverWith(() => ({ status: 401 }));
    const client = createManifestClient((input, init) => fetch(input, init), url);
    expect((await client.poll()).status).toBe('unpaired');
  });

  it('fails softly on a server error', async () => {
    const url = await serverWith(() => ({ status: 500 }));
    const client = createManifestClient((input, init) => fetch(input, init), url);
    const outcome = await client.poll();
    expect(outcome.status).toBe('failed');
  });

  it('fails softly when nothing is listening at all', async () => {
    const client = createManifestClient(
      (input, init) => fetch(input, init),
      'http://127.0.0.1:9/d/manifest',
    );
    expect((await client.poll()).status).toBe('failed');
  });

  it('refuses a reply that is not a manifest, and can recover afterwards', async () => {
    // A captive portal or a proxy login page answers 200 with HTML. Storing
    // the ETag for that would make the server answer 304 forever and the wall
    // would never come back.
    let good = false;
    const url = await serverWith(() =>
      good ? {} : { body: { error: 'not a manifest' } },
    );
    const client = createManifestClient((input, init) => fetch(input, init), url);

    expect((await client.poll()).status).toBe('failed');
    good = true;
    expect((await client.poll()).status).toBe('fresh');
  });

  it('reports the wall viewport as query params, so the editor can match it', async () => {
    // RFC 005: the wall sends its own size on each poll; the server stores it so
    // the layout editor can offer "match this screen's real resolution".
    let seenUrl = '';
    const server = createServer((request, response) => {
      seenUrl = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'x-server-time': String(Date.now()) });
      response.end(JSON.stringify(MANIFEST));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const client = createManifestClient(
      (input, init) => fetch(input, init),
      `http://127.0.0.1:${port}/d/manifest`,
      () => ({ w: 1080, h: 1920 }),
    );
    expect((await client.poll()).status).toBe('fresh');
    expect(seenUrl).toContain('w=1080');
    expect(seenUrl).toContain('h=1920');
  });

  it('refuses a manifest version this bundle does not understand', () => {
    expect(isRenderableManifest({ ...MANIFEST, manifestVersion: 2 })).toBe(false);
    expect(isRenderableManifest(MANIFEST)).toBe(true);
    expect(isRenderableManifest(null)).toBe(false);
    expect(isRenderableManifest('<html>')).toBe(false);
  });

  /*
   * The stand-in is drawable and must never be remembered.
   *
   * `/d/manifest` answers with an empty but valid manifest when the server
   * could not read its own database, carrying the reason as a notice so the
   * wall draws that instead of a black screen. It passes every check above by
   * construction — which is how it came to be written over the wall's own
   * memory, leaving a reload with nothing at all to fall back to. `main.ts`
   * skips the store for exactly this answer, and this is the rule it asks.
   */
  it("tells the stand-in manifest apart from a household's own", () => {
    const standIn = {
      ...MANIFEST,
      days: [],
      notices: [
        { level: 'error', code: 'schema-degraded', message: 'The database could not be fully read.' },
      ],
    };
    expect(isStandInManifest(standIn)).toBe(true);
    // Still renderable — drawing it is the point; keeping it is not.
    expect(isRenderableManifest(standIn)).toBe(true);

    expect(isStandInManifest(MANIFEST)).toBe(false);
    // And a real manifest that happens to carry some other complaint is the
    // household's data and is kept: this is not "any error notice".
    expect(
      isStandInManifest({
        ...MANIFEST,
        notices: [{ level: 'error', code: 'source-failed', message: 'A calendar did not sync.' }],
      }),
    ).toBe(false);
  });

  /*
   * And the stand-in is a fallback, not a replacement.
   *
   * Declining to *store* it was only half the fix: nothing could reach the
   * stored copy while the stand-in kept arriving and replacing what was on the
   * glass, so a reload flashed the real calendar and dropped straight back to
   * the empty one. A wall that has a calendar keeps it; a wall booted during
   * the outage has nothing better and draws the reason, which is the case RFC
   * 009 1.9 wrote it for.
   */
  it('keeps a calendar it already has rather than trading it for the stand-in', () => {
    const standIn = {
      ...MANIFEST,
      days: [],
      notices: [
        { level: 'error', code: 'schema-degraded', message: 'The database could not be fully read.' },
      ],
    };

    expect(shouldKeepHeld(true, standIn), 'a wall with a calendar keeps it').toBe(true);
    expect(shouldKeepHeld(false, standIn), 'a wall with nothing draws the reason').toBe(false);
    expect(shouldKeepHeld(true, MANIFEST), 'an ordinary update is never held off').toBe(false);
  });

  /*
   * And keeping the calendar must not mean discarding what the stand-in came
   * to say — which is its notice, and only its notice.
   *
   * The notice is the only text on the wall that names the fault and points at
   * System. The interrupts are deliberately *not* taken, and the argument for
   * taking them is the one that reads better: an acknowledgement is recorded
   * server-side and it is the re-poll that clears a takeover, so a frozen copy
   * leaves a warning the OK button cannot dismiss. That is true and it is the
   * smaller harm. The stand-in carries no interrupts at all — a process that
   * cannot read its database cannot evaluate a rule either — so merging them
   * never clears an acknowledged warning, it drops a live unacknowledged one.
   * A tornado takeover must not vanish because a migration failed. It is the
   * same stance the `failed` branch states outright: the interrupt stays up,
   * because nothing has been acknowledged as far as the household is
   * concerned.
   */
  it('keeps the calendar and the warning, and takes only the notice', () => {
    const storm = {
      id: 'i1',
      name: 'Storm',
      message: 'Take cover',
      action: 'takeover',
      priority: 1,
    };
    const held = { ...MANIFEST, notices: [], interrupts: [storm] };
    const standIn = {
      ...MANIFEST,
      days: [],
      notices: [
        { level: 'error', code: 'schema-degraded', message: 'The database could not be fully read.' },
      ],
      // As the server builds it: a process that cannot read its database
      // cannot evaluate an interrupt rule either, so this is always empty.
      interrupts: [],
    };

    const kept = keepHeld(held, standIn);
    expect(kept.days, 'the household keeps their calendar').toEqual(MANIFEST.days);
    expect(kept.notices, 'and is told why it is not being updated').toEqual(standIn.notices);
    expect(
      kept.interrupts,
      'a tornado takeover must not vanish because a migration failed',
    ).toEqual([storm]);

    // And the result must not read as a stand-in, or the next poll would let
    // the empty document through on the strength of the notice just merged in.
    expect(
      isStandInManifest(kept),
      'the merged document reads as a stand-in — which is why both rules above are told, not asked',
    ).toBe(true);
  });

  /*
   * And the stored copy does not have to defer to a stand-in.
   *
   * `store.load()` is asynchronous and the first poll is not waited for, so on
   * a slow tablet the server can answer first. A boot guard of "only when
   * there is nothing yet" then let an empty stand-in beat the household's real
   * cached calendar to the screen — and stuck there, because the held manifest
   * was itself a stand-in and `shouldKeepHeld` says no for ever after.
   */
  it('lets the stored calendar in over a stand-in that arrived first', () => {
    const standIn = {
      ...MANIFEST,
      days: [],
      notices: [
        { level: 'error', code: 'schema-degraded', message: 'The database could not be fully read.' },
      ],
    };

    // `standIn` is what makes the second case reachable at all: without a poll
    // having adopted one, `heldIsReal` would simply still be false from boot.
    expect(isStandInManifest(standIn)).toBe(true);

    expect(shouldAdoptStored(false), 'the ordinary boot, and the race this exists for').toBe(true);
    expect(shouldAdoptStored(true), 'never over a real one the server just sent').toBe(false);
  });

  /*
   * And one of these reads a document nothing has shape-checked.
   *
   * `store.load()` hands back whatever IndexedDB holds, which on a wall that
   * has been hanging for months may have been written by an older bundle.
   * Reading `.some` off a missing `notices` would throw *inside the poll* —
   * and a poll, unlike a draw, is not wrapped in `safely`, so the wall would
   * stop updating for good over a field that is merely absent.
   */
  it('does not throw on a stored document that predates the notices field', () => {
    const legacy = { ...MANIFEST } as Record<string, unknown>;
    delete legacy['notices'];

    expect(() => isStandInManifest(legacy as never)).not.toThrow();
    expect(isStandInManifest(legacy as never)).toBe(false);
    expect(shouldKeepHeld(true, legacy as never)).toBe(false);
  });
});

describe('the clock', () => {
  it('corrects a device that is running slow', () => {
    // A tablet screwed to a wall may never have had NTP.
    let device = Date.parse('2026-07-15T09:00:00Z');
    const clock = createClock(() => device);
    const truth = Date.parse('2026-07-15T09:04:00Z');

    clock.sync(truth);
    expect(clock.now()).toBe(truth);
    expect(clock.offset()).toBe(4 * 60_000);

    device += 60_000;
    expect(clock.now()).toBe(truth + 60_000);
  });

  it('ignores a server time that is obviously not one', () => {
    const clock = createClock(() => 1_000);
    clock.sync(0);
    clock.sync(Number.NaN);
    expect(clock.now()).toBe(1_000);
  });
});

describe('theme tokens', () => {
  it('carries all four directions from the design file', () => {
    for (const name of ['household', 'blueprint', 'panels', 'almanac']) {
      const tokens = themeTokens(name);
      expect(tokens['--bg']).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(tokens['--s-break']).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('falls back rather than throwing on a theme it does not know', () => {
    // A theme key the server knows about and this bundle does not is version
    // skew, not a reason for a wall to go blank — it resolves to the default.
    expect(themeTokens('kitchen-disco')).toEqual(themeTokens('panels'));
  });

  it('resolves a retired key to its surviving alias', () => {
    // Board/Slate/Glance were retired; all three resolve to Panels so a saved
    // setting or an old template keeps a dark wall.
    expect(themeTokens('board')).toEqual(themeTokens('panels'));
    expect(themeTokens('slate')).toEqual(themeTokens('panels'));
    expect(themeTokens('glance')).toEqual(themeTokens('panels'));
  });

  it('pre-mixes the cell tints, because color-mix() is too new', () => {
    // The design wrote `color-mix(in srgb, var(--sc) 20%, transparent)`, which
    // lands in the same browsers as :has(). Rule two rules both out.
    const panels = themeTokens('panels');
    expect(panels['--s-day-tint']).toMatch(/^#[0-9A-Fa-f]{6}$/);
    // 20% of #E8A33D over the Panels background #14181E.
    expect(panels['--s-day-tint']).toBe(mix('#E8A33D', '#14181E', 0.2));
  });

  it('mixes towards the background, not towards white', () => {
    expect(mix('#FFFFFF', '#000000', 0.5)).toBe('#808080');
    expect(mix('#FFFFFF', '#000000', 0)).toBe('#000000');
    expect(mix('#FFFFFF', '#000000', 1)).toBe('#ffffff');
  });
});

describe('theme scheduling', () => {
  it('uses the daylight theme inside the window', () => {
    expect(themeAt('12:00', 'board', 'almanac', '07:00', '21:00')).toBe('almanac');
    expect(themeAt('06:59', 'board', 'almanac', '07:00', '21:00')).toBe('board');
    expect(themeAt('21:00', 'board', 'almanac', '07:00', '21:00')).toBe('board');
  });

  it('honours a window that wraps midnight', () => {
    // Somebody working nights may well want the light theme at 3am.
    expect(themeAt('02:00', 'board', 'almanac', '22:00', '06:00')).toBe('almanac');
    expect(themeAt('12:00', 'board', 'almanac', '22:00', '06:00')).toBe('board');
  });

  it('stays on the active theme when no window is configured', () => {
    expect(themeAt('12:00', 'board')).toBe('board');
    expect(themeAt('12:00', 'board', 'almanac', '07:00', '07:00')).toBe('board');
  });
});
