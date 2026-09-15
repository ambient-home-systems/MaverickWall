import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

/**
 * The render budget the Walls list's previews are shipped against (RFC 016
 * §9.1), measured rather than argued.
 *
 * A gallery draws fourteen templates against **one** manifest; this page
 * cannot, because zone, density and theme are per wall, so every browser card
 * that scrolls into view costs one `previewManifest` build on the server and
 * every panel card one 1-bit render — the whole assembly, calendars and
 * panels included, per wall. The RFC says the measurement, not an opinion,
 * decides whether phase 2 ships, and that a budget measuring only the browser
 * would pass a page that makes the server assemble six manifests on every
 * visit. So both sides of the wire are read here, on a six-wall household
 * with three real calendars, a forecast and a rota:
 *
 *  - **server time per page view**: the page itself, then each build the
 *    page's cards ask for, over loopback and timed at the caller — which is
 *    the server's time plus a loopback round trip, and the round trip is
 *    tens of microseconds;
 *  - **browser time** to the first drawn card and to every card above the
 *    fold at 1280x800, from navigation start;
 *  - **how many builds** one page view asks the server for.
 *
 * The numbers are printed on every run and recorded in the RFC; the one
 * thing asserted is the structural claim — one build per card in view, and
 * not one more — because a wall-clock ceiling measures the runner, which this
 * repository has written down three times. A ceiling is opt-in through
 * `MW_WALLS_BUDGET_MS`, for a machine whose speed somebody knows.
 *
 * Phase 1's page, for the comparison the RFC asks for, is the same file run
 * against a checkout of `main` before phase 2: there it prints the page's
 * own time and nothing else, because there is nothing else to ask for.
 */

const SLOW = 180_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const ms = (value: number): string => `${value.toFixed(1)}ms`;

async function timed(home: Installation, path: string): Promise<number> {
  const started = performance.now();
  const response = await home.call(path);
  await response.arrayBuffer();
  expect(response.status, path).toBe(200);
  return performance.now() - started;
}

