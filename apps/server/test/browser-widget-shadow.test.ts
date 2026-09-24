/**
 * The drop shadow, honoured again as a theme token (decision D8, plan item
 * P4.4), measured on a real paired wall drawing the shipped Classic seed.
 *
 * Four things have to be true on the glass, and each is read off the computed
 * `box-shadow` rather than off a class or a stored key:
 *
 *  1. **Nothing moves that did not ask.** With no widget storing `shadow`,
 *     every box on the canvas computes `none` on every built-in theme — the
 *     token exists on every theme now, and a wall's pixels may only change
 *     where a stored `shadow: true` draws.
 *  2. **A widget that asked draws its theme's shadow.** Soft on Panels and
 *     Household, paper-like (no blur) on Almanac, none on Blueprint and Swiss,
 *     and scaled with the wall — the offset is a share of the root size, so a
 *     smaller wall casts a proportionally smaller shadow and never a fixed
 *     number of pixels.
 *  3. **The switches are the theme's and the hardware's.** A custom theme set
 *     to None casts none, and a wall sized as an e-ink panel casts none on a
 *     theme that would otherwise — and gets the shadow back when it is
 *     re-measured as a television.
 *  4. **The Style tab's control is back** and writes the key the wall reads.
 */
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
import { readLayoutWidgets } from '../src/api/queries.js';
import { createTheme } from '../src/api/themes.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const PORTRAIT = { width: 1080, height: 1920 } as const;

let wall: Installation;
let link: string;
let screenId: string;
let clockId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
  const clock = readLayoutWidgets(wall.db, screenId, 'portrait').find((row) => row.type === 'clock');
  if (clock === undefined) throw new Error('Classic seeded no clock');
  clockId = clock.id;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Set or clear one widget's `shadow` through the real `POST /admin/layout`. */
async function shadowOn(id: string, on: boolean): Promise<void> {
  const rows = readLayoutWidgets(wall.db, screenId, 'portrait');
  const widgets = rows.map((row) => {
    const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
    if (row.id === id) {
      if (on) config['shadow'] = true;
      else delete config['shadow'];
    }
    return {
      id: row.id, type: row.type, x: row.x, y: row.y, w: row.w, h: row.h, z: row.z,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  });
  const aspect = (wall.db.prepare('SELECT layout_aspect AS a FROM screens WHERE id = ?').get(screenId) as {
    a: number | null;
  }).a;
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspect ?? 0.5625, widgets }),
  });
  expect(saved.status).toBe(200);
}

function wear(theme: string): void {
  wall.db.prepare('UPDATE screens SET theme = ? WHERE id = ?').run(theme, screenId);
}

function measure(preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, screenId);
}

