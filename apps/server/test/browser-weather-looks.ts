/**
 * What `browser-weather-range` and `browser-weather-colour` share (plan item
 * P5.1): a real paired Classic wall with three family calendars, a forecast
 * that is **the captured London answer** rather than a hand-written one, and
 * the forecast widget's look set the way the editor sets it.
 *
 * The forecast is `fixtures/open-meteo/real/forecast-london-metric.json`, read
 * through the provider's own parser and written into the cache the job would
 * write it into, so the wall draws exactly what a London household on
 * Open-Meteo would see — real highs and lows, real rain chances, real glyphs.
 * Two things are moved and both are said: the days are re-dated onto the wall's
 * own week (the capture is from 24 September, and a forecast for another week
 * is not "today"), and the current reading is re-stamped ten minutes before the
 * wall's clock, because a reading ninety minutes old is not presented as now
 * (P3.4) and the capture is older than that on every day but one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Page } from 'playwright-core';
import { HOUSEHOLD_CALENDARS, equipHousehold, install, type Installation } from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { parseOpenMeteo } from '../src/modules/weather/open-meteo.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

export type Orientation = 'portrait' | 'landscape';

export const SIZES: readonly { readonly width: number; readonly height: number; readonly orientation: Orientation }[] = [
  { width: 1080, height: 1920, orientation: 'portrait' },
  { width: 1920, height: 1080, orientation: 'landscape' },
];

/** A wall nobody has measured, and one set to a 32" television read from 1.2m. */
export const WALLS: readonly (string | undefined)[] = [undefined, 'tv-32'];
export const wallName = (preset: string | undefined): string => preset ?? 'unmeasured';

const HERE = dirname(fileURLToPath(import.meta.url));
const LONDON = readFileSync(join(HERE, 'fixtures', 'open-meteo', 'real', 'forecast-london-metric.json'), 'utf8');

export interface WeatherWall {
  readonly wall: Installation;
  readonly link: string;
  readonly screenId: string;
  /** The Classic forecast's id, and its box as seeded, per orientation. */
  readonly weather: Record<Orientation, { readonly id: string; readonly w: number; readonly h: number }>;
  /** The real days, as the cache holds them. */
  readonly days: readonly { readonly high: number; readonly low: number; readonly precipChance?: number }[];
  /** The current reading's temperature, as seeded. */
  readonly currentTemp: number;
}

/** Today's civil date in London, `days` from the wall's own now. */
function londonDate(at: number, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(at);
  const anchor = Date.parse(`${today}T12:00:00Z`) + days * 86_400_000;
  return new Date(anchor).toISOString().slice(0, 10);
}

