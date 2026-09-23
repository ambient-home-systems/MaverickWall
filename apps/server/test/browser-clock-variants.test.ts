/**
 * The clock's three designed variants, measured (RFC 014 §4.2).
 *
 * The Swiss month grid's shape, one widget along: a variant is a mode drawn on
 * purpose, and it ships with a measurement on a real paired wall. Every case
 * here is a real paired wall drawing the shipped Classic seed with three
 * ordinary family calendars on it, at 1080x1920 and 1920x1080, on a wall nobody
 * has measured *and* on one set to a 32" television read from 1.2 metres —
 * because the clock is sized by its box on the first and by its role on the
 * second, and a variant that only held under one of those would be a variant
 * that holds on half the walls this product draws.
 *
 *  1. **Plain is main.** Absent and spelled out, the plain clock draws the
 *     digits and the date at exactly the sizes and positions a clean worktree
 *     of `main` drew them (recorded at 38ace88, before the key existed). A
 *     variant that moved the clock every wall already has would be a
 *     regression wearing a feature's name.
 *  2. **Stacked keeps the design rule.** The digits are never more than 1.8x
 *     the agenda's own event title on the glass, measured against the title
 *     the same wall draws, at both sizes and on both walls; the weekday and
 *     the date sit on lines of their own under the digits, in the scaffold
 *     role's colour; and nothing overflows — read as `scrollWidth` against
 *     `clientWidth` on each line, because a block's rectangle is its parent's
 *     width whatever is inside it (CLAUDE.md records that trap).
 *  3. **Analogue is a picture at the box's short side.** The face fills 85% or
 *     more of the shorter side of the room its box has, holds no text at all —
 *     so it takes no type role and is nothing the tabular-figures walk can
 *     meet — and its two hands point where the wall's own clock says, read
 *     back out of the path data: the harness pins the server to `HARNESS_HOUR`,
 *     so the hour hand is at eleven and the minute hand a few degrees either
 *     side of twelve, and both are checked against the minute the page drew.
 *  4. **The editor.** The Look control leads the clock's Style tab, and on the
 *     ink lane too; choosing Analogue draws a face in the preview and takes
 *     away the time format it no longer has.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HARNESS_HOUR,
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
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const ZONE = 'Europe/London';

type Orientation = 'portrait' | 'landscape';

const SIZES: readonly { readonly width: number; readonly height: number; readonly orientation: Orientation }[] = [
  { width: 1080, height: 1920, orientation: 'portrait' },
  { width: 1920, height: 1080, orientation: 'landscape' },
];

/**
 * What the plain clock drew on a clean worktree of `main` at 38ace88, before
 * `variant` existed — the digits' `font-size`, and the digits' and the date's
 * rectangles as `[x, y, width, height]`, on the shipped Classic seed. Recorded
 * rather than derived, because the question is whether this change moved
 * them, and an expectation computed from this tree would agree with whatever
 * it drew. The unmeasured 1080x1920 digits are `AGENDA_BASELINE`'s 89.9 in
 * `wall-density.test.ts`, to more places.
 */
const MAIN_PLAIN: Readonly<Record<string, {
  readonly clockPx: number;
  readonly clock: readonly number[];
  readonly datePx: number;
  readonly date: readonly number[];
}>> = {
  'unmeasured 1080x1920': { clockPx: 89.856, clock: [13.86, 24.84, 577.08, 89.86], datePx: 25.92, date: [13.86, 118.16, 577.08, 29.8] },
  'unmeasured 1920x1080': { clockPx: 56.862, clock: [11.7, 19.53, 475.78, 56.86], datePx: 17.8198, date: [11.7, 78.77, 475.78, 20.48] },
  'tv-32 1080x1920': { clockPx: 52.79, clock: [7.92, 43.38, 588.95, 52.8], datePx: 25.92, date: [7.92, 99.63, 588.95, 29.8] },
  'tv-32 1920x1080': { clockPx: 52.83, clock: [7.94, 21.55, 483.31, 52.83], datePx: 17.8198, date: [7.94, 76.75, 483.31, 20.48] },
};

