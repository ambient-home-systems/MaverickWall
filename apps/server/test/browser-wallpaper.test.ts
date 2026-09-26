import { inflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { wallpaperById } from '../src/wallpapers.js';

/**
 * A wallpaper on a real wall (plan items P6.1, P6.3 and P6.4), measured.
 *
 * Painted pixels, read out of a screenshot, rather than a class or a
 * declaration — the one form a browser can be held to for a picture. Three
 * questions at both orientations, and two about what happens when the picture
 * is not there:
 *
 *  - **the wallpaper covers the canvas**: with every widget hidden, every
 *    sampled point from corner to corner is the picture and none is the
 *    theme's ground, and the file the canvas asked for is the one its pixel
 *    size chose;
 *  - **the ground paints behind each widget**: with every widget's *content*
 *    hidden, the middle of each box is the theme's `--panel` laid over the
 *    picture at the Soft ground's opacity, to within a few levels of the
 *    arithmetic — which is only true if the layer is there, the size of the
 *    box, and under the words;
 *  - **the text still reads on it**: the wall's `--ink` against each of those
 *    painted grounds clears 4.5:1;
 *  - a file that never arrives, and an id the catalogue does not name, both
 *    leave the theme's own ground showing (rule nine).
 *
 * The picture used is `paper`, a *light* wallpaper on the default dark theme,
 * deliberately: it is the pairing the picker warns about, and it is the one
 * where "the picture is showing" and "the theme's ground is showing" are
 * pixels a long way apart, so neither half can be passed by the other.
 */

process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const PORTRAIT = { width: 1080, height: 1920 } as const;
const LANDSCAPE = { width: 1920, height: 1080 } as const;
/** The Soft ground's opacity — `display.css`, `.canvas[data-ground="soft"]`. */
const SOFT = 0.86;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Both orientations' background, as the editor would have saved it. */
function setBackground(json: string | null): void {
  wall.db
    .prepare('UPDATE screens SET layout_background = ?, layout_landscape_background = ?, widget_ground = NULL WHERE id = ?')
    .run(json, json, screenId);
}

// --- Pixels ------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/** An 8-bit RGB or RGBA PNG, as Chromium's screenshots are, into rows of pixels. */
function decodePng(png: Buffer): { readonly width: number; readonly at: (x: number, y: number) => Rgb } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs are read here');
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`PNG colour type ${String(body[9])} is not read here`);
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i] as number;
      const left = i >= channels ? (pixels[y * stride + i - channels] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + i] as number) : 0;
      const corner = y > 0 && i >= channels ? (pixels[(y - 1) * stride + i - channels] as number) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    at: (x, y) => {
      const i = Math.round(y) * stride + Math.round(x) * channels;
      return [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
    },
  };
}

function luminance([r, g, b]: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const near = (a: Rgb, b: Rgb, tolerance: number): boolean => a.every((v, i) => Math.abs(v - (b[i] as number)) <= tolerance);

/** Parse `rgb(r, g, b)` / `rgba(…)` from a computed style. */
function rgbOf(css: string): Rgb {
  const parts = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (parts === null) throw new Error(`not an rgb colour: ${css}`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

// --- Reading the wall ----------------------------------------------------------

interface Drawn {
  readonly image: string;
  /** The declaration as written, before the browser resolves it against anything. */
  readonly inline: string;
  readonly size: string;
  readonly canvasColor: string;
  readonly ground: string | null;
  readonly panel: string;
  readonly ink: string;
  readonly canvas: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly leaves: readonly {
    readonly id: string;
    readonly grounded: boolean;
    readonly before: { readonly color: string; readonly opacity: string; readonly width: number; readonly height: number };
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
}

/** The canvas's computed background, its theme's two colours, and every leaf box's ground. */
function readWall(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#wall .canvas') as HTMLElement;
    const style = getComputedStyle(canvas);
    // The theme's own colours, resolved through the live cascade by a probe.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:1px;height:1px;background:var(--panel);color:var(--ink)';
    canvas.appendChild(probe);
    const probed = getComputedStyle(probe);
    const panel = probed.backgroundColor;
    const ink = probed.color;
    probe.remove();
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const leaves = [...canvas.querySelectorAll<HTMLElement>('.fw')]
      .filter((box) => !box.classList.contains('fw-group'))
      .map((box) => {
        const before = getComputedStyle(box, '::before');
        return {
          id: box.dataset['widgetId'] ?? '',
          grounded: box.classList.contains('has-ground'),
          before: {
            color: before.backgroundColor,
            opacity: before.opacity,
            width: parseFloat(before.width),
            height: parseFloat(before.height),
          },
          rect: rect(box),
        };
      });
    return {
      image: style.backgroundImage,
      inline: canvas.style.backgroundImage,
      size: style.backgroundSize,
      canvasColor: style.backgroundColor,
      ground: canvas.getAttribute('data-ground'),
      panel,
      ink,
      canvas: rect(canvas),
      leaves,
    };
  });
}

/** Wait until the canvas's wallpaper has decoded and been painted. */
async function wallpaperPainted(page: Page, url: string): Promise<{ width: number }> {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { width: img.naturalWidth };
  }, url);
}

