import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import type { Page, Route } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

/**
 * The Walls list's previews, in a real browser (RFC 016 phase 2, §4.4, §7).
 *
 * What the route tests cannot see: the shadow root a card is drawn into, the
 * theme it wears, which canvas it draws when the wall is hung sideways, and
 * — the half that matters most — what is left when the preview cannot be
 * drawn at all. Rule nine, asserted rather than assumed: with the manifest
 * refused, with the frame refused, and with the script blocked outright,
 * every card still carries its name, chip, status line and control, and
 * nothing on the page says anything about it.
 *
 * And a preview draws **once**. A wall polls every sixty seconds; six cards
 * doing the same would make the settings page the busiest client in the
 * house, so the request count is read off the wire after every card is drawn
 * and held still, and the entry point's own source is held to carrying no
 * timer — a poll needs one, and the gallery path beside it has none either.
 */

const SLOW = 90_000;
const HERE = dirname(fileURLToPath(import.meta.url));

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Widget {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config?: Record<string, unknown>;
}

const idNamed = (home: Installation, name: string): string =>
  (home.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;

async function arrange(home: Installation, id: string, orientation: 'portrait' | 'landscape', widgets: Widget[]): Promise<void> {
  const saved = await home.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: id,
      orientation,
      mode: 'freeform',
      aspect: orientation === 'portrait' ? 0.5625 : 1.667,
      widgets,
      background: null,
    }),
  });
  expect(saved.status, await saved.text()).toBe(200);
}

const note = (id: string, text: string): Widget => ({
  id, type: 'notes', x: 0.05, y: 0.05, w: 0.9, h: 0.5, z: 0, config: { text },
});

/**
 * A household with every kind of card on it: a not-yet-paired wall, a wall
 * polled a moment ago, a panel nothing has fetched, and a panel that has.
 */
