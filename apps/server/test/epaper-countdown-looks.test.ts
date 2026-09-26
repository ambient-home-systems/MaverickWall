import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';

/**
 * A countdown on one bit, in the looks a panel draws (plan item P5.2), decoded.
 *
 * `epaper-ink.test.ts` proves the tables — `variant` and `unitWords` move ink,
 * the picture and the confetti move none. What it cannot say is the half that
 * matters to a panel already hanging: **a countdown with none of the new keys
 * is the frame it always was, to the byte**, on every day but its own. So the
 * number's frames are pinned to hashes rendered **on a clean worktree of
 * `main` at 4ed99e0**, the commit this landed on, before any of these keys
 * existed — never from this tree against itself, which would agree with
 * whatever it drew. Run with `PRINT_HASHES=1` to print them.
 *
 * The day itself is the one frame that moves, deliberately: the plan has every
 * look say "Today!" on the day, and the number said "Today". That frame is
 * pinned too, and asserted to *differ* from main's, so the change is a fact a
 * test states rather than a drift nobody noticed.
 *
 * **`EPAPER_RENDERER_VERSION` did not move for it, and that is a trade, stated.**
 * A bump costs every paired panel a full re-download at the upgrade. Not
 * bumping costs one panel whose countdown is *on its day* at the moment of the
 * upgrade a frame reading "Today" rather than "Today!" until midnight, when the
 * frame's civil-date bucket rolls its ETag anyway. The first is paid by every
 * battery panel in the world for a word on one day; the second by almost
 * nobody, for one afternoon.
 *
 * Then the page and the ticket, read back out of the frame rather than trusted:
 * the page's binder is a solid band with two holes knocked through it, the
 * ticket's board is one filled tile per digit, each look keeps every lit pixel
 * inside its own box, and a short box gives up parts rather than spilling.
 */

const TIMEZONE = 'Europe/London';
/** 11:00 in London on the fixture's day, 23 September 2026. */
const AT = Date.UTC(2026, 8, 23, 10, 0, 0);

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 23; d <= 27; d++) {
    days.push({ date: `2026-09-${d}`, shifts: [], events: [] } as unknown as ManifestDay);
  }
  return {
    timezone: TIMEZONE,
    generatedAt: AT,
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [],
    panels: {},
  } as unknown as Manifest;
}

const M = manifest();
const MODEL = buildEpaperModel(M);

interface Case {
  readonly panel: { readonly width: number; readonly height: number };
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** A whole 7.5" panel, a narrow column on a 13.3" one, and a strip on a portrait 7.5". */
const CASES: Readonly<Record<string, Case>> = {
  '800x480 whole': { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 1, h: 1 } },
  '1872x1404 column': { panel: { width: 1872, height: 1404 }, box: { x: 0.05, y: 0.1, w: 0.3, h: 0.25 } },
  '480x800 strip': { panel: { width: 480, height: 800 }, box: { x: 0, y: 0, w: 1, h: 0.2 } },
};

/** Twelve days to go, one, one ago, three ago and a year off — each with and without a label. */
const NUMBER_CONFIGS: Readonly<Record<string, Record<string, unknown>>> = {
  'twelve days': { target: '2026-10-05' },
  'one day': { target: '2026-09-24' },
  'a day ago': { target: '2026-09-22' },
  'three days ago': { target: '2026-09-20' },
  'a year off': { target: '2027-09-23' },
  labelled: { target: '2026-10-05', title: 'Summer holiday' },
  'labelled, titled': { target: '2026-10-05', title: 'Summer holiday', showTitle: true },
  'no date': { title: 'Summer holiday' },
};

const TODAY: Record<string, unknown> = { target: '2026-09-23', title: 'Summer holiday' };

function render(config: Record<string, unknown>, which: Case): Framebuffer {
  const widget: PlacedEpaperWidget = { type: 'countdown', ...which.box, z: 0, config };
  return renderFreeformEpaper(MODEL, M, [widget], which.panel);
}

function bits(fb: Framebuffer, which: Case): string {
  let out = '';
  for (let y = 0; y < which.panel.height; y++) {
    for (let x = 0; x < which.panel.width; x++) out += fb.get(x, y) ? '1' : '0';
  }
  return out;
}

