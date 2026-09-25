/**
 * What the `browser-countdown-*` files share (plan item P5.2): a real paired
 * Classic wall with three family calendars, on which the forecast's box has
 * been made a countdown — the box a household is most likely to put one in,
 * at the size Classic gives it — and the countdown's config set the way the
 * editor sets it, through the real `POST /admin/layout`.
 *
 * Dates are civil dates in the household's zone counted from the wall's own
 * clock (`HARNESS_HOUR`, pinned), never from the runner's: a countdown twelve
 * days out is twelve days out at eleven in London whatever time the suite
 * started.
 */
import { expect } from 'vitest';
import type { Page } from 'playwright-core';
import { HOUSEHOLD_CALENDARS, equipHousehold, install, instantAt, loadWallSettled, type Installation } from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

export type Orientation = 'portrait' | 'landscape';

export const ZONE = 'Europe/London';

export const SIZES: readonly { readonly width: number; readonly height: number; readonly orientation: Orientation }[] = [
  { width: 1080, height: 1920, orientation: 'portrait' },
  { width: 1920, height: 1080, orientation: 'landscape' },
];

/** A wall nobody has measured, and one set to a 32" television read from 1.2m. */
export const WALLS: readonly (string | undefined)[] = [undefined, 'tv-32'];
export const wallName = (preset: string | undefined): string => preset ?? 'unmeasured';

export interface CountdownWall {
  readonly wall: Installation;
  readonly link: string;
  readonly screenId: string;
  /** The box Classic seeded as its forecast, per orientation: now a countdown. */
  readonly box: Record<Orientation, { readonly id: string; readonly w: number; readonly h: number }>;
}

/** The civil date `days` from `at` in the household's zone, as `YYYY-MM-DD`. */
export function civilDate(at: number, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(at);
  const anchor = Date.parse(`${today}T12:00:00Z`) + days * 86_400_000;
  return new Date(anchor).toISOString().slice(0, 10);
}

export async function countdownWall(): Promise<CountdownWall> {
  const wall = await install({ calendars: HOUSEHOLD_CALENDARS, timezone: ZONE });
  equipHousehold(wall.db, wall.now());
  const screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (link === undefined) throw new Error('the pairing page printed no link');
  const box = {} as Record<Orientation, { id: string; w: number; h: number }>;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const row = readLayoutWidgets(wall.db, screenId, orientation).find((one) => one.type === 'weather');
    if (row === undefined) throw new Error(`Classic seeded no forecast on the ${orientation} canvas`);
    box[orientation] = { id: row.id, w: row.w, h: row.h };
  }
  return { wall, link, screenId, box };
}

/**
 * Make Classic's forecast box a countdown with this config, in both
 * orientations — the whole canvas posted, so the schema is the boundary. A
 * `resize` grows the box from where it sits, and leaving it out puts it back
 * to Classic's own size.
 */
export async function setCountdown(
  cw: CountdownWall,
  config: Record<string, unknown>,
  resize?: { readonly w?: number; readonly h?: number },
): Promise<void> {
  for (const orientation of ['portrait', 'landscape'] as const) {
    const rows = readLayoutWidgets(cw.wall.db, cw.screenId, orientation);
    const seed = cw.box[orientation];
    const widgets = rows.map((row) => {
      const mine = row.id === seed.id;
      const own = (row.config as Record<string, unknown> | null) ?? {};
      const merged = mine ? config : own;
      return {
        id: row.id,
        type: mine ? 'countdown' : row.type,
        x: row.x,
        y: row.y,
        w: mine ? (resize?.w ?? seed.w) : row.w,
        h: mine ? (resize?.h ?? seed.h) : row.h,
        // Drawn on top, so a box grown into its neighbour is measured on its own.
        z: mine ? 100 : row.z,
        ...(Object.keys(merged).length > 0 ? { config: merged } : {}),
      };
    });
    const aspects = cw.wall.db
      .prepare('SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?')
      .get(cw.screenId) as { p: number; l: number };
    const saved = await cw.wall.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: cw.screenId,
        orientation,
        mode: 'freeform',
        aspect: orientation === 'portrait' ? aspects.p : aspects.l,
        widgets,
      }),
    });
    expect(saved.status, `saving the ${orientation} canvas with the countdown ${JSON.stringify(config)}`).toBe(200);
  }
}