async function household(): Promise<{ home: Installation; attic: string; kitchen: string; porch: string }> {
  const home = await install();
  installations.push(home);
  const attic = await home.pairWall('Attic');
  const link = await home.pairLink('Kitchen');
  const token = new URL(link).searchParams.get('token') ?? '';
  expect((await home.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  const kitchen = idNamed(home, 'Kitchen');
  expect((await home.post('/admin/epaper', { name: 'Porch', preset: 'seeed-7in5', rotation: '0' })).status).toBe(303);
  const porch = idNamed(home, 'Porch');
  return { home, attic, kitchen, porch };
}

async function open(home: Installation, prepare?: (page: Page) => Promise<void>): Promise<Page> {
  const context = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await home.signIn(page);
  if (prepare !== undefined) await prepare(page);
  await page.goto(`${home.base}/admin/walls`, { waitUntil: 'load' });
  return page;
}

/** What every card carries regardless of its picture: the server's own words. */
interface CardWords {
  readonly name: string;
  readonly chip: string;
  readonly status: string;
  readonly control: string;
}
interface CardBones extends CardWords {
  readonly drawn: boolean;
  readonly imageDecoded: boolean | null;
}

/**
 * The four things a card says, read the same way off the live page and off
 * the server's own HTML — so "untouched" is an equality against what the
 * server drew, and not merely "still non-empty". The first draft asserted
 * the latter, and a script that wrote "Preview failed" over the status line
 * on a refused manifest passed it.
 */
const WORDS_OF = `(card) => ({
  name: (card.querySelector('.wall-link')?.textContent ?? '').trim(),
  chip: (card.querySelector('.tag')?.textContent ?? '').trim(),
  status: (card.querySelector('.sub')?.textContent ?? '').trim(),
  control: (card.querySelector('a.btn, .card-go')?.textContent ?? '').trim(),
})`;

const bones = (page: Page): Promise<CardBones[]> =>
  page.evaluate(
    (wordsOf) =>
      Array.from(document.querySelectorAll<HTMLElement>('.wall-card')).map((card) => {
        const well = card.querySelector<HTMLElement>('.wall-preview');
        const image = card.querySelector<HTMLImageElement>('img.wall-ink');
        const words = (new Function(`return ${wordsOf}`)() as (c: Element) => CardWords)(card);
        return {
          ...words,
          drawn: (well?.shadowRoot?.querySelectorAll('*').length ?? 0) > 3,
          imageDecoded: image === null ? null : image.complete && image.naturalWidth > 0,
        };
      }),
    WORDS_OF,
  );

/** The same four things, off the HTML the server sends, parsed in the browser. */
const serverWords = async (page: Page, home: Installation): Promise<CardWords[]> => {
  const html = await (await home.call('/admin/walls')).text();
  return page.evaluate(
    ({ markup, wordsOf }) => {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      const read = new Function(`return ${wordsOf}`)() as (c: Element) => CardWords;
      return Array.from(doc.querySelectorAll('.wall-card')).map(read);
    },
    { markup: html, wordsOf: WORDS_OF },
  );
};

const drawnCard = (page: Page, id: string): Promise<void> =>
  page
    .waitForFunction(
      (selector) => (document.querySelector(selector)?.shadowRoot?.querySelectorAll('*').length ?? 0) > 3,
      `.wall-preview[data-wall="${id}"]`,
      { timeout: 20_000 },
    )
    .then(() => undefined);

function expectBones(cards: CardBones[], drawnByServer: CardWords[]): void {
  expect(cards.map((c) => c.name).sort()).toEqual(['Attic', 'Kitchen', 'Porch']);
  // Word for word what the server sent: nothing on the page rewrote a card.
  expect(cards.map(({ name, chip, status, control }) => ({ name, chip, status, control }))).toEqual(drawnByServer);
  for (const card of cards) {
    expect(card.chip, card.name).toMatch(/^(Browser|E-paper)$/);
    expect(card.status, card.name).not.toBe('');
    expect(card.control, card.name).toMatch(/^(Pair it|Set up the device|Open)$/);
  }
}

describe('a card that cannot draw its picture', () => {
  it(
    'keeps its name, chip, status and control with the manifest and the frame refused',
    async () => {
      const { home } = await household();
      const refuse = (route: Route): Promise<void> =>
        route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"refused"}' });
      const page = await open(home, async (p) => {
        await p.route('**/admin/layout/preview.json*', refuse);
        await p.route('**/admin/epaper/*/preview.png*', refuse);
      });
      // Give the script every chance to draw something it should not.
      await page.waitForTimeout(1500);
      const cards = await bones(page);
      expectBones(cards, await serverWords(page, home));
      expect(cards.filter((c) => c.drawn), 'a card drew a picture from a refused manifest').toEqual([]);
      expect(cards.find((c) => c.name === 'Porch')?.imageDecoded).toBe(false);
      await page.context().close();
    },
    SLOW,
  );

  it(
    'keeps its name, chip, status and control with the script blocked',
    async () => {
      const { home } = await household();
      const page = await open(home, async (p) => {
        await p.route('**/assets/template-gallery.js', (route) => route.abort());
      });
      await page.waitForTimeout(1000);
      const cards = await bones(page);
      expectBones(cards, await serverWords(page, home));
      expect(cards.filter((c) => c.drawn)).toEqual([]);
      // The panel's picture needs no script: it is an <img>, and it decoded.
      expect(cards.find((c) => c.name === 'Porch')?.imageDecoded).toBe(true);
      await page.context().close();
    },
    SLOW,
  );
});

describe('a card that draws', () => {
  it(
    'draws the landscape canvas for a wall pinned landscape, in the theme that wall wears now',
    async () => {
      const { home, kitchen } = await household();
      await arrange(home, kitchen, 'portrait', [note('p', 'Portrait only note')]);
      await arrange(home, kitchen, 'landscape', [note('l', 'Landscape only note')]);
      // Pinned landscape, on Almanac, with a daylight theme whose window is
      // open at the harness's pinned hour — so what the wall draws right now
      // is the daytime theme, and the card has to say so too (RFC 016 §9.3).
      const pinned = await home.post(`/admin/screens/${kitchen}`, {
        name: 'Kitchen',
        orientation: 'landscape',
        rotation: '0',
        theme: 'almanac',
        daytime_theme: 'household',
        daytime_starts_at: '09:00',
        daytime_ends_at: '17:00',
      });
      expect([302, 303]).toContain(pinned.status);

      const page = await open(home);
      await drawnCard(page, kitchen);
      const seen = await page.evaluate((id) => {
        const host = document.querySelector<HTMLElement>(`.wall-preview[data-wall="${id}"]`);
        const root = host?.shadowRoot?.querySelector<HTMLElement>('.preview-wall');
        const rect = host?.getBoundingClientRect();
        return {
          text: root?.textContent ?? '',
          theme: root?.getAttribute('data-theme'),
          aspect: rect === undefined ? 0 : rect.width / rect.height,
        };
      }, kitchen);
      expect(seen.text).toContain('Landscape only note');
      expect(seen.text).not.toContain('Portrait only note');
      expect(seen.aspect).toBeCloseTo(1.667, 2);
      expect(seen.theme).toBe('household');
      await page.context().close();
    },
    SLOW,
  );

  it(
    'draws once: one request per card, none after, and no timer in its source',
    async () => {
      const { home, kitchen, porch } = await household();
      const requests: string[] = [];
      const page = await open(home, async (p) => {
        p.on('request', (request) => {
          const url = request.url();
          if (url.includes('/admin/layout/preview.json') || url.includes('/preview.png')) requests.push(url);
        });
      });
      await drawnCard(page, kitchen);
      await drawnCard(page, idNamed(home, 'Attic'));
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll<HTMLImageElement>('img.wall-ink')).every((i) => i.complete),
        undefined,
        { timeout: 20_000 },
      );
      const afterDraw = requests.length;
      // Two browser walls and one panel on the page: exactly three requests.
      expect(requests.filter((u) => u.includes(`screen=${kitchen}`)).length).toBe(1);
      expect(requests.filter((u) => u.includes(`/admin/epaper/${porch}/preview.png`)).length).toBe(1);
      expect(afterDraw).toBe(3);
      // And nothing after: the page is left alone for longer than any
      // debounce, and the count is what it was.
      await page.waitForTimeout(3000);
      expect(requests.length).toBe(afterDraw);
      await page.context().close();

      // A poll needs a timer. The entry point has none, and neither has the
      // gallery beside it — read off the source rather than waited for, since
      // a sixty-second poll is not something a test can afford to wait out.
      const source = readFileSync(join(HERE, '..', '..', 'display', 'src', 'template-gallery.ts'), 'utf8');
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(stripped).not.toMatch(/\bsetInterval\b|\bsetTimeout\b|\brequestAnimationFrame\b/);
    },
    SLOW,
  );
});