describe('the Walls list on a six-wall household', () => {
  it(
    'costs one build per card in view, and this is what that costs',
    async () => {
      const home = await install({ calendars: HOUSEHOLD_CALENDARS });
      installations.push(home);
      equipHousehold(home.db, home.now());
      const walls: string[] = [];
      for (const name of ['Kitchen', 'Hall', 'Bedroom', 'Study']) walls.push(await home.pairWall(name));
      const panels: string[] = [];
      for (const name of ['Porch', 'Shed']) {
        expect((await home.post('/admin/epaper', { name, preset: 'seeed-7in5', rotation: '0' })).status).toBe(303);
        panels.push((home.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id);
      }

      /*
       * Server time. One warm round first — the first build of a manifest
       * pays for JIT and for SQLite's page cache, which a household's second
       * visit does not — then five rounds, medians reported.
       */
      const html = await (await home.call('/admin/walls')).text();
      const hasPreviews = html.includes('id="wall-previews"');
      const builds = hasPreviews
        ? [
            ...walls.map((id) => `/admin/layout/preview.json?screen=${id}`),
            ...panels.map((id) => `/admin/epaper/${id}/preview.png`),
          ]
        : [];
      const cold: number[] = [];
      for (const path of ['/admin/walls', ...builds]) cold.push(await timed(home, path));
      const coldTotal = cold.reduce((sum, one) => sum + one, 0);
      const pageTimes: number[] = [];
      const buildTimes = new Map<string, number[]>();
      for (let round = 0; round < 5; round++) {
        pageTimes.push(await timed(home, '/admin/walls'));
        for (const path of builds) {
          const had = buildTimes.get(path) ?? [];
          had.push(await timed(home, path));
          buildTimes.set(path, had);
        }
      }
      const page = median(pageTimes);
      const perBuild = [...buildTimes.entries()].map(([path, times]) => ({ path, ms: median(times) }));
      const buildsTotal = perBuild.reduce((sum, one) => sum + one.ms, 0);

      /*
       * Browser time, from navigation start. `attachShadow` is patched from an
       * init script to stamp the host the moment a card is drawn into — the
       * draw is synchronous from there — and a panel's picture is stamped by
       * its image's own load event.
       */
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
      const requests: string[] = [];
      let firstCardMs = 0;
      let aboveFoldMs = 0;
      let aboveFold = 0;
      let inView = 0;
      let allMs = 0;
      let cards = 0;
      try {
        const tab: Page = await context.newPage();
        await home.signIn(tab);
        await tab.addInitScript(() => {
          const original = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function patched(this: Element, init: ShadowRootInit): ShadowRoot {
            const root = original.call(this, init);
            (this as HTMLElement).dataset['drawnAt'] = String(performance.now());
            return root;
          };
          document.addEventListener(
            'load',
            (event) => {
              const target = event.target;
              if (target instanceof HTMLImageElement && target.classList.contains('wall-ink')) {
                target.dataset['drawnAt'] = String(performance.now());
              }
            },
            true,
          );
        });
        tab.on('request', (request) => {
          const url = request.url();
          if (url.includes('/admin/layout/preview.json') || url.includes('/preview.png')) requests.push(url);
        });
        await tab.goto(`${home.base}/admin/walls`, { waitUntil: 'load' });
        if (hasPreviews) {
          await tab.waitForFunction(
            () =>
              Array.from(document.querySelectorAll<HTMLElement>('.wall-preview')).every((el) => {
                const image = el.querySelector<HTMLImageElement>('img.wall-ink');
                return image === null ? el.dataset['drawnAt'] !== undefined : image.complete;
              }),
            undefined,
            { timeout: 60_000 },
          );
        }
        const read = await tab.evaluate(() => {
          const fold = window.innerHeight;
          const pictures = Array.from(document.querySelectorAll<HTMLElement>('.wall-preview')).map((el) => {
            const image = el.querySelector<HTMLElement>('img.wall-ink');
            const stamped = (image ?? el).dataset['drawnAt'];
            return { top: el.getBoundingClientRect().top, at: stamped === undefined ? Infinity : Number(stamped) };
          });
          const above = pictures.filter((p) => p.top < fold);
          return {
            cards: pictures.length,
            aboveFold: above.length,
            firstCardMs: Math.min(...pictures.map((p) => p.at)),
            aboveFoldMs: Math.max(...above.map((p) => p.at)),
            allMs: Math.max(...pictures.map((p) => p.at)),
            loadMs: performance.timing.loadEventEnd - performance.timing.navigationStart,
          };
        });
        cards = read.cards;
        aboveFold = read.aboveFold;
        firstCardMs = read.firstCardMs;
        aboveFoldMs = read.aboveFoldMs;
        allMs = read.allMs;
        inView = requests.length;
        // eslint-disable-next-line no-console
        console.log(
          [
            `[walls-list-budget] ${hasPreviews ? 'phase 2' : 'phase 1 (no previews)'} · 4 browser walls + 2 panels, 3 calendars`,
            `  server, warm medians of 5: page ${ms(page)} · builds ${ms(buildsTotal)} over ${perBuild.length} · page+builds ${ms(page + buildsTotal)}`,
            `  server, the cold first round: page ${ms(cold[0] ?? 0)} · page+builds ${ms(coldTotal)}`,
            ...perBuild.map((one) => `    ${ms(one.ms).padStart(8)}  ${one.path}`),
            `  browser @1280x800: load ${ms(read.loadMs)} · first card ${ms(firstCardMs)} · above the fold (${aboveFold} of ${cards}) ${ms(aboveFoldMs)} · all ${ms(allMs)}`,
            `  builds asked for by one page view: ${inView}`,
          ].join('\n'),
        );
      } finally {
        await context.close();
      }

      if (hasPreviews) {
        // One build per card, and not one more. Every card is in view at this
        // size (two rows of three, 200px of root margin), so six.
        expect(cards).toBe(6);
        expect(inView).toBe(walls.length + panels.length);
        expect(new Set(requests).size).toBe(inView);
        // The opt-in ceiling, for a machine whose speed somebody knows.
        const ceiling = Number(process.env['MW_WALLS_BUDGET_MS']);
        if (Number.isFinite(ceiling) && ceiling > 0) {
          expect(aboveFoldMs, 'above-the-fold cards drawn later than the budget').toBeLessThanOrEqual(ceiling);
        }
      }
    },
    SLOW,
  );
});