/**
 * A screenshot of the canvas with something hidden, decoded.
 *
 * Hidden through the CSSOM rather than an injected `<style>`: the wall's
 * Content-Security-Policy refuses an inline stylesheet, and the CSSOM is the
 * door the policy does not govern (the one `display-csp.test.ts` names).
 */
async function canvasPixels(page: Page, hide: string): Promise<ReturnType<typeof decodePng>> {
  await page.evaluate(async (selector) => {
    const sheet = document.styleSheets[0] as CSSStyleSheet;
    sheet.insertRule(`${selector} { visibility: hidden !important; }`, sheet.cssRules.length);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, hide);
  const shot = await page.screenshot({ type: 'png' });
  await page.evaluate(() => {
    const sheet = document.styleSheets[0] as CSSStyleSheet;
    sheet.deleteRule(sheet.cssRules.length - 1);
  });
  return decodePng(shot);
}

/**
 * Nine points from corner to corner, just inside the canvas.
 *
 * Sixteen pixels in, because the canvas has the theme's own rounded corners
 * (`--radius`, about eight pixels on this wall) and a point inside the curve
 * is the page behind the canvas rather than anything the canvas drew.
 */
function samplePoints(canvas: Drawn['canvas']): { readonly x: number; readonly y: number }[] {
  const inset = 16;
  const points: { x: number; y: number }[] = [];
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      points.push({
        x: canvas.x + inset + fx * (canvas.width - 2 * inset),
        y: canvas.y + inset + fy * (canvas.height - 2 * inset),
      });
    }
  }
  return points;
}