interface Reading {
  /** Every box's computed `box-shadow`, by widget id. */
  readonly shadows: Readonly<Record<string, string>>;
  /** The root's computed font size in px — what one `rem` is on this wall. */
  readonly rem: number;
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const shadows: Record<string, string> = {};
    for (const box of Array.from(document.querySelectorAll<HTMLElement>('#wall .canvas .fw[data-widget-id]'))) {
      shadows[box.dataset['widgetId'] ?? '?'] = getComputedStyle(box).boxShadow;
    }
    return { shadows, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

async function drawn(viewport: { width: number; height: number } = PORTRAIT): Promise<Reading> {
  const { page, close } = await loadWallSettled(link, viewport);
  try {
    return await read(page);
  } finally {
    await close();
  }
}

/** `rgba(r, g, b, a) Xpx Ypx Bpx Spx` — the order a browser computes it in. */
function parts(shadow: string): { colour: string; x: number; y: number; blur: number } | undefined {
  const hit = /^(rgba?\([^)]*\)) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px/.exec(shadow);
  if (hit === null) return undefined;
  return { colour: hit[1]!, x: Number(hit[2]), y: Number(hit[3]), blur: Number(hit[4]) };
}

describe('a wall where no widget asked for a shadow', () => {
  it('draws none on any box, on every built-in theme', async () => {
    await shadowOn(clockId, false);
    measure(undefined);
    for (const theme of Object.keys(BUILTIN_THEME_TOKENS)) {
      wear(theme);
      const { shadows } = await drawn();
      expect(Object.keys(shadows).length, 'no boxes were drawn').toBeGreaterThan(3);
      for (const [id, value] of Object.entries(shadows)) expect(value, `${theme} ${id}`).toBe('none');
    }
  }, SLOW);
});

describe('a widget that asked for a shadow', () => {
  it('casts its theme’s: soft, paper-like or none, and nothing on its neighbours', async () => {
    measure(undefined);
    await shadowOn(clockId, true);

    wear('panels');
    const panels = await drawn();
    const soft = parts(panels.shadows[clockId] ?? '');
    expect(soft, `Panels drew ${panels.shadows[clockId]}`).toBeDefined();
    expect(soft!.colour).toBe('rgba(0, 0, 0, 0.45)');
    expect(soft!.blur).toBeGreaterThan(0);
    for (const [id, value] of Object.entries(panels.shadows)) if (id !== clockId) expect(value, id).toBe('none');

    wear('household');
    const household = parts((await drawn()).shadows[clockId] ?? '');
    expect(household?.colour).toBe('rgba(38, 34, 28, 0.14)');
    expect(household!.blur).toBeGreaterThan(0);

    wear('almanac');
    const almanac = parts((await drawn()).shadows[clockId] ?? '');
    expect(almanac?.colour).toBe('rgba(36, 31, 25, 0.14)');
    expect(almanac?.blur, 'paper-like means no blur').toBe(0);
    expect(almanac!.x).toBeGreaterThan(0);

    for (const flat of ['blueprint', 'swiss']) {
      wear(flat);
      expect((await drawn()).shadows[clockId], flat).toBe('none');
    }
  }, SLOW);

  it('scales with the wall rather than drawing a fixed number of pixels', async () => {
    measure(undefined);
    await shadowOn(clockId, true);
    wear('panels');
    const tall = await drawn(PORTRAIT);
    const small = await drawn({ width: 540, height: 960 });
    // 0.15rem of offset and 0.6rem of blur, at whatever a rem is on each.
    for (const reading of [tall, small]) {
      const shadow = parts(reading.shadows[clockId] ?? '');
      expect(shadow?.y).toBeCloseTo(0.15 * reading.rem, 1);
      expect(shadow?.blur).toBeCloseTo(0.6 * reading.rem, 1);
    }
    expect(small.rem).toBeLessThan(tall.rem);
  }, SLOW);

  it('casts none on a custom theme set to None, and the derived soft one otherwise', async () => {
    measure(undefined);
    await shadowOn(clockId, true);
    const colours = { ...BUILTIN_THEME_TOKENS.panels, '--radius': '0.4rem' };
    const none = createTheme(wall.db, { name: 'Dark room', tokens: { ...colours, '--shadow-card': 'none' }, shape: 'neutral' });
    const soft = createTheme(wall.db, { name: 'Soft room', tokens: colours, shape: 'neutral' });
    wear(`custom:${none.id}`);
    expect((await drawn()).shadows[clockId]).toBe('none');
    wear(`custom:${soft.id}`);
    expect(parts((await drawn()).shadows[clockId] ?? '')?.colour).toBe('rgba(0, 0, 0, 0.45)');
  }, SLOW);

  it('casts none on a wall sized as an e-ink panel, and gets it back as a television', async () => {
    await shadowOn(clockId, true);
    wear('panels');
    measure('eink-7.5');
    expect((await drawn()).shadows[clockId]).toBe('none');
    measure('tv-32');
    expect(parts((await drawn()).shadows[clockId] ?? '')?.colour).toBe('rgba(0, 0, 0, 0.45)');
    measure(undefined);
  }, SLOW);
});

describe('the Style tab', () => {
  it('offers Drop shadow again, and it writes the key the wall reads', async () => {
    await shadowOn(clockId, false);
    wear('panels');
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
      await page.locator(`.le-overlay .le-widget[data-id="${clockId}"]`).click();
      await page.locator('.insp-tab').nth(1).click();
      const toggle = page.locator('.switch', { hasText: 'Drop shadow' }).locator('input[type=checkbox]');
      await toggle.waitFor({ timeout: 20_000 });
      expect(await toggle.isChecked()).toBe(false);
      await toggle.click();
      await page.locator('#savebar button[data-action="save"]').click();
      await expect
        .poll(
          () =>
            (readLayoutWidgets(wall.db, screenId, 'portrait').find((row) => row.id === clockId)?.config as
              | Record<string, unknown>
              | null
              | undefined)?.['shadow'],
          { timeout: 20_000 },
        )
        .toBe(true);
    } finally {
      await context.close();
    }
    // And the wall draws what the control wrote.
    expect(parts((await drawn()).shadows[clockId] ?? '')?.colour).toBe('rgba(0, 0, 0, 0.45)');
  }, SLOW);
});
