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

  it('draws the page and the ticket as looks of their own, and the second half as the number', () => {
    const base = { target: '2026-10-05', title: 'Christmas' };
    const number = frame(base, whole);
    expect(frame({ ...base, variant: 'page' }, whole)).not.toBe(number);
    expect(frame({ ...base, variant: 'ticket' }, whole)).not.toBe(number);
    expect(frame({ ...base, variant: 'page' }, whole)).not.toBe(frame({ ...base, variant: 'ticket' }, whole));
    for (const later of ['occasion', 'progress', 'month']) {
      expect(frame({ ...base, variant: later }, whole), later).toBe(number);
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