export async function weatherWall(): Promise<WeatherWall> {
  const wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  const at = wall.now();
  equipHousehold(wall.db, at);
  wall.db.prepare(`UPDATE household_settings SET weather_units = 'metric' WHERE id = 'singleton'`).run();

  const parts = parseOpenMeteo(LONDON, { now: at, units: 'metric', todayIso: '2026-09-24', limit: 5 });
  if (parts.forecast === undefined || parts.current === undefined) throw new Error('the London capture did not parse');
  const days = parts.forecast.days.map((day, i) => ({ ...day, date: londonDate(at, i) }));
  const current = { ...parts.current, observedAt: at - 10 * 60_000 };
  const write = (key: string, payload: unknown): void => {
    wall.db
      .prepare(
        `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
         VALUES (?, 'openmeteo', ?, ?, ?, NULL)
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(key.replace(/[^a-z0-9]/gi, ''), key, JSON.stringify(payload), at);
  };
  write('openmeteo:forecast', { days, fetchedAt: at });
  write('openmeteo:current', { reading: current });

  const screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (link === undefined) throw new Error('the pairing page printed no link');
  const weather = {} as Record<Orientation, { id: string; w: number; h: number }>;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const row = readLayoutWidgets(wall.db, screenId, orientation).find((one) => one.type === 'weather');
    if (row === undefined) throw new Error(`Classic seeded no forecast on the ${orientation} canvas`);
    weather[orientation] = { id: row.id, w: row.w, h: row.h };
  }
  return {
    wall,
    link,
    screenId,
    weather,
    days: days.map((day) => ({
      high: day.high as number,
      low: day.low as number,
      ...(day.precipChance === undefined ? {} : { precipChance: day.precipChance }),
    })),
    currentTemp: current.temp as number,
  };
}

/**
 * Set the forecast's config the way the editor does — the real `POST
 * /admin/layout` with the whole canvas, so the schema is the boundary. A
 * `resize` grows the box downward (and back to the seed with none), keeping
 * its position, so a taller box is the same box with more room under it.
 */
export async function setWeather(
  ww: WeatherWall,
  orientation: Orientation,
  config: Record<string, unknown>,
  resize?: { readonly w?: number; readonly h?: number },
): Promise<void> {
  const rows = readLayoutWidgets(ww.wall.db, ww.screenId, orientation);
  const seed = ww.weather[orientation];
  const widgets = rows.map((row) => {
    const isWeather = row.id === seed.id;
    const own = { ...((row.config as Record<string, unknown> | null) ?? {}) };
    const merged = isWeather ? config : own;
    const w = isWeather ? (resize?.w ?? seed.w) : row.w;
    const h = isWeather ? (resize?.h ?? seed.h) : row.h;
    return {
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w,
      h,
      // Drawn on top, so a box grown into its neighbour is measured on its own.
      z: isWeather ? 100 : row.z,
      ...(Object.keys(merged).length > 0 ? { config: merged } : {}),
    };
  });
  const aspects = ww.wall.db
    .prepare('SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?')
    .get(ww.screenId) as { p: number; l: number };
  const saved = await ww.wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: ww.screenId,
      orientation,
      mode: 'freeform',
      aspect: orientation === 'portrait' ? aspects.p : aspects.l,
      widgets,
    }),
  });
  expect(saved.status, `saving the ${orientation} canvas with the forecast ${JSON.stringify(config)}`).toBe(200);
}

/** The wall's own physical facts, or none — `wall-density.test.ts`'s helper. */
export function measureScreen(ww: WeatherWall, preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  ww.wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, ww.screenId);
}

/**
 * Every run of text and every picture in the forecast box, and what cuts it.
 *
 * `clipped` names each visible node whose own content is wider than its box
 * (`scrollWidth` past `clientWidth` — the only reading that can see a
 * `nowrap` run cut, CLAUDE.md records why a rect cannot) or whose box ends
 * past the forecast box's content edge. `numerals` is every text run that
 * carries a figure, with its computed `font-variant-numeric`.
 */
export async function readForecastBox(page: Page, widgetId: string): Promise<{
  readonly clipped: readonly string[];
  readonly numerals: readonly { readonly text: string; readonly variant: string }[];
  readonly tier: string | null;
  readonly items: number;
  readonly rungs: string | null;
  /** How many things the belt took off the glass: a tier set right leaves it nothing. */
  readonly belted: number;
}> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error(`no forecast box ${id}`);
    const style = getComputedStyle(box);
    const outer = box.getBoundingClientRect();
    const content = {
      left: outer.left + parseFloat(style.paddingLeft),
      right: outer.right - parseFloat(style.paddingRight),
      top: outer.top + parseFloat(style.paddingTop),
      bottom: outer.bottom - parseFloat(style.paddingBottom),
    };
    const visible = (node: Element): boolean => {
      for (let at: Element | null = node; at !== null && at !== box; at = at.parentElement) {
        if (getComputedStyle(at).display === 'none') return false;
      }
      return true;
    };
    const clipped: string[] = [];
    const numerals: { text: string; variant: string }[] = [];
    for (const node of Array.from(box.querySelectorAll<HTMLElement | SVGElement>('span, div, svg'))) {
      if (!visible(node)) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const words = Array.from(node.childNodes)
        .filter((one) => one.nodeType === Node.TEXT_NODE)
        .map((one) => one.textContent ?? '')
        .join('')
        .trim();
      const label = `${node.getAttribute('class') ?? node.tagName} "${words}"`;
      if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 0.5 && words !== '') {
        clipped.push(`${label} is cut: ${node.scrollWidth} > ${node.clientWidth}`);
      }
      // The bar's own parts are drawn inside the track on purpose (the ramp
      // is a whole track wide and its window clips it); every other node has
      // to sit inside the box.
      const cls = node.getAttribute('class') ?? '';
      if (/\bwr-(ramp|fill|now)\b/.test(cls)) continue;
      if (r.bottom > content.bottom + 0.5 || r.right > content.right + 0.5 || r.left < content.left - 0.5) {
        clipped.push(`${label} ends outside the box: ${JSON.stringify([r.left, r.right, r.bottom])} vs ${JSON.stringify(content)}`);
      }
      if (/\d/.test(words)) numerals.push({ text: words, variant: getComputedStyle(node).fontVariantNumeric });
    }
    const belted = Array.from(box.querySelectorAll<HTMLElement>('*')).filter((one) => one.style.display === 'none').length;
    return {
      clipped,
      numerals,
      belted,
      tier: box.getAttribute('data-tier'),
      items: Number(box.getAttribute('data-tier-items') ?? '0'),
      rungs: box.getAttribute('data-rungs'),
    };
  }, widgetId);
}

/**
 * What a wall role resolves to on this page, in px — read off a probe whose
 * `font-size` is the role itself, so the answer is the cascade's and not this
 * file's arithmetic. `undefined` on an unmeasured wall, which sets none.
 */
export async function roleSizes(page: Page): Promise<Record<string, number | undefined>> {
  return page.evaluate(() => {
    const out: Record<string, number | undefined> = {};
    const canvas = document.querySelector('#wall .canvas') ?? document.body;
    for (const role of ['event', 'time', 'scaffold']) {
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

/** Resolve a colour token to the `rgb(…)` the page computes for it, inside a box. */
export async function tokenColours(page: Page, widgetId: string, tokens: readonly string[]): Promise<Record<string, string>> {
  return page.evaluate(
    ({ id, names }) => {
      const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`) ?? document.body;
      const out: Record<string, string> = {};
      for (const name of names) {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        box.appendChild(probe);
        out[name] = getComputedStyle(probe).color;
        probe.remove();
      }
      return out;
    },
    { id: widgetId, names: tokens },
  );
}