/** The wall's own physical facts, or none. */
export function measureScreen(cw: CountdownWall, preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  cw.wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, cw.screenId);
}

/**
 * Every run of text and every picture in the countdown's box, and what cuts
 * it: `clipped` names each visible node whose own content is wider than its
 * box (`scrollWidth` past `clientWidth`, the only reading that can see a
 * `nowrap` run cut) or whose box ends outside the widget's content edge;
 * `belted` counts what the belt took off the glass, which a tier chosen right
 * leaves at nothing.
 */
export async function readCountdownBox(page: Page, widgetId: string): Promise<{
  readonly clipped: readonly string[];
  readonly numerals: readonly { readonly text: string; readonly variant: string }[];
  readonly belted: number;
  readonly tier: string | null;
  readonly rungs: string | null;
}> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error(`no countdown box ${id}`);
    const style = getComputedStyle(box);
    const outer = box.getBoundingClientRect();
    const content = {
      left: outer.left + parseFloat(style.paddingLeft),
      right: outer.right - parseFloat(style.paddingRight),
      top: outer.top + parseFloat(style.paddingTop),
      bottom: outer.bottom - parseFloat(style.paddingBottom),
    };
    const clipped: string[] = [];
    const numerals: { text: string; variant: string }[] = [];
    for (const node of Array.from(box.querySelectorAll<HTMLElement>('div, span, img'))) {
      if (node.closest('.cd-confetti, .cdp-leaf, .cdt-flap-old') !== null) continue;
      if (getComputedStyle(node).display === 'none') continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const words = Array.from(node.childNodes)
        .filter((one) => one.nodeType === Node.TEXT_NODE)
        .map((one) => one.textContent ?? '')
        .join('')
        .trim();
      const label = `${node.getAttribute('class') ?? node.tagName} "${words}"`;
      if (node.scrollWidth > node.clientWidth + 0.5 && words !== '') {
        clipped.push(`${label} is cut: ${node.scrollWidth} > ${node.clientWidth}`);
      }
      if (
        r.bottom > content.bottom + 0.5 ||
        r.top < content.top - 0.5 ||
        r.right > content.right + 0.5 ||
        r.left < content.left - 0.5
      ) {
        clipped.push(`${label} ends outside the box: ${JSON.stringify([r.left, r.top, r.right, r.bottom])} vs ${JSON.stringify(content)}`);
      }
      if (/\d/.test(words)) numerals.push({ text: words, variant: getComputedStyle(node).fontVariantNumeric });
    }
    return {
      clipped,
      numerals,
      belted: Array.from(box.querySelectorAll<HTMLElement>('*')).filter((one) => one.style.display === 'none').length,
      tier: box.getAttribute('data-tier'),
      rungs: box.getAttribute('data-rungs'),
    };
  }, widgetId);
}

/**
 * What each wall role resolves to on this page, in px — off a probe whose
 * `font-size` is the role itself, so the answer is the cascade's. `undefined`
 * on an unmeasured wall, which sets none.
 */
export async function roleSizes(page: Page): Promise<Record<string, number | undefined>> {
  return page.evaluate(() => {
    const out: Record<string, number | undefined> = {};
    const canvas = document.querySelector('#wall .canvas') ?? document.body;
    for (const role of ['event', 'lede', 'scaffold', 'label', 'clock']) {
      const set = getComputedStyle(document.documentElement).getPropertyValue(`--t-wall-${role}`).trim();
      if (set === '') {
        out[role] = undefined;
        continue;
      }
      const probe = document.createElement('span');
      probe.style.fontSize = `var(--t-wall-${role})`;
      canvas.appendChild(probe);
      out[role] = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
    }
    return out;
  });
}