describe.each([
  ['portrait', PORTRAIT],
  ['landscape', LANDSCAPE],
] as const)('a wallpaper on a %s wall', (_, viewport) => {
  it(
    'covers the canvas, and the Soft ground paints behind each widget with its text still readable',
    async () => {
      setBackground('{"type":"wallpaper","id":"paper"}');
      const paper = wallpaperById('paper');
      if (paper === undefined) throw new Error('the catalogue has no paper');
      const { page, close } = await loadWallSettled(link, viewport);
      try {
        const first = await readWall(page);
        // The longer side is 1920 device pixels at both orientations, past the
        // small file's 1600, so the canvas asks for the large one — by the
        // absolute path, since a wall sits at the root of its own origin.
        expect(first.image).toContain(`/assets/wallpapers/${paper.large}`);
        expect(first.inline).toBe(`url("/assets/wallpapers/${paper.large}")`);
        expect(first.size).toBe('cover');
        const url = /url\("([^"]+)"\)/.exec(first.image)?.[1] ?? '';
        expect((await wallpaperPainted(page, url)).width, 'the large file did not load').toBe(2880);
        const drawn = await readWall(page);

        // The picture everywhere, and the theme's ground nowhere.
        const bare = await canvasPixels(page, '#wall .fw');
        const panel = rgbOf(drawn.panel);
        for (const point of samplePoints(drawn.canvas)) {
          const pixel = bare.at(point.x, point.y);
          expect(luminance(pixel), `(${Math.round(point.x)}, ${Math.round(point.y)}) is ${pixel.join(',')}`).toBeGreaterThan(0.6);
          expect(near(pixel, panel, 30), 'the theme ground is showing where the picture should be').toBe(false);
        }
        // Under the picture, the theme's own ground: what shows while it
        // loads, and if it never does.
        expect(drawn.canvasColor).toBe(drawn.panel);

        // Never chosen, over a wallpaper, is Soft — on every leaf box.
        expect(drawn.ground).toBe('soft');
        expect(drawn.leaves.length).toBeGreaterThan(3);
        const content = await canvasPixels(page, '#wall .fw > *');
        const ink = rgbOf(drawn.ink);
        for (const leaf of drawn.leaves) {
          expect(leaf.grounded, `${leaf.id} has no ground`).toBe(true);
          expect(leaf.before.color, `${leaf.id}'s ground is not the theme's --panel`).toBe(drawn.panel);
          expect(Number(leaf.before.opacity)).toBeCloseTo(SOFT, 5);
          expect(leaf.before.width).toBeCloseTo(leaf.rect.width, 0);
          expect(leaf.before.height).toBeCloseTo(leaf.rect.height, 0);

          const cx = leaf.rect.x + leaf.rect.width / 2;
          const cy = leaf.rect.y + leaf.rect.height / 2;
          const under = bare.at(cx, cy);
          const expected = panel.map((p, i) => p * SOFT + (under[i] as number) * (1 - SOFT)) as unknown as Rgb;
          const painted = content.at(cx, cy);
          expect(near(painted, expected, 4), `${leaf.id}: painted ${painted.join(',')} against ${expected.map(Math.round).join(',')}`).toBe(true);
          expect(contrast(ink, painted), `${leaf.id}: the wall's ink on its ground`).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('a wallpaper through the fifteen-second rebuild', () => {
  /*
   * `draw()` empties and rebuilds the whole wall every tick, so the canvas the
   * wallpaper is set on is a new element four times a minute. The URL is the
   * same each time and the browser's decoded-image cache answers it: measured
   * on this container over ten ticks, no request and about 4ms of main-thread
   * time a tick (CLAUDE.md records the figures). What is asserted is the part
   * that is a property rather than a timing — the rebuilt canvas still carries
   * the picture, and asking for it again did not go to the network.
   */
  it(
    'draws the picture on the rebuilt canvas without asking for it again',
    async () => {
      setBackground('{"type":"wallpaper","id":"dusk"}');
      const { page, close } = await loadWallSettled(link, LANDSCAPE, { clock: 'installed' });
      try {
        const first = await readWall(page);
        const url = /url\("([^"]+)"\)/.exec(first.image)?.[1] ?? '';
        await wallpaperPainted(page, url);
        const requests = (): Promise<number> =>
          page.evaluate(
            () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/wallpapers/')).length,
          );
        const before = await requests();
        await page.evaluate(() => {
          (document.querySelector('#wall .canvas') as HTMLElement).dataset['old'] = '1';
        });
        await page.clock.runFor(15_000);
        const after = await readWall(page);
        expect(
          await page.evaluate(() => (document.querySelector('#wall .canvas') as HTMLElement).dataset['old']),
          'the tick did not rebuild the canvas, so this measured nothing',
        ).toBeUndefined();
        expect(after.image).toBe(first.image);
        expect(await requests(), 'a redraw asked the network for the wallpaper again').toBe(before);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('a wallpaper on a smaller canvas', () => {
  it(
    'draws the small file when the canvas is no larger than it',
    async () => {
      setBackground('{"type":"wallpaper","id":"hills"}');
      const hills = wallpaperById('hills');
      const { page, close } = await loadWallSettled(link, { width: 810, height: 1440 });
      try {
        const drawn = await readWall(page);
        expect(drawn.image).toContain(`/assets/wallpapers/${hills?.small}`);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('a wallpaper that is not there', () => {
  it(
    'leaves the theme ground showing when the file never arrives (rule nine)',
    async () => {
      setBackground('{"type":"wallpaper","id":"paper"}');
      const { page, close } = await loadWallSettled(link, PORTRAIT, {
        beforeLoad: (context) =>
          context.route('**/assets/wallpapers/**', (route) => route.fulfill({ status: 404, body: '' })),
      });
      try {
        const drawn = await readWall(page);
        expect(drawn.image, 'the canvas did ask for the picture').toContain('/assets/wallpapers/');
        expect(drawn.canvasColor).toBe(drawn.panel);
        const bare = await canvasPixels(page, '#wall .fw');
        const panel = rgbOf(drawn.panel);
        for (const point of samplePoints(drawn.canvas)) {
          const pixel = bare.at(point.x, point.y);
          expect(near(pixel, panel, 3), `(${Math.round(point.x)}, ${Math.round(point.y)}) is ${pixel.join(',')}`).toBe(true);
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'draws the theme ground for an id the catalogue does not name, and no widget ground',
    async () => {
      setBackground('{"type":"wallpaper","id":"retired-in-s23"}');
      const { page, close } = await loadWallSettled(link, LANDSCAPE);
      try {
        const drawn = await readWall(page);
        expect(drawn.image).toBe('none');
        expect(drawn.ground).toBeNull();
        expect(drawn.leaves.every((leaf) => !leaf.grounded)).toBe(true);
        const bare = await canvasPixels(page, '#wall .fw');
        const panel = rgbOf(drawn.panel);
        for (const point of samplePoints(drawn.canvas)) {
          expect(near(bare.at(point.x, point.y), panel, 3)).toBe(true);
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the picker', () => {
  it(
    'offers the wallpapers matching the theme, the rest behind a warning, and applies one to both orientations',
    async () => {
      setBackground(null);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await page.click('.le-bar-main button:has-text("Layout")');
        await page.selectOption('.le-bg select', 'wallpaper');

        const offered = (): Promise<string[]> =>
          page.$$eval('.le-wallpapers [data-wallpaper]', (tiles) => tiles.map((t) => (t as HTMLElement).dataset['wallpaper'] ?? ''));
        // Panels is dark, so the dark ones, and not the light one.
        expect((await offered()).sort()).toEqual(['dusk', 'hills']);
        // Every thumbnail is written relative — so it resolves under the
        // admin's <base>, which under ingress carries the add-on's prefix — and
        // answers. The harness has no prefix, so an absolute path would resolve
        // to the same place here; the spelling is what can tell them apart.
        const written = await page.$$eval('.le-wallpapers [data-wallpaper]', (tiles) =>
          tiles.map((t) => (t as HTMLElement).style.backgroundImage),
        );
        for (const one of written) expect(one.startsWith('url("assets/wallpapers/'), one).toBe(true);
        const thumbs = await page.$$eval('.le-wallpapers [data-wallpaper]', (tiles) =>
          tiles.map((t) => /url\("([^"]+)"\)/.exec(getComputedStyle(t).backgroundImage)?.[1] ?? ''),
        );
        for (const thumb of thumbs) {
          expect(thumb.startsWith(`${wall.base}/assets/wallpapers/`), thumb).toBe(true);
          expect((await wall.call(new URL(thumb).pathname)).status, thumb).toBe(200);
        }

        await page.click('.le-wallpapers label:has-text("Show wallpapers drawn for a light theme")');
        expect((await offered()).sort()).toEqual(['dusk', 'hills', 'paper']);
        expect(await page.locator('.le-wallpapers p.hint').textContent()).toContain('may be hard to read');

        await page.click('.le-wallpapers [data-wallpaper="hills"]');
        expect(await page.getAttribute('.le-wallpapers [data-wallpaper="hills"]', 'aria-pressed')).toBe('true');
        // The preview draws it, from the relative base, and at a preview's size
        // the small file.
        const preview = await page.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot?.querySelector('.canvas');
          return canvas instanceof HTMLElement
            ? { computed: getComputedStyle(canvas).backgroundImage, inline: canvas.style.backgroundImage }
            : { computed: '', inline: '' };
        });
        expect(preview.computed).toContain(`${wall.base}/assets/wallpapers/${wallpaperById('hills')?.small}`);
        expect(preview.inline).toBe(`url("assets/wallpapers/${wallpaperById('hills')?.small}")`);

        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click('[data-action="save"]')]);
        const stored = wall.db
          .prepare('SELECT layout_background AS p, layout_landscape_background AS l FROM screens WHERE id = ?')
          .get(screenId) as { p: string; l: string };
        // "Use for both" is the default: one choice, both orientations.
        expect(JSON.parse(stored.p)).toEqual({ type: 'wallpaper', id: 'hills' });
        expect(JSON.parse(stored.l)).toEqual({ type: 'wallpaper', id: 'hills' });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

describe('a light theme in the editor', () => {
  it(
    'offers the light wallpapers, and a Card background starts from the theme’s own card colour',
    async () => {
      setBackground(null);
      wall.db.prepare(`UPDATE screens SET theme = 'household' WHERE id = ?`).run(screenId);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });

        await page.click('.le-bar-main button:has-text("Layout")');
        await page.selectOption('.le-bg select', 'wallpaper');
        const offered = await page.$$eval('.le-wallpapers [data-wallpaper]', (tiles) =>
          tiles.map((t) => (t as HTMLElement).dataset['wallpaper'] ?? ''),
        );
        expect(offered, 'Household is light, so the light wallpaper and not the dark ones').toEqual(['paper']);
        await page.selectOption('.le-bg select', 'none');
        await page.keyboard.press('Escape');

        // It was #111820 on every theme: a near-black card on Household's cream.
        await page.locator('.le-overlay .le-widget').first().click();
        const id = await page.locator('.le-overlay .le-widget').first().getAttribute('data-id');
        await page.click('.insp-tab:has-text("Style")');
        await page.locator('.le-config .switch', { hasText: 'Card background' }).locator('input').click();
        await expect
          .poll(() =>
            page.evaluate((widget) => {
              const node = document
                .querySelector<HTMLElement>('.le-preview')
                ?.shadowRoot?.querySelector<HTMLElement>(`[data-widget-id="${widget}"]`);
              return node === null || node === undefined ? '' : getComputedStyle(node).backgroundColor;
            }, id),
          )
          // Household's `--panel`, #FFFFFF, opaque.
          .toBe('rgb(255, 255, 255)');
      } finally {
        await context.close();
        wall.db.prepare(`UPDATE screens SET theme = 'panels' WHERE id = ?`).run(screenId);
      }
    },
    SLOW,
  );
});
