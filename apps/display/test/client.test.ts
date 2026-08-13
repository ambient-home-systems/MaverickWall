import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createManifestClient, isRenderableManifest } from '../src/manifest.js';
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
  serverTime?: number;
}

async function serverWith(behaviour: () => Behaviour): Promise<string> {
  const server = createServer((request, response) => {
    const next = behaviour();
    const etag = next.etag ?? '"v1"';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-server-time': String(next.serverTime ?? Date.now()),
      etag,
    };
    if (next.status !== undefined && next.status !== 200) {
      response.writeHead(next.status, headers);
      response.end(next.status === 304 ? undefined : JSON.stringify({ error: 'nope' }));
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
    for (const name of ['board', 'slate', 'almanac', 'glance']) {
      const tokens = themeTokens(name);
      expect(tokens['--bg']).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(tokens['--s-break']).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('falls back rather than throwing on a theme it does not know', () => {
    // A theme key the server knows about and this bundle does not is version
    // skew, not a reason for a wall to go blank.
    expect(themeTokens('kitchen-disco')).toEqual(themeTokens('board'));
  });

  it('pre-mixes the cell tints, because color-mix() is too new', () => {
    // The design wrote `color-mix(in srgb, var(--sc) 20%, transparent)`, which
    // lands in the same browsers as :has(). Rule two rules both out.
    const board = themeTokens('board');
    expect(board['--s-day-tint']).toMatch(/^#[0-9A-Fa-f]{6}$/);
    // 20% of #E8A33D over #0B0E11.
    expect(board['--s-day-tint']).toBe(mix('#E8A33D', '#0B0E11', 0.2));
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