/** The computed font size of the first node matching `selector` in the box, or undefined. */
export async function fontSizeIn(page: Page, widgetId: string, selector: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, sel }) => {
      const node = document.querySelector(`#wall .canvas .fw[data-widget-id="${id}"] ${sel}`);
      return node === null ? undefined : parseFloat(getComputedStyle(node).fontSize);
    },
    { id: widgetId, sel: selector },
  );
}

/**
 * A picture on the wall is bundled artwork: a same-origin `<img>` that has
 * actually loaded, never a code point in the text. Returns what was found.
 */
export async function picturesIn(page: Page, widgetId: string): Promise<{
  readonly images: readonly { readonly src: string; readonly alt: string; readonly loaded: boolean; readonly height: number; readonly parentFont: number }[];
  readonly codePoints: readonly string[];
}> {
  return page.evaluate(async (id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error(`no countdown box ${id}`);
    const imgs = Array.from(box.querySelectorAll<HTMLImageElement>('img'));
    await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
    const text = box.textContent ?? '';
    return {
      images: imgs.map((img) => ({
        src: img.src,
        alt: img.alt,
        loaded: img.complete && img.naturalWidth > 0,
        height: img.getBoundingClientRect().height,
        parentFont: parseFloat(getComputedStyle(img.parentElement ?? img).fontSize),
      })),
      codePoints: [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x2000 && !/[’“”–—…]/.test(ch)),
    };
  }, widgetId);
}

/** Force a redraw with a poll, the way `browser-motion` does. */
export async function poll(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
}

/** The two sizes, and a 2560x1440 television: the three a large reading's cap is held at (D1). */
export const RATIO_SIZES: readonly { readonly width: number; readonly height: number; readonly orientation: Orientation }[] = [
  ...SIZES,
  { width: 2560, height: 1440, orientation: 'landscape' },
];

/**
 * Load the wall twenty seconds before tomorrow's midnight on the wall's own
 * clock, with Playwright's clock in the page so the wall's own tick can be
 * run on rather than slept through, and every later poll refused so nothing
 * but the wall's clock can change what it draws (`browser-scheduled-canvas`
 * says why: a poll re-takes the offset from the server, which runs at the
 * ordinary rate). Returns the page and how long until midnight on the wall.
 */
export async function loadBeforeMidnight(
  cw: CountdownWall,
  size: { readonly width: number; readonly height: number },
): Promise<{ readonly page: Page; readonly close: () => Promise<void>; readonly toMidnight: () => number }> {
  const midnight = instantAt(ZONE, 1, 0, 0);
  cw.wall.shiftClock(midnight - 20_000 - cw.wall.now());
  const { page, close } = await loadWallSettled(cw.link, size, { clock: 'installed' });
  await page.route('**/d/manifest*', (route) => route.abort('connectionrefused'));
  return { page, close, toMidnight: () => midnight - cw.wall.now() };
}

/**
 * Run the wall's own clock on a second at a time until a draw puts `selector`
 * on the glass, and say how many seconds that took; `undefined` if it never did.
 */
export async function runUntil(page: Page, selector: string, seconds: number): Promise<number | undefined> {
  for (let step = 1; step <= seconds; step++) {
    await page.clock.runFor(1_000);
    if ((await page.$$(selector)).length > 0) return step;
  }
  return undefined;
}

/** The computed animation on the first node matching a selector: its name and whether it runs. */
export async function motionOf(page: Page, selector: string): Promise<{ readonly name: string; readonly running: number }> {
  return page.$eval(selector, (node) => ({
    name: getComputedStyle(node).animationName,
    running: node.getAnimations().filter((one) => one.playState === 'running').length,
  }));
}
