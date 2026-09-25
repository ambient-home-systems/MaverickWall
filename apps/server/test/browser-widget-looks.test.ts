/**
 * Every widget type's Look, in the editor and on the wall (plan item P4.1).
 *
 * `variant` was the clock's alone; the September household review gave
 * weather, countdown, Home Assistant and the calendar their own lists, ahead
 * of the sessions that design each look. That is groundwork, and groundwork
 * has two promises that no unit test can see and both are asked here of a real
 * editor and a real paired wall:
 *
 *  1. **The editor offers exactly each type's list.** Read off the table the
 *     panel shares with the wall (`epaper/variants.ts`, held to the display's
 *     by `variants-parity.test.ts`), label for label and in order — a segmented
 *     row up to three looks, and a grid of labelled choices past that, which
 *     is asserted from where the buttons *landed* rather than from a class. A
 *     type with no looks draws no Look at all. The default is written as an
 *     absence and a chosen look as itself — the calendar's default included,
 *     which has no name to write. On the ink lane a forecast's Look is offered
 *     as the three a panel is offered (P5.1: the strip, Today and Range), and
 *     a wall wearing a look the panel draws as its strip says so under it.
 *     A countdown's (P5.2) is the three a panel draws, beside its words; and
 *     its Content tab offers the words, a grid of the bundled pictures and the
 *     celebration switch, each default written as an absence.
 *
 *  2. **No undesigned look draws anything yet.** Every renderer draws its
 *     type's default for every one of the new values but the four P5.1 and
 *     P5.2 designed — the forecast's `range` and `colour`, the countdown's
 *     `page` and `ticket`, each measured in its own files — so a
 *     household who picks one sees exactly what they had. Measured rather than read: boxes of one size
 *     in a row, one per value and one with none, and every element in each
 *     box — its tag, its class, its words, its rectangle relative to its box
 *     and its computed type — held to its default sibling's, at 1080x1920 and
 *     1920x1080. When a later session designs a look, this is the assertion it
 *     changes on purpose, for that value alone.
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
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { VARIANTS, VARIANT_LABELS, type VariantType } from '../src/epaper/variants.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

type Orientation = 'portrait' | 'landscape';

let wall: Installation;
let link: string;
let screenId: string;

/** The types with looks the wall does not draw yet: every type's but the clock's. */
const UNDRAWN: readonly VariantType[] = ['weather', 'countdown', 'homeassistant', 'calendar'];
/**
 * The looks on those types that *are* designed now, and are measured in their
 * own files instead: the forecast's `range` and `colour` (plan item P5.1,
 * `browser-weather-range` and `browser-weather-colour`) and the countdown's
 * `page` and `ticket` (P5.2, `browser-countdown-page` and
 * `browser-countdown-ticket`). Every other value of the four types is still
 * held to drawing its default here — the countdown's `number` is its default,
 * and `occasion`, `progress` and `month` are the second half of P5.2.
 */
const DESIGNED: ReadonlySet<string> = new Set(['weather.range', 'weather.colour', 'countdown.page', 'countdown.ticket']);

/** What each type needs to have something to say, so no box is left out. */
const BASE_CONFIG: Readonly<Record<string, Record<string, unknown>>> = {
  weather: {},
  countdown: { title: 'Holiday', target: '2027-08-01' },
  homeassistant: {},
  calendar: {},
};

