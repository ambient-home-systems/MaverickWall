/**
 * The per-widget style lane, measured (RFC 014 §4.1).
 *
 * A widget may carry its own colours, faces, weight, tracking and inset,
 * resolved by the server and written onto its box the way `applyTheme` writes
 * the household's theme onto the root. Five things have to be true on the
 * glass, and every one of them is asked of a real paired wall drawing the
 * shipped Classic seed with three ordinary family calendars on it:
 *
 *  1. **The contrast promise.** A widget that sets `--bg` and `--ink` draws
 *     its date numeral at 4.5:1 or better against *its* ground, read off the
 *     computed colours — the theme's own scaffold would land at 2.6:1 on that
 *     cream, which is the fault the RFC names and the reason the lane goes
 *     through `withTints` per widget. Reverting that re-derivation turns this
 *     red.
 *  2. **The roles survive.** On a measured wall every run in the restyled
 *     widget is still its role's cap height in arc-minutes — a lane changes
 *     how a widget looks and never how large its reader needs it.
 *  3. **One element down means one element.** A sibling widget's computed
 *     tokens are byte-identical with and without the lane.
 *  4. **No lane, no trace.** An unstyled wall's document carries nothing of
 *     the lane, and styling a widget and un-styling it again round-trips to
 *     the identical bytes.
 *  5. **The inspector.** "Inherit the wall's theme" off reveals the controls
 *     seeded with the theme's values, and the ink lane does not offer them.
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
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { STYLE_DERIVED, STYLE_LANE_TOKENS } from '../src/api/widget-style.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and settles a wall per case. */
const SLOW = 180_000;

const VIEWPORT = { width: 1080, height: 1920 } as const;

/** Cap height as a fraction of the em — `CAP_RATIO` in `orientation.ts`. */
const CAP_RATIO = 0.71;
/** The same whisker `wall-density.test.ts` allows for hundredth-of-a-pixel rounding. */
const ARCMIN_SLACK = 0.05;

/**
 * The agenda's runs, in arc-minutes of cap height — `wall-density.test.ts`'s
 * own transcription of `WALL_TYPE_CAPS`, by selector. The agenda is the
 * widget restyled here because it is the one carrying `.dr-num`, the numeral
 * the contrast promise is about.
 */
const AGENDA_ROLES: readonly { readonly selector: string; readonly arcmin: number }[] = [
  { selector: '.dr-ev-title', arcmin: 22 },
  { selector: '.dr-ev-time', arcmin: 12 },
  { selector: '.dr-num', arcmin: 16 },
  { selector: '.dr-dow', arcmin: 11 },
  { selector: '.dr-shift', arcmin: 11 },
  { selector: '.section-label', arcmin: 10 },
];

/**
 * The RFC's own case: a cream ground and a near-black ink on a widget of a
 * wall wearing Panels. `--panel` is set to the same cream because on Panels
 * the agenda draws itself as a card in `--panel`, and the numeral sits on the
 * card — which is exactly what "its computed ground" has to mean, and why the
 * assertion walks up to the first painted ancestor rather than assuming the
 * box.
 */
const LANE = { '--bg': '#FFF8E7', '--panel': '#FFF8E7', '--ink': '#2A2A2A' } as const;

let wall: Installation;
let link: string;
let screenId: string;
let agendaId: string;
let monthId: string;
let clockId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // The real `POST /admin/screens`, which is where a new wall is seeded with
  // Classic — so this measures the seed a household actually gets.
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
  const rows = readLayoutWidgets(wall.db, screenId, 'portrait');
  const agenda = rows.find((row) => row.type === 'calendar' && (row.config as { mode?: unknown })?.mode === 'list');
  const month = rows.find((row) => row.type === 'calendar' && (row.config as { mode?: unknown })?.mode !== 'list');
  const clock = rows.find((row) => row.type === 'clock');
  if (agenda === undefined || month === undefined || clock === undefined) {
    throw new Error('Classic seeded no agenda, month grid or clock');
  }
  agendaId = agenda.id;
  monthId = month.id;
  clockId = clock.id;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Style one widget the way the editor does — the real `POST /admin/layout`,
 * carrying the whole canvas as the editor posts it, with one widget's `style`
 * set or cleared. The schema is the boundary, so a lane the server refuses
 * fails here rather than being written around.
 */
async function styleWidget(id: string, style: Record<string, unknown> | undefined): Promise<void> {
  await styleWidgets({ [id]: style });
}