const frame = (config: Record<string, unknown>, which: Case): string => bits(render(config, which), which);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Rendered on a clean worktree of `main` at 4ed99e0 — see the file's
 * docstring. `today` is main's "Today", which this tree changes on purpose.
 */
const MAIN_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '800x480 whole': {
    'twelve days': 'ada51bc2791bd8fc95b3938cc9a5a863d9f0e7979cffb7fae9eee4b756fa36f6',
    'one day': 'f4f070dcd2f984e05d363a07fe928e402f9b523c5c21aebfd5590c508b147b2e',
    'a day ago': '670571f212c24781385fc681cb4f37fe3fb8f7530ee6ea63517b1a3de42d192c',
    'three days ago': '165c71cd8f31d5b0d624e9ddc73078e549dc3264ef468c56b020a28aeee248f4',
    'a year off': '6138241ef2cffc2041cf06d56874b6eb6581c16453a9007ffa4abf46897bf3c6',
    labelled: 'cd8cbf7386ecd3293273d3a6bcd7a87c4e9787476150bc3b16169d5e95e797d0',
    'labelled, titled': '8050273acee518753eab485e1a7a8975d3ec5c89d8d1f3655ff77e6caa86e960',
    'no date': '478746ba057fde24b33e7e846475c5b59411b11859ed09c4bcda0e1dd673b17b',
    today: '4d04520e4dc3ad16590be593bfbd912d75af7b66337ad01656e93f167d6eaa0b',
  },
  '1872x1404 column': {
    'twelve days': 'b3bb1848135af511e3f5693911de0ecc96037652aa9f52f9e5a5b9e8d9a37d4a',
    'one day': '3bd04895ab4a403df9b54035272b8904e665a29b89187fa9129bd8701df79fe4',
    'a day ago': '599721ea9b4fab30643bea51c23189806d0c095fffc4dfbc101dcf102f6afc49',
    'three days ago': '6b6e42e4fd7ea937a2ca44cc73f99e1dbcbb91c3bc58591ddcb6568fcad47195',
    'a year off': '88846166a10c13ef257b07b011af0cd39f3351e5efa23d3af07e489ea31ff0f1',
    labelled: '52f042bf4b1e7799cafad0caa4bc6ebe14c6ed78b87bfa280d3627b550b6c221',
    'labelled, titled': '2fc0391946f89ff02cbe978c6790cf9b36f2af195a0c88603c1a9d90366ddb3c',
    'no date': '0255c99bc05d7e238a0cc50689b9749c20a7b9013d93eb4361afc4d093218aee',
    today: '15d00cead1bd74708f016543f626620cf0f3ad59ff8d1ea40e57ea681732854d',
  },
  '480x800 strip': {
    'twelve days': '314f367c2cebb3c981fd24c172b6f4a89b088ab67d2b47f743bb40e8bca5d1e2',
    'one day': '7e1c577484dc697168638644627083be961209c7d47632b56e45839b4803db0c',
    'a day ago': 'e4cd0b1276706dbca59e9f3215ecb68ecc097eb15d1958ae400ffbfb36e374fc',
    'three days ago': '4039483bafc66afdb97dad45e1f35777616123b78cacd4ec74025b7b9196126c',
    'a year off': '820d53d2e2405a50a65602a2259bc5f5f088d56790016f6f793cfc74629e6b96',
    labelled: '5d211411010a243f9a9a24956d8e39a9b8dbcce3ef9cf3007122e9cd5231a477',
    'labelled, titled': '7b9b1a27e14e1b386017bbe47a9309940786b7ead5a8de3c94b4b1b38ce5585b',
    'no date': '62a1cc29abedb1074f4f17f26d06196662b2a61b34046f8ce5098bfecd54ea53',
    today: 'f75fdc4b569c026c2ef503cf3ad335c38f25bb2ca3497e12c9f530e26a14de30',
  },
};

if (process.env['PRINT_HASHES'] === '1') {
  const out: Record<string, Record<string, string>> = {};
  for (const [name, which] of Object.entries(CASES)) {
    out[name] = {};
    for (const [label, config] of Object.entries(NUMBER_CONFIGS)) out[name]![label] = sha(frame(config, which));
    out[name]!['today'] = sha(frame(TODAY, which));
  }
  console.log(JSON.stringify(out, null, 2));
}