/** A watched reading or three, so a Home Assistant box has a list to draw. */
function equipHouse(): void {
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', wall.now());
  const rows = [
    ['sensor.kitchen', '19.4', 'Kitchen', '°C'],
    ['sensor.hall', '18.1', 'Hall', '°C'],
    ['binary_sensor.front_door', 'off', 'Front door', null],
  ] as const;
  let order = 0;
  for (const [id, state, name, unit] of rows) {
    wall.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'label_value', NULL, ?)
         ON CONFLICT(entity_id) DO UPDATE SET state = excluded.state, watched = 1`,
      )
      .run(id, state, '{}', name, unit, wall.now(), wall.now(), order++);
  }
}

interface Placed {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly config?: Record<string, unknown>;
}

/**
 * One row per type, every box in a row the same size: the first with no
 * `variant`, then one per value of the type's list. Rows are sized so each
 * type has room to draw real content — a calendar gets the tallest, because a
 * month grid in a sliver names nothing and "nothing equals nothing" proves
 * nothing.
 */
function looksCanvas(): Placed[] {
  const rows: readonly (readonly [VariantType, number, number])[] = [
    ['weather', 0, 0.18],
    ['countdown', 0.18, 0.14],
    ['homeassistant', 0.32, 0.2],
    ['calendar', 0.52, 0.48],
  ];
  const placed: Placed[] = [];
  for (const [type, y, h] of rows) {
    const values: readonly (string | undefined)[] = [undefined, ...VARIANTS[type].filter((v) => v !== '')];
    values.forEach((value, index) => {
      const config = { ...BASE_CONFIG[type], ...(value === undefined ? {} : { variant: value }) };
      placed.push({
        id: `${type}-${value ?? 'none'}`,
        type,
        x: index / values.length,
        y,
        w: 1 / values.length,
        h,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
    });
  }
  return placed;
}

/** The editor's canvas: one widget of every type that has looks, plus a note. */
function editorCanvas(): Placed[] {
  return [
    { id: 'clock', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, config: { variant: 'stacked' } },
    { id: 'weather', type: 'weather', x: 0.5, y: 0, w: 0.5, h: 0.2 },
    { id: 'countdown', type: 'countdown', x: 0, y: 0.2, w: 0.5, h: 0.2, config: { title: 'Holiday', target: '2027-08-01' } },
    { id: 'homeassistant', type: 'homeassistant', x: 0.5, y: 0.2, w: 0.5, h: 0.2 },
    { id: 'calendar', type: 'calendar', x: 0, y: 0.4, w: 1, h: 0.4 },
    { id: 'notes', type: 'notes', x: 0, y: 0.8, w: 1, h: 0.2, config: { text: 'Bins Tuesday' } },
  ];
}

function canvasOf(widgets: readonly Placed[]): void {
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: widgets.map((widget, index) => ({
        id: orientation === 'portrait' ? widget.id : `${widget.id}-l`,
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: index,
        ...(widget.config === undefined ? {} : { config: widget.config }),
      })),
      background: null,
    });
  }
}

function storedConfig(id: string): Record<string, unknown> {
  const row = readLayoutWidgets(wall.db, screenId, 'portrait').find((one) => one.id === id);
  if (row === undefined) throw new Error(`no ${id} on the portrait canvas`);
  return (row.config as Record<string, unknown> | null) ?? {};
}

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  equipHouse();
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/* ------------------------------------------------------------ EDITOR --- */

interface LookReading {
  readonly present: boolean;
  readonly labels: readonly string[];
  readonly pressed: readonly string[];
  readonly display: string;
  /** How many distinct rows the choices landed on. */
  readonly rows: number;
  /** How many buttons overlap another — a grid laid out wrong. */
  readonly overlaps: number;
}

async function readLook(page: Page): Promise<LookReading> {
  return page.evaluate(() => {
    const field = document.querySelector<HTMLElement>('.le-config [data-cfg-key="variant"]');
    if (field === null) return { present: false, labels: [], pressed: [], display: '', rows: 0, overlaps: 0 };
    const group = field.querySelector<HTMLElement>('[role="group"]');
    const buttons = Array.from(field.querySelectorAll<HTMLElement>('button'));
    const rects = buttons.map((b) => b.getBoundingClientRect());
    let overlaps = 0;
    rects.forEach((a, i) =>
      rects.forEach((b, j) => {
        if (j <= i) return;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 0.5 && down > 0.5) overlaps += 1;
      }),
    );
    return {
      present: true,
      labels: buttons.map((b) => b.textContent ?? ''),
      pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent ?? ''),
      display: group === null ? '' : getComputedStyle(group).display,
      rows: new Set(rects.map((r) => Math.round(r.top))).size,
      overlaps,
    };
  });
}

async function openStyle(page: Page, id: string): Promise<void> {
  await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
  await page.waitForSelector('.le-config', { timeout: 20_000 });
  await page.locator('.insp-tab', { hasText: 'Style' }).click();
  await page.waitForTimeout(150);
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function save(page: Page): Promise<void> {
  expect(await page.locator('#savebar button[data-action="save"]').isEnabled(), 'the Look wrote nothing').toBe(true);
  await Promise.all([
    page.waitForNavigation({ timeout: 20_000 }),
    page.click('#savebar button[data-action="save"]'),
  ]);
}

describe('the editor offers exactly each type’s looks', () => {
  it(
    'draws the list as a row up to three and a grid past it, and no Look where a type has none',
    async () => {
      canvasOf(editorCanvas());
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await openEditor(page);
        for (const type of Object.keys(VARIANTS) as VariantType[]) {
          await openStyle(page, type);
          const look = await readLook(page);
          const labels = VARIANT_LABELS[type] as Readonly<Record<string, string>>;
          const expected = VARIANTS[type].map((value) => labels[value]);
          expect(look.present, `${type} draws no Look`).toBe(true);
          expect(look.labels, `${type}'s Look`).toEqual(expected);
          // The stored value, or the default for a box that stores none.
          expect(look.pressed, `${type}'s pressed look`).toEqual([type === 'clock' ? 'Stacked' : expected[0]]);
          expect(look.overlaps, `${type}'s choices overlap`).toBe(0);
          if (expected.length > 3) {
            // A grid: laid out by the grid, and deeper than one row.
            expect(look.display, `${type}'s Look is not a grid`).toBe('grid');
            expect(look.rows, `${type}'s grid is one row deep`).toBeGreaterThan(1);
          } else {
            expect(look.display, `${type}'s Look is not a segmented row`).toBe('flex');
            expect(look.rows, `${type}'s row broke onto a second line`).toBe(1);
          }
        }
        await openStyle(page, 'notes');
        expect((await readLook(page)).present, 'a note has no looks and was offered some').toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'writes a chosen look as itself and the default as an absence, and hides nothing a look still uses',
    async () => {
      canvasOf(editorCanvas());
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await openEditor(page);

        /** The Content tab's controls for a box, by the key each is annotated with. */
        const contentKeys = async (id: string): Promise<string[]> => {
          await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
          await page.waitForSelector('.le-config', { timeout: 20_000 });
          await page.locator('.insp-tab', { hasText: 'Content' }).click();
          await page.waitForTimeout(150);
          return page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('.le-config > [data-cfg-key]')).map(
              (el) => el.dataset['cfgKey'] ?? '',
            ),
          );
        };
        const asStrip = await contentKeys('weather');
        expect(asStrip, 'the fixture offers no day count to keep').toContain('count');

        // A forecast's Look, through the grid.
        await openStyle(page, 'weather');
        await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Today' }).click();
        await save(page);
        expect(storedConfig('weather')).toEqual({ variant: 'today' });
        // It still draws the strip, so every control on it still does what it
        // did: the Content tab is the strip's, control for control.
        expect(await contentKeys('weather'), 'Today took a working control off the screen').toEqual(asStrip);
        // Range is a designed row (P5.1): its columns are the style's, so the
        // field ladder goes and the day count, which it reads, stays.
        await page.locator('.insp-tab', { hasText: 'Style' }).click();
        await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Range' }).click();
        await save(page);
        expect(storedConfig('weather')).toEqual({ variant: 'range' });
        expect(asStrip, 'the strip offers no field ladder to take away').toContain('fields');
        expect(await contentKeys('weather'), 'Range kept the ladder or lost the day count').toEqual(
          asStrip.filter((key) => key !== 'fields'),
        );
        await page.locator('.insp-tab', { hasText: 'Style' }).click();
        await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Strip' }).click();
        await save(page);
        expect(storedConfig('weather'), 'the default was written rather than left out').toEqual({});

        // The calendar's default has no name to write at all.
        await openStyle(page, 'calendar');
        await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Planner' }).click();
        await save(page);
        expect(storedConfig('calendar')).toEqual({ variant: 'planner' });
        await openStyle(page, 'calendar');
        await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: 'Standard' }).click();
        await save(page);
        expect(storedConfig('calendar'), 'Standard wrote something').toEqual({});
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'offers the clock’s Look on the ink lane, and a forecast’s narrowed to what a panel draws',
    async () => {
      const canvas = editorCanvas().map((widget) =>
        widget.id === 'weather' ? { ...widget, config: { variant: 'today' } } : widget,
      );
      canvasOf(canvas);
      // A panel following this wall, hung a quarter turn so it draws the
      // portrait canvas the editor opens on — `browser-clock-variants`' setup.
      await wall.post('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '90' });
      const panel = wall.db.prepare("SELECT id FROM screens WHERE kind = 'epaper' LIMIT 1").get() as
        | { id: string }
        | undefined;
      expect(panel?.id, 'no e-paper panel was created').toBeTruthy();
      await wall.post(`/admin/epaper/${panel!.id}/source`, { source: `follow:${screenId}` });

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await openEditor(page);
        const inkLane = async (id: string): Promise<{ look: number; notes: string; labels: string[]; pressed: string[]; hint: string }> => {
          await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
          await page.waitForSelector('.le-config', { timeout: 20_000 });
          const lane = page.locator('.insp-lane').nth(1);
          expect(await lane.isVisible(), 'no ink lane offered, so nothing to check').toBe(true);
          await lane.click();
          await page.waitForSelector('.insp-ink-head', { timeout: 20_000 });
          const look = await readLook(page);
          const read = {
            look: await page.locator('.le-config [data-cfg-key="variant"] [role="group"]').count(),
            notes: (await page.locator('.le-config .insp-ink-list').allTextContents()).join(' | '),
            labels: [...look.labels],
            pressed: [...look.pressed],
            hint: (await page.locator('.le-config p.hint[data-cfg-key="variant"]').allTextContents()).join(' | '),
          };
          await page.locator('.insp-lane').nth(0).click();
          return read;
        };

        // A forecast's Look is offered since P5.1, narrowed to what a panel is
        // offered: the strip, Today and Range, and no note calling it ignored.
        const weather = await inkLane('weather');
        expect(weather.look, 'a forecast’s Look is missing from the ink lane').toBe(1);
        expect(weather.labels).toEqual(['Strip', 'Today', 'Range']);
        expect(weather.pressed).toEqual(['Today']);
        expect(weather.notes).not.toContain('Look');
        expect(weather.hint).toBe('');

        // The clock's Look is honoured on one bit, so it is offered and no
        // note calls it ignored — the note is scoped to the types it is true of.
        const clock = await inkLane('clock');
        expect(clock.look, 'the clock’s Look is missing from the ink lane').toBe(1);
        expect(clock.notes).not.toContain('Look');

        // A wall wearing Colour: the panel draws it as its strip, so the lane
        // shows the strip pressed and says why, rather than pressing nothing.
        canvasOf(editorCanvas().map((widget) =>
          widget.id === 'weather' ? { ...widget, config: { variant: 'colour' } } : widget,
        ));
        await openEditor(page);
        const colour = await inkLane('weather');
        expect(colour.labels).toEqual(['Strip', 'Today', 'Range']);
        expect(colour.pressed).toEqual(['Strip']);
        expect(colour.hint).toBe('A panel draws the Colour look as its strip.');

        // A countdown's Look since P5.2: the three a panel draws, and no note
        // calling it ignored — and its words, which a panel may count in
        // differently from its wall. The picture and the celebration are the
        // wall's alone and are not offered here.
        const countdown = await inkLane('countdown');
        expect(countdown.look, 'a countdown’s Look is missing from the ink lane').toBe(1);
        expect(countdown.labels).toEqual(['Number', 'Tear-off page', 'Ticket']);
        expect(countdown.pressed).toEqual(['Number']);
        expect(countdown.notes).not.toContain('Look');
        await page.locator('.le-overlay .le-widget[data-id="countdown"]').click();
        await page.locator('.insp-lane').nth(1).click();
        await page.waitForSelector('.insp-ink-head', { timeout: 20_000 });
        const inkKeys = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.le-config [data-cfg-key]')).map((el) => el.dataset['cfgKey']),
        );
        expect(inkKeys).toContain('unitWords');
        expect(inkKeys).not.toContain('emoji');
        expect(inkKeys).not.toContain('celebrate');
        await page.locator('.insp-lane').nth(0).click();

        /*
         * And on the wall's own lane, a countdown's words, a grid of bundled
         * pictures and the celebration (P5.2), each written as an absence by
         * default. Here rather than in a test of its own because this file
         * signs in once a test and the auth limit is twenty requests a minute
         * per address — commit #297's lesson in `browser-editor`.
         */
        canvasOf(editorCanvas());
        await openEditor(page);
        const openContent = async (): Promise<void> => {
          await page.locator('.le-overlay .le-widget[data-id="countdown"]').click();
          await page.waitForSelector('.le-config', { timeout: 20_000 });
          await page.locator('.insp-tab', { hasText: 'Content' }).click();
          await page.waitForTimeout(150);
        };
        await openContent();
        const keys = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.le-config > [data-cfg-key]')).map((el) => el.dataset['cfgKey']),
        );
        expect(keys).toEqual(expect.arrayContaining(['unitWords', 'emoji', 'celebrate']));

        // The picture grid is the bundled set itself, each a touch target,
        // each an image that loads, and "None" pressed on a countdown with none.
        const grid = await page.evaluate(async () => {
          const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.le-emoji-grid button'));
          const imgs = buttons.map((b) => b.querySelector('img')).filter((i): i is HTMLImageElement => i !== null);
          await Promise.all(imgs.slice(0, 12).map((img) => img.decode().catch(() => undefined)));
          return {
            count: buttons.length,
            pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset['emoji']),
            shortest: Math.min(...buttons.map((b) => b.getBoundingClientRect().height)),
            loaded: imgs.slice(0, 12).every((img) => img.naturalWidth > 0),
            scrolls: (() => {
              const g = document.querySelector<HTMLElement>('.le-emoji-grid');
              return g === null ? false : g.scrollHeight > g.clientHeight;
            })(),
          };
        });
        expect(grid.count).toBe(1 + 155);
        expect(grid.pressed).toEqual(['']);
        expect(grid.shortest).toBeGreaterThanOrEqual(44);
        expect(grid.loaded, 'the pictures in the grid did not load').toBe(true);
        expect(grid.scrolls, 'the grid is laid out whole rather than scrolled').toBe(true);

        await page.locator('.le-config [data-cfg-key="unitWords"] button', { hasText: 'Sleeps' }).click();
        await page.locator('.le-emoji-grid button[data-emoji="christmas-tree"]').click();
        await page.locator('.le-config [data-cfg-key="celebrate"] input[type="checkbox"]').uncheck();
        await save(page);
        expect(storedConfig('countdown')).toEqual({
          title: 'Holiday',
          target: '2027-08-01',
          unitWords: 'sleeps',
          emoji: 'christmas-tree',
          celebrate: false,
        });

        // And back: each default is an absence, not a value written out.
        await openEditor(page);
        await openContent();
        expect(
          await page.locator('.le-emoji-grid button[aria-pressed="true"]').getAttribute('data-emoji'),
        ).toBe('christmas-tree');
        await page.locator('.le-config [data-cfg-key="unitWords"] button', { hasText: 'Days' }).click();
        await page.locator('.le-emoji-grid button[data-emoji=""]').click();
        await page.locator('.le-config [data-cfg-key="celebrate"] input[type="checkbox"]').check();
        await save(page);
        expect(storedConfig('countdown')).toEqual({ title: 'Holiday', target: '2027-08-01' });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