async function styleWidgets(lanes: Record<string, Record<string, unknown> | undefined>): Promise<void> {
  const rows = readLayoutWidgets(wall.db, screenId, 'portrait');
  const widgets = rows.map((row) => {
    const config = { ...((row.config as Record<string, unknown> | null) ?? {}) };
    if (row.id in lanes) {
      const style = lanes[row.id];
      if (style === undefined) delete config['style'];
      else config['style'] = style;
    }
    return {
      id: row.id, type: row.type, x: row.x, y: row.y, w: row.w, h: row.h, z: row.z,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  });
  const aspect = (wall.db.prepare('SELECT layout_aspect AS a FROM screens WHERE id = ?').get(screenId) as { a: number | null }).a;
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspect ?? 0.5625, widgets }),
  });
  expect(saved.status, `saving the canvas with ${Object.keys(lanes).join(', ')} restyled`).toBe(200);
}

/** The wall's own physical facts, or none — `wall-density.test.ts`'s helper. */
function measureScreen(preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, screenId);
}

function parseRgb(value: string): [number, number, number] | undefined {
  const hit = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
  if (hit === null) return undefined;
  if (hit[4] !== undefined && Number(hit[4]) === 0) return undefined;
  return [Number(hit[1]), Number(hit[2]), Number(hit[3])];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (rgb: [number, number, number]): number => {
    const ch = (raw: number): number => {
      const c = raw / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
  };
  const [la, lb] = [lum(a), lum(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The numeral's ink and the first painted ground behind it, as the browser computed them. */
async function numeralAndGround(page: Page, id: string): Promise<{ ink: string; ground: string; groundClass: string }> {
  return page.evaluate((widgetId) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    /*
     * A day that is not today: today's numeral is drawn in `--accent`, a
     * colour the household chose (and the contrast guidance in the editor
     * warns about), where every other day's is the scaffold ink — the one the
     * lane has to re-derive, and the one this promise is about.
     */
    const numeral = box?.querySelector<HTMLElement>('.day-row:not(.is-today) .dr-num');
    if (box === null || box === undefined || numeral === null || numeral === undefined) {
      throw new Error('no date numeral in the restyled widget');
    }
    const ink = getComputedStyle(numeral).color;
    for (let node: HTMLElement | null = numeral; node !== null; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== '' && bg !== 'transparent' && !/rgba\(\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg)) {
        return { ink, ground: bg, groundClass: node.className };
      }
    }
    throw new Error('nothing behind the numeral is painted at all');
  }, id);
}

/** Every custom property and inherited property a lane could move, on one box. */
const OBSERVED_TOKENS: readonly string[] = [
  ...STYLE_LANE_TOKENS,
  ...STYLE_DERIVED.map((entry) => entry.token),
  '--fw-inset',
];

async function boxTokens(page: Page, id: string): Promise<string> {
  return page.evaluate(
    ({ widgetId, tokens }) => {
      const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
      if (box === null) throw new Error(`no box for ${widgetId}`);
      const style = getComputedStyle(box);
      const out: Record<string, string> = {};
      for (const token of tokens) out[token] = style.getPropertyValue(token);
      out['font-weight'] = style.fontWeight;
      out['letter-spacing'] = style.letterSpacing;
      out['padding'] = style.padding;
      out['background-color'] = style.backgroundColor;
      return JSON.stringify(out);
    },
    { widgetId: id, tokens: OBSERVED_TOKENS },
  );
}

describe('a restyled widget, on the wall', () => {
  it(
    'draws its date numeral at 4.5:1 or better against its own ground',
    async () => {
      measureScreen(undefined);
      // The clock too, with the ground alone: its box has no card on Panels,
      // so the only thing that can put the cream behind its digits is the
      // lane painting the box it is set on — the half a lane's `--bg` would
      // otherwise be a colour nothing reads.
      await styleWidgets({ [agendaId]: { ...LANE }, [clockId]: { '--bg': LANE['--bg'] } });
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        const clockGround = await page.evaluate((widgetId) => {
          const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
          const digits = box?.querySelector<HTMLElement>('.clock');
          if (box == null || digits == null) throw new Error('no clock digits in the restyled clock');
          for (let node: HTMLElement | null = digits; node !== null; node = node.parentElement) {
            const bg = getComputedStyle(node).backgroundColor;
            if (bg !== '' && bg !== 'transparent' && !/rgba\(\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg)) {
              return { ground: bg, isBox: node === box };
            }
          }
          throw new Error('nothing behind the clock is painted');
        }, clockId);
        expect(clockGround.isBox, `the clock's ground is ${clockGround.ground}, painted somewhere other than its box`).toBe(true);
        expect(parseRgb(clockGround.ground)).toEqual([255, 248, 231]);

        const { ink, ground, groundClass } = await numeralAndGround(page, agendaId);
        const inkRgb = parseRgb(ink);
        const groundRgb = parseRgb(ground);
        expect(inkRgb, `the numeral's ink is ${ink}`).toBeDefined();
        expect(groundRgb, `the numeral's ground is ${ground}`).toBeDefined();
        // The ground is the lane's own cream — the box, or the agenda's card
        // on Panels, both painted from the lane — and never the theme's slate.
        expect(groundRgb, `the ground behind the numeral is ${ground} on ${groundClass}`).toEqual([255, 248, 231]);
        const ratio = contrast(inkRgb!, groundRgb!);
        expect(
          ratio,
          `the date numeral is ${ink} on ${ground}, which is ${ratio.toFixed(2)}:1 — ` +
            `the scaffold ink was not re-derived against this widget's own ground`,
        ).toBeGreaterThanOrEqual(4.5);
        // And it is a *derived* ink, not the widget's full ink: scaffolding
        // stays demoted on a restyled widget exactly as it is on the wall.
        expect(inkRgb).not.toEqual([42, 42, 42]);
      } finally {
        await close();
        await styleWidget(clockId, undefined);
      }
    },
    SLOW,
  );

  it(
    'keeps every run at its role’s angle on a measured wall',
    async () => {
      measureScreen('tv-32');
      await styleWidget(agendaId, { ...LANE, weight: 'medium', tracking: 'wide', inset: 2 });
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        const pxArcmin = Number(
          await page.evaluate(() => document.documentElement.style.getPropertyValue('--px-arcmin')),
        );
        expect(pxArcmin, 'the page derived no scale from a measured wall').toBeGreaterThan(0);
        const runs = await page.evaluate(
          ({ widgetId, roles }) => {
            const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
            if (box === null) throw new Error('no restyled box');
            const visible = (element: Element): boolean => {
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              return element.getBoundingClientRect().height > 0;
            };
            const out: { selector: string; fontPx: number; text: string }[] = [];
            for (const role of roles) {
              for (const node of Array.from(box.querySelectorAll<HTMLElement>(role))) {
                if (!visible(node) || (node.textContent ?? '').trim() === '') continue;
                out.push({ selector: role, fontPx: parseFloat(getComputedStyle(node).fontSize), text: (node.textContent ?? '').trim() });
              }
            }
            return out;
          },
          { widgetId: agendaId, roles: AGENDA_ROLES.map((role) => role.selector) },
        );
        expect(runs.length, 'no role-driven runs in the restyled agenda at all').toBeGreaterThan(3);
        expect(new Set(runs.map((run) => run.selector)).size, 'only one role measured').toBeGreaterThan(2);
        for (const run of runs) {
          const role = AGENDA_ROLES.find((candidate) => candidate.selector === run.selector)!;
          const arcmin = (run.fontPx * CAP_RATIO) / pxArcmin;
          expect(
            Math.abs(arcmin - role.arcmin),
            `${run.selector} "${run.text}" is drawn at ${run.fontPx.toFixed(2)}px, ${arcmin.toFixed(2)}' of cap ` +
              `height and not the ${role.arcmin}' its role is — the lane moved a size`,
          ).toBeLessThanOrEqual(ARCMIN_SLACK);
        }
      } finally {
        await close();
        measureScreen(undefined);
      }
    },
    SLOW,
  );

  it(
    'leaves a sibling widget’s computed tokens byte-identical',
    async () => {
      measureScreen(undefined);
      await styleWidget(agendaId, undefined);
      const before = await loadWallSettled(link, VIEWPORT);
      let plain: string;
      try {
        plain = await boxTokens(before.page, monthId);
      } finally {
        await before.close();
      }
      await styleWidget(agendaId, { ...LANE, weight: 'bold', tracking: 'tight', inset: 1 });
      const after = await loadWallSettled(link, VIEWPORT);
      try {
        const styledSibling = await boxTokens(after.page, monthId);
        expect(styledSibling).toBe(plain);
        // While the restyled box itself plainly moved — or the sibling
        // assertion would pass over a lane that reached nothing.
        const styled = await boxTokens(after.page, agendaId);
        expect(styled).not.toBe(plain);
        const parsed = JSON.parse(styled) as Record<string, string>;
        expect(parsed['font-weight']).toBe('700');
        // The browser substitutes `var(--s1)` on the way to a computed value,
        // so the property is asserted to be set and the padding it drives to
        // have moved, rather than the token's own spelling.
        expect(parsed['--fw-inset']).not.toBe('');
        expect(parsed['padding']).not.toBe((JSON.parse(plain) as Record<string, string>)['padding']);
      } finally {
        await after.close();
      }
    },
    SLOW,
  );
});