describe('a countdown with no new keys is the frame a panel always drew', () => {
  for (const [name, which] of Object.entries(CASES)) {
    for (const [label, config] of Object.entries(NUMBER_CONFIGS)) {
      it(`${name}, ${label}: absent and "number" both draw main's bytes`, () => {
        const expected = MAIN_HASHES[name]?.[label];
        expect(expected, 'no hash pinned from main').toBeDefined();
        expect(sha(frame(config, which))).toBe(expected);
        expect(sha(frame({ ...config, variant: 'number' }, which))).toBe(expected);
        // Days are the words a countdown always drew, spelled out or not.
        expect(sha(frame({ ...config, unitWords: 'days' }, which))).toBe(expected);
      });
    }

    it(`${name}: draws "Today!" on the day, where main drew "Today" — the one frame that moves`, () => {
      const today = sha(frame(TODAY, which));
      expect(MAIN_HASHES[name]?.['today'], 'no hash pinned from main').toBeDefined();
      expect(today).not.toBe(MAIN_HASHES[name]?.['today']);
    });
  }
});

describe('what a panel draws of the new keys', () => {
  const whole = CASES['800x480 whole']!;

  it('counts in sleeps before the day, and in days once it has passed', () => {
    const ahead = { target: '2026-10-05', title: 'Christmas' };
    expect(frame({ ...ahead, unitWords: 'sleeps' }, whole)).not.toBe(frame(ahead, whole));
    // "Sleeps count forward only" — three days ago is three days ago either way.
    const passed = { target: '2026-09-20', title: 'Christmas' };
    expect(frame({ ...passed, unitWords: 'sleeps' }, whole)).toBe(frame(passed, whole));
    // …on every look that draws the words.
    for (const variant of ['page', 'ticket']) {
      expect(frame({ ...ahead, variant, unitWords: 'sleeps' }, whole), variant).not.toBe(
        frame({ ...ahead, variant }, whole),
      );
    }
  });

  it('draws no picture and throws no confetti, on the day or before it, on any look', () => {
    for (const variant of ['number', 'page', 'ticket']) {
      for (const base of [TODAY, { target: '2026-10-05', title: 'Christmas' }]) {
        const plain = frame({ ...base, variant }, whole);
        expect(frame({ ...base, variant, emoji: 'christmas-tree' }, whole), `${variant} with a picture`).toBe(plain);
        expect(frame({ ...base, variant, celebrate: false }, whole), `${variant} without the celebration`).toBe(plain);
      }
    }
  });

  it('draws the page, the ticket, the bar and the month as looks of their own, and the occasion as the number', () => {
    const base = { target: '2026-10-05', title: 'Christmas', from: '2026-09-01' };
    const number = frame(base, whole);
    const own = ['page', 'ticket', 'progress', 'month'].map((variant) => frame({ ...base, variant }, whole));
    for (const drawn of own) expect(drawn).not.toBe(number);
    expect(new Set(own).size, 'two looks drew one frame').toBe(own.length);
    // The occasion is colour, a picture and a moving scene — three things one
    // still bit has none of — so it is the number, whichever occasion.
    for (const occasion of ['christmas', 'new-year', 'custom']) {
      expect(frame({ ...base, variant: 'occasion', occasion }, whole), occasion).toBe(number);
    }
  });
});