/* -------------------------------------------------------------- WALL --- */

/**
 * Everything drawn inside one box, as a comparable list: every element's tag,
 * class, own words, rectangle relative to the box and computed type. Relative
 * to the box so two boxes of one size at two positions compare; the box's own
 * position is the one thing allowed to differ.
 */
async function drawnBoxes(page: Page): Promise<Record<string, { readonly count: number; readonly lines: readonly string[] }>> {
  return page.evaluate(() => {
    const out: Record<string, { count: number; lines: string[] }> = {};
    const round = (n: number): number => Math.round(n * 10) / 10;
    for (const box of Array.from(document.querySelectorAll<HTMLElement>('#wall .canvas .fw[data-widget-id]'))) {
      const origin = box.getBoundingClientRect();
      const lines: string[] = [
        `box ${round(origin.width)}x${round(origin.height)} ${getComputedStyle(box).padding}`,
      ];
      const elements = Array.from(box.querySelectorAll<Element>('*'));
      for (const element of elements) {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const words = Array.from(element.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim();
        // A box that draws nothing (`display: none`, or an empty inline) has
        // no position: the engine reports the page's origin, which is a
        // different number in every box and says nothing about this one.
        const placed = r.width > 0 || r.height > 0;
        lines.push(
          [
            element.tagName.toLowerCase(),
            element.getAttribute('class') ?? '',
            words,
            placed ? round(r.left - origin.left) : 'unplaced',
            placed ? round(r.top - origin.top) : 'unplaced',
            round(r.width),
            round(r.height),
            style.fontSize,
            style.fontWeight,
            style.display,
            style.visibility,
          ].join(' · '),
        );
      }
      out[box.dataset['widgetId'] ?? ''] = { count: elements.length, lines };
    }
    return out;
  });
}

const SIZES: readonly { readonly width: number; readonly height: number; readonly orientation: Orientation }[] = [
  { width: 1080, height: 1920, orientation: 'portrait' },
  { width: 1920, height: 1080, orientation: 'landscape' },
];

describe('no undesigned look draws anything yet', () => {
  for (const size of SIZES) {
    it(
      `draws every type's default for every look it has not designed, at ${size.width}x${size.height}`,
      async () => {
        canvasOf(looksCanvas());
        const { page, close } = await loadWallSettled(link, size);
        try {
          const boxes = await drawnBoxes(page);
          const suffix = size.orientation === 'portrait' ? '' : '-l';
          for (const type of UNDRAWN) {
            const baseline = boxes[`${type}-none${suffix}`];
            expect(baseline, `${type} with no look was not drawn`).toBeDefined();
            // A box with nothing in it would make every comparison pass.
            expect(baseline!.count, `${type} with no look drew an empty box`).toBeGreaterThan(3);
            for (const value of VARIANTS[type].filter((v) => v !== '' && !DESIGNED.has(`${type}.${v}`))) {
              const drawn = boxes[`${type}-${value}${suffix}`];
              expect(drawn, `${type} with ${value} was not drawn`).toBeDefined();
              expect(drawn!.lines, `${type} with ${value} drew something its default does not`).toEqual(
                baseline!.lines,
              );
            }
          }
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }
});