/** A whisker for hundredth-of-a-pixel rounding, and nothing more. */
const PX_SLACK = 0.02;

let wall: Installation;
let link: string;
let screenId: string;
const clockIds: Record<Orientation, string> = { portrait: '', landscape: '' };
/** The clock's box as Classic seeded it, so a resized case can be put back. */
const SEED_BOX: Record<Orientation, { w: number; h: number }> = { portrait: { w: 0, h: 0 }, landscape: { w: 0, h: 0 } };

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const clock = readLayoutWidgets(wall.db, screenId, orientation).find((row) => row.type === 'clock');
    if (clock === undefined) throw new Error(`Classic seeded no clock on the ${orientation} canvas`);
    clockIds[orientation] = clock.id;
    SEED_BOX[orientation] = { w: clock.w, h: clock.h };
  }
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Set the clock's variant the way the editor does — the real `POST
 * /admin/layout` with the whole canvas, so the schema is the boundary and a
 * value it refuses fails here rather than being written around. `undefined`
 * removes the key, which is what "plain" is stored as on the wall.
 */
async function setVariant(
  orientation: Orientation,
  variant: string | undefined,
  resize?: { readonly w: number; readonly h: number },
): Promise<void> {
  const rows = readLayoutWidgets(wall.db, screenId, orientation);
  const widgets = rows.map((row) => {
    const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
    const isClock = row.id === clockIds[orientation];
    if (isClock) {
      if (variant === undefined) delete config['variant'];
      else config['variant'] = variant;
    }
    const size = isClock ? (resize ?? SEED_BOX[orientation]) : { w: row.w, h: row.h };
    return {
      id: row.id, type: row.type, x: row.x, y: row.y, w: size.w, h: size.h, z: row.z,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  });
  const aspects = wall.db
    .prepare('SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?')
    .get(screenId) as { p: number; l: number };
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: screenId,
      orientation,
      mode: 'freeform',
      aspect: orientation === 'portrait' ? aspects.p : aspects.l,
      widgets,
    }),
  });
  expect(saved.status, `saving the ${orientation} canvas with the clock ${variant ?? 'plain'}`).toBe(200);
}

async function setBoth(variant: string | undefined): Promise<void> {
  await setVariant('portrait', variant);
  await setVariant('landscape', variant);
}

/** The wall's own physical facts, or none — `wall-density.test.ts`'s helper. */
function measureScreen(preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, screenId);
}

const WALLS: readonly (string | undefined)[] = [undefined, 'tv-32'];
const wallName = (preset: string | undefined): string => preset ?? 'unmeasured';

interface ClockReading {
  readonly box: readonly number[];
  readonly clockPx: number;
  readonly clock: readonly number[];
  readonly datePx: number;
  readonly date: readonly number[];
  readonly ledePx: number;
}

async function readPlain(page: Page): Promise<ClockReading> {
  return page.evaluate(() => {
    const round = (n: number): number => Math.round(n * 100) / 100;
    const rect = (element: Element): number[] => {
      const b = element.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map(round);
    };
    const box = document.querySelector<HTMLElement>('#wall .canvas .fw.fw-clock');
    const clock = box?.querySelector<HTMLElement>('.clock');
    const date = box?.querySelector<HTMLElement>('.today-date');
    const lede = document.querySelector<HTMLElement>('#wall .canvas .dr-ev-title');
    if (box == null || clock == null || date == null || lede == null) throw new Error('no plain clock, date or agenda title');
    return {
      box: rect(box),
      clockPx: parseFloat(getComputedStyle(clock).fontSize),
      clock: rect(clock),
      datePx: parseFloat(getComputedStyle(date).fontSize),
      date: rect(date),
      ledePx: parseFloat(getComputedStyle(lede).fontSize),
    };
  });
}

describe('plain is the clock every wall already draws', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      const key = `${wallName(preset)} ${size.width}x${size.height}`;
      it(
        `${key}: absent and "plain" both measure exactly as main did`,
        async () => {
          measureScreen(preset);
          const expected = MAIN_PLAIN[key]!;
          for (const variant of [undefined, 'plain']) {
            await setBoth(variant);
            const { page, close } = await loadWallSettled(link, size);
            try {
              const got = await readPlain(page);
              const where = `${key}, variant ${variant ?? 'absent'}`;
              expect(Math.abs(got.clockPx - expected.clockPx), `${where}: digits at ${got.clockPx}px`).toBeLessThanOrEqual(PX_SLACK);
              expect(Math.abs(got.datePx - expected.datePx), `${where}: date at ${got.datePx}px`).toBeLessThanOrEqual(PX_SLACK);
              for (let i = 0; i < 4; i++) {
                expect(Math.abs(got.clock[i]! - expected.clock[i]!), `${where}: the digits sit at ${got.clock.join(',')}`).toBeLessThanOrEqual(PX_SLACK);
                expect(Math.abs(got.date[i]! - expected.date[i]!), `${where}: the date sits at ${got.date.join(',')}`).toBeLessThanOrEqual(PX_SLACK);
              }
            } finally {
              await close();
            }
          }
        },
        SLOW,
      );
    }
  }
});

interface StackedReading {
  readonly timePx: number;
  readonly ledePx: number;
  readonly lines: readonly { readonly cls: string; readonly text: string; readonly top: number; readonly bottom: number; readonly scrollWidth: number; readonly clientWidth: number; readonly color: string }[];
  readonly boxScrollHeight: number;
  readonly boxClientHeight: number;
  readonly boxBottom: number;
  readonly scaffold: string;
}

async function readStacked(page: Page): Promise<StackedReading> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('#wall .canvas .fw.fw-clock');
    const body = box?.querySelector<HTMLElement>('.fw-clock.clk-stacked');
    const lede = document.querySelector<HTMLElement>('#wall .canvas .dr-ev-title');
    if (box == null || body == null || lede == null) throw new Error('no stacked clock or agenda title');
    const lines = ['clock', 'clk-day', 'clk-date'].map((cls) => {
      const node = body.querySelector<HTMLElement>(`.${cls}`);
      if (node === null) throw new Error(`the stacked clock has no .${cls}`);
      const r = node.getBoundingClientRect();
      return {
        cls,
        text: (node.textContent ?? '').trim(),
        top: r.top,
        bottom: r.bottom,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        color: getComputedStyle(node).color,
      };
    });
    // The scaffold ink as this box resolves it, through a probe, because a
    // custom property's computed value is its token stream, not a colour.
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink-scaffold)';
    body.appendChild(probe);
    const scaffold = getComputedStyle(probe).color;
    probe.remove();
    return {
      timePx: parseFloat(getComputedStyle(body.querySelector<HTMLElement>('.clock')!).fontSize),
      ledePx: parseFloat(getComputedStyle(lede).fontSize),
      lines,
      boxScrollHeight: box.scrollHeight,
      boxClientHeight: box.clientHeight,
      // The content box's foot: the box less its bottom padding.
      boxBottom: box.getBoundingClientRect().bottom - parseFloat(getComputedStyle(box).paddingBottom),
      scaffold,
    };
  });
}

describe('stacked: the time over the date', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      const key = `${wallName(preset)} ${size.width}x${size.height}`;
      it(
        `${key}: the digits are at most 1.8x the lede, each line its own, and nothing overflows`,
        async () => {
          measureScreen(preset);
          await setBoth('stacked');
          const { page, close } = await loadWallSettled(link, size);
          try {
            const got = await readStacked(page);
            const ratio = got.timePx / got.ledePx;
            expect(
              ratio,
              `${key}: the stacked digits are ${got.timePx}px against a ${got.ledePx}px agenda title — ` +
                `${ratio.toFixed(3)}x, over the 1.8x a clock may be`,
            ).toBeLessThanOrEqual(1.8 + 1e-3);
            const [time, day, date] = got.lines;
            // Each on a line of its own, in reading order.
            expect(day!.top, `${key}: the weekday is not under the digits`).toBeGreaterThanOrEqual(time!.bottom - 1);
            expect(date!.top, `${key}: the date is not under the weekday`).toBeGreaterThanOrEqual(day!.bottom - 1);
            expect(day!.text.length).toBeGreaterThan(0);
            expect(date!.text).toMatch(/^\d{1,2} [A-Za-z]+$/);
            // In the scaffold role's ink, and the digits not.
            expect(day!.color, `${key}: the weekday is not scaffold ink`).toBe(got.scaffold);
            expect(date!.color, `${key}: the date is not scaffold ink`).toBe(got.scaffold);
            expect(time!.color).not.toBe(got.scaffold);
            for (const line of got.lines) {
              expect(
                line.scrollWidth,
                `${key}: .${line.cls} "${line.text}" is ${line.scrollWidth}px of content in ${line.clientWidth}px — clipped`,
              ).toBeLessThanOrEqual(line.clientWidth);
            }
            expect(
              got.boxScrollHeight,
              `${key}: the stacked clock is ${got.boxScrollHeight}px tall in a ${got.boxClientHeight}px box`,
            ).toBeLessThanOrEqual(got.boxClientHeight);
          } finally {
            await close();
          }
        },
        SLOW,
      );
    }
  }
});

/**
 * A clock dragged small, where the stacked form's own two rules bind.
 *
 * On the Classic seed at both sizes the digits are held by the 1.8x cap (or by
 * the clock role) well before their share of the box's height, and the date
 * lines by their role well before the box's width — so neither rule can be
 * seen there, and a rule nothing can contradict is not a fix. A box 120px
 * tall and one 130px wide are where they take over: the first is where the
 * digits' 44% share (plain's is 52) is what leaves room for two date lines,
 * and the second is where the date lines' width term, net of the box's
 * padding, is what stops "23 SEPTEMBER" clipping.
 */
const SMALL_BOXES: readonly { readonly name: string; readonly w: number; readonly h: number }[] = [
  { name: 'short', w: 0.56, h: 120 / 1920 },
  { name: 'short and narrow', w: 130 / 1080, h: 120 / 1920 },
];

describe('stacked, dragged small', () => {
  for (const box of SMALL_BOXES) {
    it(
      `unmeasured 1080x1920, ${box.name}: still fits, every line`,
      async () => {
        measureScreen(undefined);
        await setVariant('portrait', 'stacked', box);
        const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
        try {
          const got = await readStacked(page);
          for (const line of got.lines) {
            expect(
              line.scrollWidth,
              `${box.name}: .${line.cls} "${line.text}" is ${line.scrollWidth}px of content in ${line.clientWidth}px — clipped`,
            ).toBeLessThanOrEqual(line.clientWidth);
          }
          expect(
            got.boxScrollHeight,
            `${box.name}: the stacked clock is ${got.boxScrollHeight}px tall in a ${got.boxClientHeight}px box`,
          ).toBeLessThanOrEqual(got.boxClientHeight);
          // And it is still three lines, in order — a fit bought by dropping
          // one would pass the two checks above.
          const [time, day, date] = got.lines;
          expect(day!.top).toBeGreaterThanOrEqual(time!.bottom - 1);
          expect(date!.top).toBeGreaterThanOrEqual(day!.bottom - 1);
          expect(date!.bottom, `${box.name}: the date line is below the box`).toBeLessThanOrEqual(got.boxBottom + 0.5);
        } finally {
          await close();
          await setVariant('portrait', undefined);
        }
      },
      SLOW,
    );
  }
});

interface AnalogueReading {
  readonly face: readonly number[];
  readonly contentShort: number;
  readonly text: string;
  readonly hour: string;
  readonly minute: string;
  readonly strokes: readonly string[];
  readonly boxScrollHeight: number;
  readonly boxClientHeight: number;
  readonly boxScrollWidth: number;
  readonly boxClientWidth: number;
}

async function readAnalogue(page: Page): Promise<AnalogueReading> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('#wall .canvas .fw.fw-clock');
    const dial = box?.querySelector<SVGPathElement>('.clk-analogue .clk-dial');
    const hour = box?.querySelector<SVGPathElement>('.clk-hand-hour');
    const minute = box?.querySelector<SVGPathElement>('.clk-hand-minute');
    if (box == null || dial == null || hour == null || minute == null) throw new Error('no analogue face');
    const style = getComputedStyle(box);
    const contentW = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const contentH = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const r = dial.getBoundingClientRect();
    return {
      face: [r.width, r.height],
      contentShort: Math.min(contentW, contentH),
      text: (box.textContent ?? '').trim(),
      hour: hour.getAttribute('d') ?? '',
      minute: minute.getAttribute('d') ?? '',
      strokes: Array.from(box.querySelectorAll('path')).map((path) => getComputedStyle(path).stroke),
      boxScrollHeight: box.scrollHeight,
      boxClientHeight: box.clientHeight,
      boxScrollWidth: box.scrollWidth,
      boxClientWidth: box.clientWidth,
    };
  });
}

/** Where a hand points, in degrees clockwise from twelve: its path starts at its tip. */
function pointsAt(d: string): number {
  const hit = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (hit === null) throw new Error(`a hand path that does not start at a point: ${d}`);
  const degrees = (Math.atan2(Number(hit[1]) - 12, 12 - Number(hit[2])) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** The hour and minute the harness's clock reads in the household's zone. */
function harnessReading(at: number): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(at));
  const find = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 'NaN');
  return { hour: find('hour') % 24, minute: find('minute') };
}

/** How far apart two angles are, the short way round. */
const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('analogue: a face at the box’s short side', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      const key = `${wallName(preset)} ${size.width}x${size.height}`;
      it(
        `${key}: fills the short side, holds no text, and points its hands at the wall’s own time`,
        async () => {
          measureScreen(preset);
          await setBoth('analogue');
          const before = harnessReading(wall.now());
          const { page, close } = await loadWallSettled(link, size);
          try {
            const got = await readAnalogue(page);
            const after = harnessReading(wall.now());
            const [faceW, faceH] = got.face as [number, number];
            expect(Math.abs(faceW - faceH), `${key}: the face is ${faceW}x${faceH}, not round`).toBeLessThanOrEqual(1);
            expect(
              faceW / got.contentShort,
              `${key}: the face is ${faceW.toFixed(1)}px across a ${got.contentShort.toFixed(1)}px short side`,
            ).toBeGreaterThanOrEqual(0.85);
            expect(faceW, `${key}: the face spills out of its box`).toBeLessThanOrEqual(got.contentShort + 1);
            // A picture, not type: nothing the tabular-figures walk could meet.
            expect(got.text, `${key}: the face carries text`).toBe('');
            // Filled, never stroked.
            for (const stroke of got.strokes) expect(stroke).toBe('none');
            expect(got.boxScrollHeight).toBeLessThanOrEqual(got.boxClientHeight);
            expect(got.boxScrollWidth).toBeLessThanOrEqual(got.boxClientWidth);

            /*
             * The hands, read back out of the path data. The harness pins the
             * server to `HARNESS_HOUR` and lets it run on at the ordinary rate,
             * and the wall takes its clock from the server's `x-server-time`,
             * so the face was drawn at eleven and some minutes — whichever
             * minute the page drew in, between the two readings taken either
             * side of it.
             */
            expect(before.hour, 'the harness is not at HARNESS_HOUR — the file ran past the hour').toBe(HARNESS_HOUR);
            const minute = pointsAt(got.minute);
            const hour = pointsAt(got.hour);
            const candidates: number[] = [];
            for (let m = before.minute; m <= after.minute; m++) candidates.push(m);
            const drawn = candidates.find((m) => apart(minute, m * 6) < 0.5);
            expect(
              drawn,
              `${key}: the minute hand points at ${minute.toFixed(2)}°, where ${candidates
                .map((m) => `${HARNESS_HOUR}:${String(m).padStart(2, '0')} is ${m * 6}°`)
                .join(' or ')}`,
            ).toBeDefined();
            // And the hour hand agrees with the same reading: eleven, plus half
            // a degree a minute.
            const expectedHour = (HARNESS_HOUR % 12) * 30 + drawn! * 0.5;
            expect(
              apart(hour, expectedHour),
              `${key}: the hour hand points at ${hour.toFixed(2)}°, where ${HARNESS_HOUR}:${String(drawn).padStart(2, '0')} is ${expectedHour}°`,
            ).toBeLessThan(0.5);
          } finally {
            await close();
          }
        },
        SLOW,
      );
    }
  }
});

describe('the editor', () => {
  it(
    'leads the clock’s Style tab with the Look, draws a face when it is chosen, and offers it on the ink lane',
    async () => {
      measureScreen(undefined);
      await setBoth(undefined);
      // A panel following this wall, hung a quarter turn so it draws the
      // portrait canvas the editor opens on — `browser-widget-style`'s setup.
      await wall.post('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '90' });
      const panel = wall.db.prepare("SELECT id FROM screens WHERE kind = 'epaper' LIMIT 1").get() as { id: string } | undefined;
      expect(panel?.id, 'no e-paper panel was created').toBeTruthy();
      await wall.post(`/admin/epaper/${panel!.id}/source`, { source: `follow:${screenId}` });

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await page.locator(`.le-overlay .le-widget[data-id="${clockIds.portrait}"]`).click();

        // Content first: a plain clock offers its time format and its date.
        await page.waitForSelector('.le-config [data-cfg-key="clockFormat"]', { timeout: 20_000 });
        expect(await page.locator('.le-config [data-cfg-key="showDate"]').count()).toBe(1);

        await page.locator('.insp-tab').nth(1).click();
        await page.waitForSelector('.le-config [data-cfg-key="variant"]', { timeout: 20_000 });
        const first = await page.evaluate(() => {
          const panelEl = document.querySelector('.le-config');
          const child = panelEl?.firstElementChild as HTMLElement | null | undefined;
          return child?.dataset['cfgKey'] ?? child?.className ?? '';
        });
        expect(first, 'the Look is not the first thing on the Style tab').toBe('variant');
        const look = page.locator('.le-config [data-cfg-key="variant"] .seg button');
        expect(await look.allTextContents()).toEqual(['Plain', 'Stacked', 'Analogue']);
        expect(await page.locator('.le-config [data-cfg-key="variant"] .seg button.on').textContent()).toBe('Plain');

        await look.nth(2).click();
        // The preview is the wall's own renderer, so the face is drawn there.
        await page.waitForFunction(
          () => {
            const root = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
            return root?.querySelector('.clk-analogue .clk-face') != null;
          },
          undefined,
          { timeout: 20_000 },
        );
        expect(await page.locator('#savebar button[data-action="save"]').isDisabled()).toBe(false);
        // A face has no digits to format and no date line to switch off.
        await page.locator('.insp-tab').nth(0).click();
        await page.waitForSelector('.le-config', { timeout: 20_000 });
        expect(await page.locator('.le-config [data-cfg-key="clockFormat"]').count()).toBe(0);
        expect(await page.locator('.le-config [data-cfg-key="showDate"]').count()).toBe(0);

        // The ink lane: the panel draws every variant, so the Look is offered there too.
        const lane = page.locator('.insp-lane').nth(1);
        expect(await lane.isVisible(), 'no ink lane offered, so nothing to check').toBe(true);
        await lane.click();
        await page.waitForSelector('.insp-ink-head', { timeout: 20_000 });
        const inkLook = page.locator('.le-config [data-cfg-key="variant"] .seg button');
        expect(await inkLook.allTextContents()).toEqual(['Plain', 'Stacked', 'Analogue']);
        // Effective: the panel follows the wall, which is now analogue.
        expect(await page.locator('.le-config [data-cfg-key="variant"] .seg button.on').textContent()).toBe('Analogue');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