/** Every lit pixel, as the bounding box it makes. */
function inkBounds(fb: Framebuffer, which: Case): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let y = 0; y < which.panel.height; y++) {
    for (let x = 0; x < which.panel.width; x++) {
      if (!fb.get(x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom };
}

/** The box the widget was placed in, in panel pixels, rounded as `renderFreeformEpaper` rounds it. */
function placed(which: Case): { left: number; top: number; right: number; bottom: number } {
  const left = Math.round(which.box.x * which.panel.width);
  const top = Math.round(which.box.y * which.panel.height);
  return {
    left,
    top,
    right: left + Math.round(which.box.w * which.panel.width) - 1,
    bottom: top + Math.round(which.box.h * which.panel.height) - 1,
  };
}

/** How many separate runs of lit pixels a row has between two columns. */
function litRuns(fb: Framebuffer, y: number, from: number, to: number): number {
  let runs = 0;
  let inRun = false;
  for (let x = from; x <= to; x++) {
    const lit = fb.get(x, y);
    if (lit && !inRun) runs += 1;
    inRun = lit;
  }
  return runs;
}

/** How many pixels of a row are lit between two columns. */
function litCount(fb: Framebuffer, y: number, from: number, to: number): number {
  let lit = 0;
  for (let x = from; x <= to; x++) if (fb.get(x, y)) lit += 1;
  return lit;
}

describe('the page and the ticket, read back out of the frame', () => {
  const lookCases = Object.entries(CASES);
  const DAYS = ['2026-10-05', '2026-09-23', '2026-09-20', '2027-09-23'];

  for (const variant of ['page', 'ticket']) {
    for (const [name, which] of lookCases) {
      it(`${variant}, ${name}: keeps every lit pixel inside its box, on every kind of day`, () => {
        const box = placed(which);
        for (const target of DAYS) {
          const ink = inkBounds(render({ variant, target, title: 'Summer holiday' }, which), which);
          expect(ink.left, `${target}: ink left of the box`).toBeGreaterThanOrEqual(box.left);
          expect(ink.top, `${target}: ink above the box`).toBeGreaterThanOrEqual(box.top);
          expect(ink.right, `${target}: ink right of the box`).toBeLessThanOrEqual(box.right);
          expect(ink.bottom, `${target}: ink below the box`).toBeLessThanOrEqual(box.bottom);
        }
      });
    }
  }

  /*
   * The widget's frame is a one-pixel outline round the whole box (`drawFrame`),
   * so each reading below starts inside it: the frame's top and bottom rows are
   * solid across, and every row between carries the frame's two edges as a lit
   * run each. Those are counted and taken off, never assumed away.
   */
  it('draws the page’s binder as a solid band with two holes knocked through it', () => {
    const which = CASES['800x480 whole']!;
    const fb = render({ variant: 'page', target: '2026-10-05', title: 'Christmas' }, which);
    const ink = inkBounds(fb, which);
    const width = ink.right - ink.left;
    // The first mostly-solid row under the frame's own top edge is the band.
    let top = ink.top + 1;
    while (top < ink.bottom && litCount(fb, top, ink.left, ink.right) < width * 0.9) top += 1;
    let bottom = top;
    while (bottom + 1 < ink.bottom && litCount(fb, bottom + 1, ink.left, ink.right) > width * 0.5) bottom += 1;
    expect(bottom - top, 'the band is a single row').toBeGreaterThan(1);
    // Through its middle: the frame's edge, the band broken twice, the frame's edge.
    const middle = Math.floor((top + bottom) / 2);
    expect(litRuns(fb, middle, ink.left, ink.right) - 2, 'the band is broken this many times, plus one').toBe(3);
  });

  it('draws the ticket’s board as one filled tile per digit, and none on the day', () => {
    const which = CASES['800x480 whole']!;
    const tilesOf = (target: string): number => {
      const fb = render({ variant: 'ticket', target, title: 'Lisbon' }, which);
      const ink = inkBounds(fb, which);
      // Up from the frame's bottom edge to the first row with more than its two edges lit.
      let y = ink.bottom - 1;
      while (y > ink.top && litCount(fb, y, ink.left, ink.right) <= 2) y -= 1;
      // The tiles' own bottom row is solid inside each tile: one run per tile.
      return litRuns(fb, y, ink.left, ink.right) - 2;
    };
    expect(tilesOf('2026-10-05'), 'twelve days').toBe(2);
    expect(tilesOf('2027-09-23'), 'a year off').toBe(3);
    expect(tilesOf('2026-09-24'), 'one day').toBe(1);
    // On the day the lowest thing drawn is the line, which is words: not a tile row.
    const fb = render({ variant: 'ticket', target: '2026-09-23', title: 'Lisbon' }, which);
    const ink = inkBounds(fb, which);
    let y = ink.bottom - 1;
    while (y > ink.top && litCount(fb, y, ink.left, ink.right) <= 2) y -= 1;
    expect(y, 'something is drawn below the line on the day').toBeLessThan(ink.top + (ink.bottom - ink.top) / 2);
  });

  it('gives up parts in a short box rather than spilling out of it', () => {
    const which: Case = { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 0.5, h: 0.12 } };
    const box = placed(which);
    for (const variant of ['page', 'ticket']) {
      const tall = render({ variant, target: '2026-10-05', title: 'Christmas' }, { ...which, box: { ...which.box, h: 0.6 } });
      const short = render({ variant, target: '2026-10-05', title: 'Christmas' }, which);
      const ink = inkBounds(short, which);
      expect(ink.bottom, `${variant} spilled`).toBeLessThanOrEqual(box.bottom);
      expect(bits(short, which), `${variant} drew nothing`).toContain('1');
      expect(bits(short, which)).not.toBe(bits(tall, which));
    }
  });
});

/*
 * The item's second half on one bit (P5.2): the progress bar and the mini
 * month, read back out of the frame. The occasion is the number on a panel and
 * is held to that above.
 */
describe('the progress bar and the mini month, read back out of the frame', () => {
  const whole = CASES['800x480 whole']!;
  const tall: Case = { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 0.5, h: 1 } };

  /** The model for a day `days` after the fixture's, from the same manifest shape. */
  function modelAt(days: number, weekStart?: 'monday'): { manifest: Manifest; model: ReturnType<typeof buildEpaperModel> } {
    const base = manifest() as unknown as Record<string, unknown>;
    const shifted = {
      ...base,
      generatedAt: AT + days * 86_400_000,
      display: { ...(base['display'] as object), ...(weekStart === undefined ? {} : { weekStart }) },
    } as unknown as Manifest;
    return { manifest: shifted, model: buildEpaperModel(shifted) };
  }

  function renderOn(at: { manifest: Manifest; model: ReturnType<typeof buildEpaperModel> }, config: Record<string, unknown>, which: Case): Framebuffer {
    const widget: PlacedEpaperWidget = { type: 'countdown', ...which.box, z: 0, config };
    return renderFreeformEpaper(at.model, at.manifest, [widget], which.panel);
  }

  /** Rows lit across at least 95% of the widget: the frame's own two edges, and a bar's. */
  function solidRows(fb: Framebuffer, which: Case): number[] {
    const box = placed(which);
    const rows: number[] = [];
    for (let y = box.top; y <= box.bottom; y++) {
      if (litCount(fb, y, box.left, box.right) >= (box.right - box.left + 1) * 0.95) rows.push(y);
    }
    return rows;
  }

  /** The bar: its edge rows, and how much of its inside is filled on its middle row. */
  function barOf(fb: Framebuffer, which: Case): { top: number; bottom: number; filled: number; inner: number } {
    const box = placed(which);
    const solid = solidRows(fb, which).filter((y) => y !== box.top && y !== box.bottom);
    expect(solid.length, 'no bar outline drawn').toBeGreaterThanOrEqual(2);
    const top = solid[0]!;
    const bottom = solid[solid.length - 1]!;
    const middle = Math.floor((top + bottom) / 2);
    // Take off the frame's two edges and the bar's two: what is left is the fill.
    const lit = litCount(fb, middle, box.left, box.right) - 4;
    // The bar is the frame's inner box; its inside is four pixels narrower.
    let left = box.left + 1;
    while (!fb.get(left, top)) left += 1;
    let right = box.right - 1;
    while (!fb.get(right, top)) right -= 1;
    return { top, bottom, filled: lit, inner: right - left + 1 - 4 };
  }

  it('keeps every lit pixel inside its box, on every kind of day, for both looks', () => {
    for (const [name, which] of Object.entries(CASES)) {
      const box = placed(which);
      for (const target of ['2026-10-05', '2026-09-23', '2026-09-20', '2027-09-23']) {
        for (const config of [
          { variant: 'progress', target, from: '2026-09-01', title: 'Summer holiday' },
          { variant: 'progress', target, title: 'Summer holiday' },
          { variant: 'month', target, title: 'Summer holiday' },
        ]) {
          const ink = inkBounds(render(config, which), which);
          const where = `${name} ${JSON.stringify(config)}`;
          expect(ink.left, where).toBeGreaterThanOrEqual(box.left);
          expect(ink.top, where).toBeGreaterThanOrEqual(box.top);
          expect(ink.right, where).toBeLessThanOrEqual(box.right);
          expect(ink.bottom, where).toBeLessThanOrEqual(box.bottom);
        }
      }
    }
  });

  it('fills the bar as far as the days gone, measured off the frame', () => {
    // Today is 23 September: ten days of twenty gone, then five of twenty.
    for (const [from, target, fraction] of [
      ['2026-09-13', '2026-10-03', 0.5],
      ['2026-09-18', '2026-10-08', 0.25],
      ['2026-09-01', '2026-09-20', 1],
    ] as const) {
      const bar = barOf(render({ variant: 'progress', from, target, title: 'Holiday' }, whole), whole);
      expect(Math.abs(bar.filled - bar.inner * fraction), `${from} to ${target}: ${bar.filled} of ${bar.inner}`).toBeLessThanOrEqual(1);
    }
    // Before the start the bar is drawn and empty.
    const empty = barOf(render({ variant: 'progress', from: '2026-09-30', target: '2026-10-30', title: 'Holiday' }, whole), whole);
    expect(empty.filled).toBe(0);
  });

  it('draws no bar at all with no start date, and says so instead', () => {
    const without = render({ variant: 'progress', target: '2026-10-05', title: 'Holiday' }, whole);
    const box = placed(whole);
    expect(solidRows(without, whole), 'a bar outline with nothing to measure it from').toEqual([box.top, box.bottom]);
    expect(bits(without, whole)).not.toBe(bits(render({ variant: 'progress', target: '2026-10-05', title: 'Holiday', from: '2026-09-01' }, whole), whole));
  });

  it('keeps the bar where it was from one day to the next, so only the ink inside it moves', () => {
    const config = { variant: 'progress', from: '2026-09-13', target: '2026-10-03', title: 'Holiday' };
    const today = barOf(renderOn(modelAt(0), config, whole), whole);
    const tomorrow = barOf(renderOn(modelAt(1), config, whole), whole);
    expect([tomorrow.top, tomorrow.bottom, tomorrow.inner]).toEqual([today.top, today.bottom, today.inner]);
    expect(tomorrow.filled, 'the bar did not grow').toBeGreaterThan(today.filled);
  });

  it('rings the target: moving it a day moves the ring a square along its week, and nothing else in the grid', () => {
    const a = render({ variant: 'month', target: '2026-09-28', title: 'Holiday' }, tall);
    const b = render({ variant: 'month', target: '2026-09-29', title: 'Holiday' }, tall);
    const box = placed(tall);
    const rows = new Map<number, { onlyA: number[]; onlyB: number[] }>();
    for (let y = box.top; y <= box.bottom; y++) {
      for (let x = box.left; x <= box.right; x++) {
        if (a.get(x, y) === b.get(x, y)) continue;
        const row = rows.get(y) ?? { onlyA: [], onlyB: [] };
        (a.get(x, y) ? row.onlyA : row.onlyB).push(x);
        rows.set(y, row);
      }
    }
    // Two bands of difference: the count ("5 DAYS" against "6 DAYS") at the
    // top, and one grid row, where the ring left 28 and went round 29. A 5 and
    // a 6 differ at their tops and bottoms and agree between, so rows a few
    // pixels apart are one band.
    const ys = [...rows.keys()].sort((p, q) => p - q);
    const bands: number[][] = [];
    for (const y of ys) {
      const last = bands[bands.length - 1];
      if (last !== undefined && y - (last[last.length - 1] ?? y) <= 6) last.push(y);
      else bands.push([y]);
    }
    expect(bands, `the difference is not the count and one grid row: ${JSON.stringify(bands.map((b) => [b[0], b[b.length - 1]]))}`).toHaveLength(2);
    const ring = bands[1]!;
    expect(ring.length, 'the ring’s band is taller than a square').toBeLessThanOrEqual(30);
    const onlyA = ring.flatMap((y) => rows.get(y)!.onlyA);
    const onlyB = ring.flatMap((y) => rows.get(y)!.onlyB);
    expect(onlyA.length, 'no ring round the 28th').toBeGreaterThan(8);
    expect(onlyB.length, 'no ring round the 29th').toBeGreaterThan(8);
    const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    expect(mean(onlyA), 'the 28th is not left of the 29th').toBeLessThan(mean(onlyB));
  });

  /** The rows two frames differ on, in bands of rows a few pixels apart, each with what only one side has. */
  function differenceBands(a: Framebuffer, b: Framebuffer, which: Case): { rows: number[]; onlyA: number[]; onlyB: number[] }[] {
    const box = placed(which);
    const bands: { rows: number[]; onlyA: number[]; onlyB: number[] }[] = [];
    for (let y = box.top; y <= box.bottom; y++) {
      const onlyA: number[] = [];
      const onlyB: number[] = [];
      for (let x = box.left; x <= box.right; x++) {
        if (a.get(x, y) && !b.get(x, y)) onlyA.push(x);
        if (b.get(x, y) && !a.get(x, y)) onlyB.push(x);
      }
      if (onlyA.length + onlyB.length === 0) continue;
      const last = bands[bands.length - 1];
      if (last !== undefined && y - (last.rows[last.rows.length - 1] ?? y) <= 6) {
        last.rows.push(y);
        last.onlyA.push(...onlyA);
        last.onlyB.push(...onlyB);
      } else bands.push({ rows: [y], onlyA, onlyB });
    }
    return bands;
  }

  it('underlines today, and the mark moves a square when the day does', () => {
    const config = { variant: 'month', target: '2026-09-30', title: 'Holiday' };
    const bands = differenceBands(renderOn(modelAt(0), config, tall), renderOn(modelAt(1), config, tall), tall);
    // The count (7 days, then 6) and one thin line in the grid, lifted from
    // under the 23rd and drawn under the 24th — the ring on the 30th stays.
    expect(bands.map((band) => [band.rows[0], band.rows[band.rows.length - 1]]), 'not the count and one line').toHaveLength(2);
    const mark = bands[1]!;
    expect(mark.rows.length, 'more than a line moved in the grid').toBeLessThanOrEqual(2);
    expect(mark.onlyA.length, 'nothing under the 23rd').toBeGreaterThan(0);
    expect(mark.onlyB.length, 'nothing under the 24th').toBeGreaterThan(0);
    const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    expect(mean(mark.onlyA), 'the 23rd is not left of the 24th').toBeLessThan(mean(mark.onlyB));
  });

  it('lays the month out from the household’s own first day of the week', () => {
    // Where the ring goes round the 30th, read as what differs from a ring
    // round the 29th: a Wednesday, the third column from a Monday and the
    // fourth from a Sunday. The heads alone would make the two frames differ,
    // so it is the ring's column that is asked, not the frame.
    const ringAt = (weekStart?: 'monday'): number => {
      const at = modelAt(0, weekStart);
      const bands = differenceBands(
        renderOn(at, { variant: 'month', target: '2026-09-30', title: 'Holiday' }, tall),
        renderOn(at, { variant: 'month', target: '2026-09-29', title: 'Holiday' }, tall),
        tall,
      );
      const ring = bands[bands.length - 1]!.onlyA;
      return ring.reduce((sum, x) => sum + x, 0) / ring.length;
    };
    const box = placed(tall);
    const column = (box.right - box.left) / 7;
    expect(ringAt('monday') - ringAt(), 'the 30th is not a column further left from a Monday').toBeCloseTo(-column, -1);
  });

  it('gives up the bar before the count, in a box with room for the count alone', () => {
    const line: Case = { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 0.5, h: 0.06 } };
    const box = placed(line);
    const fb = render({ variant: 'progress', target: '2026-10-05', from: '2026-09-01', title: 'Christmas' }, line);
    expect(solidRows(fb, line), 'a bar drawn in a box with no room for it').toEqual([box.top, box.bottom]);
    expect(bits(fb, line)).toContain('1');
    expect(inkBounds(fb, line).bottom).toBeLessThanOrEqual(box.bottom);
  });

  it('gives up parts in a short box rather than spilling, and keeps the count', () => {
    const short: Case = { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 0.5, h: 0.12 } };
    const box = placed(short);
    for (const config of [
      { variant: 'progress', target: '2026-10-05', from: '2026-09-01', title: 'Christmas' },
      { variant: 'month', target: '2026-10-05', title: 'Christmas' },
    ]) {
      const fb = render(config, short);
      expect(inkBounds(fb, short).bottom, `${config.variant} spilled`).toBeLessThanOrEqual(box.bottom);
      expect(bits(fb, short), `${config.variant} drew nothing`).toContain('1');
      expect(bits(fb, short)).not.toBe(bits(render(config, { ...short, box: { ...short.box, h: 0.9 } }), short));
    }
  });
});