/** The wall's document, with the one field that moves between two polls removed. */
async function wallDocument(): Promise<string> {
  const response = await wall.call(`/admin/layout/preview.json?screen=${encodeURIComponent(screenId)}`);
  expect(response.status).toBe(200);
  const manifest = (await response.json()) as Record<string, unknown>;
  delete manifest['generatedAt'];
  return JSON.stringify(manifest);
}

describe('an unstyled wall', () => {
  it(
    'carries no trace of the lane, and styling then un-styling a widget round-trips to the same bytes',
    async () => {
      measureScreen(undefined);
      await styleWidget(agendaId, undefined);
      const plain = await wallDocument();
      expect(plain).not.toContain('styleTokens');
      expect(plain).not.toContain('StyleTokens');
      expect(plain).not.toContain('"style"');

      await styleWidget(agendaId, { ...LANE });
      const styled = await wallDocument();
      expect(styled).toContain('"styleTokens"');
      expect(styled).not.toBe(plain);

      await styleWidget(agendaId, undefined);
      expect(await wallDocument()).toBe(plain);
    },
    SLOW,
  );
});

describe('the inspector', () => {
  it(
    'reveals the lane’s controls seeded with the theme’s values, and the ink lane does not offer them',
    async () => {
      await styleWidget(agendaId, undefined);
      // A panel following this wall, so the ink lane is offered at all — hung
      // a quarter turn so it draws the *portrait* canvas the editor opens on;
      // a landscape panel would leave the lane saying "draws the landscape
      // layout" and building no controls for this test to prove absent.
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
        await page.locator(`.le-overlay .le-widget[data-id="${agendaId}"]`).click();
        await page.locator('.insp-tab').nth(1).click();
        await page.waitForSelector('.le-style', { timeout: 20_000 });

        // Inheriting, and no control on show — the switch is the whole section.
        const inherit = page.locator('.le-style .switch input[type=checkbox]');
        expect(await inherit.isChecked()).toBe(true);
        expect(await page.locator('.le-style input[type=color]').count()).toBe(0);

        await inherit.click();
        await page.waitForSelector('.le-style input[type=color]', { timeout: 20_000 });
        const seeded = await page.evaluate(() => {
          const out: Record<string, string> = {};
          for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('.le-style input[type=color]'))) {
            out[input.dataset['token'] ?? '?'] = input.value;
          }
          return out;
        });
        // Every colour the theme has, at the theme's own value — Panels, which
        // is what the harness pairs a wall on. A colour input reports lowercase.
        for (const [token, value] of Object.entries(BUILTIN_THEME_TOKENS.panels)) {
          expect(seeded[token], `${token} seeded from the theme`).toBe(value.toLowerCase());
        }
        expect(await page.locator('.le-style select[data-token="--disp"]').inputValue()).toBe('');
        // Weight, tracking, inset, and the shadow (P5.3) left on the theme's:
        // the lane can take a shadow away and never adds one.
        expect(await page.locator('.le-style .seg button.on').allTextContents()).toEqual(['Regular', 'Normal', 'Normal', 'The theme’s']);
        // Nothing was written by the switch alone: the stored truth is still no lane.
        expect(await page.locator('#savebar button[data-action="save"]').isDisabled()).toBe(true);
        // The theme builder's guidance is here too, and Panels reads fine.
        expect(await page.locator('.le-style-contrast').textContent()).toContain('readable');

        // Now the ink lane: the same widget, and no colour anywhere in it.
        const lane = page.locator('.insp-lane').nth(1);
        expect(await lane.isVisible(), 'no ink lane offered, so nothing to check').toBe(true);
        await lane.click();
        await page.waitForSelector('.insp-ink-head', { timeout: 20_000 });
        expect(await page.locator('.le-style').count()).toBe(0);
        expect(await page.locator('.le-config input[type=color]').count()).toBe(0);
        expect(await page.locator('.le-config select[data-token]').count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
