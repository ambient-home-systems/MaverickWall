/**
 * The shipped Classic wall, measured for density rather than for one bug.
 *
 * This file exists because a design audit drove the real Classic wall — three
 * loopback ICS feeds, a cached forecast, a seeded rota, paired through the
 * real `POST /admin/screens` — at five real screen sizes and found the same
 * shape of fault CLAUDE.md's own list keeps finding: a "+3" where a name could
 * have been, a month grid naming nothing on a small panel, and dozens of runs
 * under this project's own 22px legibility floor. None of that showed up by
 * reading the stylesheet. It showed up by counting.
 *
 * `CLAUDE.md`'s "Verification is the job" is explicit that a green suite has
 * repeatedly agreed with a broken wall — the link-local test, the session-gate
 * stub, `browser-source-colours`'s assertion that could not go red. So this is
 * not a test that a feature exists; it is a **ratchet**. Twelve later phases
 * are meant to improve on the numbers recorded in `BASELINE` below, and this
 * file is their acceptance gate: a phase that does not move these numbers in
 * the improving direction has not shipped what it claims to.
 *
 * Three measurement traps this file exists to avoid, all paid for already by
 * `browser-harness.ts` and `browser-classic-proportions.test.ts`:
 *
 *  - **Hidden is not absent.** `trimCellRows` hides month rows it cannot fit
 *    with `display: none` and leaves them in the DOM, so a bare
 *    `querySelectorAll` count reports every title in the fixture at every
 *    viewport regardless of what actually fits. `measureMonthGrid` already
 *    filters on computed `display`/`visibility`, which is the whole reason to
 *    call it rather than count nodes here.
 *  - **`font-size` is not what is drawn.** `fitToBox` writes a `scale()`
 *    transform on the whole section, so `getComputedStyle().fontSize` reports
 *    the stylesheet's number on a wall where the ink is a quarter of it.
 *    `measureWall`'s `scaleOf` walker multiplies every ancestor transform back
 *    in, which is the only honest way to ask "how big is this on the glass".
 *  - **The first draw is not the steady state.** `fitToBox` and
 *    `trimCellRows` measure once, synchronously, against whatever font metrics
 *    have arrived by then — a cold context can report anywhere from 2 to 13
 *    named month cells for the *identical* wall. `loadWallSettled` holds the
 *    first manifest back and reloads, which is the state a wall that has been
 *    hanging in a kitchen for a while is actually in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  coveredFraction,
  equipHousehold,
  HOUSEHOLD_CALENDARS,
  install,
  loadWallSettled,
  measureCanvasInk,
  measureMonthGrid,
  measureWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and several walls. */
const SLOW = 180_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

const VIEWPORTS = [
  { width: 480, height: 800 },
  { width: 800, height: 480 },
  { width: 1080, height: 1920 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // `pairLink` is the real `POST /admin/screens`, which is where a new
  // display is seeded with Classic — so this measures the seed a household
  // actually gets rather than a fixture built by hand.
  link = await wall.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface ViewportMeasurement {
  readonly totalRuns: number;
  /**
   * How many *different* events the grid names, counting a span bar's label
   * once however many days it covers.
   *
   * `monthNamesVisible` beside it counts name-shaped *nodes*, and the two came
   * apart the moment a multi-day event stopped being repeated per cell: seven
   * squares each saying "Half term" is seven nodes and one fact. A node count
   * therefore *penalises* the rule that removed the repetition, and would go on
   * rewarding a grid that put it back — so the distinct count is the one that
   * says whether more of the household's calendar reached the glass.
   */
  readonly distinctNames: number;
  readonly runsUnderFloor: number;
  readonly monthNamesVisible: number;
  readonly plusNCells: number;
  /** Cells drawing a density mark — what a cell that can name nothing says. */
  readonly markedCells: number;
  /** Multi-day bars on the glass, each one drawn once across its days. */
  readonly spanBars: number;
  readonly agendaDays: number;
  readonly agendaEvents: number;
  readonly canvasSharePercent: number;
  readonly contentSharePercent: number;
}

/**
 * Everything this file asks about one screen size, in one settled load.
 *
 * `monthNamesVisible` and `plusNCells` come from `measureMonthGrid`, which
 * already excludes rows `trimCellRows` has hidden. `runsUnderFloor` comes from
 * `measureWall`, whose `effectivePx` is the cascade size times every ancestor
 * transform — the number a household's eye actually meets, not the number the
 * stylesheet asked for. The agenda counts are the one measurement neither
 * helper takes, because they are specific to this file: how many day groups
 * and how many event rows the agenda widget actually drew, counting only
 * elements a household could see (a non-`none` display, not `hidden`, and a
 * rect with real height — the same visibility test `measureWall` applies,
 * spelled out again here because `.day-row` and `.dr-ev` are agenda-specific
 * markup no shared helper reaches into).
 */
async function measureViewport(size: {
  readonly width: number;
  readonly height: number;
}): Promise<ViewportMeasurement> {
  const { page, close } = await loadWallSettled(link, size);
  try {
    const [wallMeasurement, grid, ink, agenda] = await Promise.all([
      measureWall(page),
      measureMonthGrid(page),
      measureCanvasInk(page),
      page.evaluate(() => {
        const visible = (element: Element): boolean => {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return element.getBoundingClientRect().height > 0;
        };
        const days = Array.from(document.querySelectorAll('#wall .canvas section.next .day-row')).filter(visible);
        const events = days.reduce(
          (total, day) => total + Array.from(day.querySelectorAll(':scope .dr-ev')).filter(visible).length,
          0,
        );
        return { days: days.length, events };
      }),
    ]);

    const under = wallMeasurement.runs.filter((run) => run.effectivePx < FLOOR_PX);
    const plusN = grid.cells.filter((cell) => cell.more !== '');
    /*
     * What a cell that can name nothing says instead.
     *
     * `plusNCells` alone cannot see the difference between a grid that stopped
     * spending its one row on "+3" and a grid that went back to `dots` and says
     * nothing at all — which is the hole this file's own comment beside that
     * assertion points at, closed for `monthNamesVisible` by pairing the two
     * and *not* closed at 480x800 or 800x480, where the baseline names zero
     * events either way. The density mark is what those cells draw now, and its
     * width is the encoding, so it is read as a width and never as a class.
     */
    const marked = grid.cells.filter((cell) => cell.markPx > 0);
    const canvasArea = wallMeasurement.canvasFit
      ? wallMeasurement.canvasFit.actual.width * wallMeasurement.canvasFit.actual.height
      : 0;
    const viewportArea = size.width * size.height;

    return {
      totalRuns: wallMeasurement.runs.length,
      runsUnderFloor: under.length,
      monthNamesVisible: grid.titles.length,
      distinctNames: new Set([
        ...grid.titles.map((title) => title.text),
        ...grid.spans.filter((bar) => bar.labelled).map((bar) => bar.title),
      ]).size,
      plusNCells: plusN.length,
      markedCells: marked.length,
      spanBars: grid.spans.length,
      agendaDays: agenda.days,
      agendaEvents: agenda.events,
      canvasSharePercent: viewportArea > 0 ? (canvasArea / viewportArea) * 100 : 0,
      contentSharePercent: ink !== undefined ? coveredFraction(ink) * 100 : 0,
    };
  } finally {
    await close();
  }
}

interface Baseline {
  readonly monthNamesVisible: number;
  readonly distinctNames: number;
  readonly plusNCells: number;
  readonly markedCells: number;
  readonly spanBars: number;
  readonly runsUnderFloor: number;
  readonly agendaDays: number;
  readonly agendaEvents: number;
  readonly canvasSharePercent: number;
  readonly contentSharePercent: number;
}

/**
 * Today's numbers, measured on this fixture by this file.
 *
 * **This is a ratchet, the same discipline as the migration journal parity
 * check: the constant is the record.** Every assertion below compares a fresh
 * measurement against these figures in the *improving* direction only —
 * `monthNamesVisible`, `agendaDays` and `agendaEvents` at least the baseline
 * (more of the household's actual calendar reaching the glass is better),
 * `plusNCells` and `runsUnderFloor` at most the baseline (fewer illegible runs
 * and fewer names swallowed by an overflow count is better), and the two share
 * percentages at least the baseline (more of the screen actually carrying the
 * household's data, rather than letterbox or empty widget chrome, is better).
 *
 * **A phase that improves one of these numbers MUST raise (or lower, for the
 * two "at most" fields) the baseline in the same commit.** Leaving it as-is
 * means the next phase's floor is this phase's ceiling, which silently caps
 * the twelve phases this file is the acceptance gate for. Lowering a number in
 * the *worsening* direction is a regression and needs its own justification in
 * the commit that does it — the same rule `LEGIBILITY_FLOOR_REM` and
 * `MIN_CHORE_SCALE` are held to elsewhere in this file's fixtures.
 *
 * **Raised once, by the four content rules** (a multi-day event drawn as one
 * bar, an overflow count that never costs a name, the density mark, and the
 * agenda's current-time rule). Every number below was re-measured on this
 * fixture, and the "before" column is a clean worktree of `main` at `b922a06`
 * running the *same* fixture — not the old figures, which were taken before
 * `HOUSEHOLD_CALENDARS` had a multi-day event in it at all.
 *
 *   |     viewport | distinct | names |  +N  | floor |
 *   |--------------|----------|-------|------|-------|
 *   |      480x800 |   0 →  0 |  0→ 0 | 19→0 | 45→45 |
 *   |      800x480 |   0 →  0 |  0→ 0 | 19→0 | 46→46 |
 *   |    1080x1920 |   8 →  9 | 15→11 |  8→4 |   9→7 |
 *   |    1920x1080 |   6 →  8 | 13→ 8 |  8→2 | 15→15 |
 *   |    2560x1440 |   7 →  8 | 14→10 |  8→1 |   0→0 |
 *
 * Three of those columns need saying out loud.
 *
 * **`monthNamesVisible` goes down, and that is the metric rather than the
 * wall.** It counts name-shaped *nodes*, and seven squares each saying "Half
 * term" is seven nodes and one fact — so collapsing a repeated multi-day event
 * into one labelled bar reads as a loss of six names. A node count therefore
 * penalises the rule that removed the repetition and would go on rewarding a
 * grid that put it back. `distinctNames` is the replacement and is what the
 * "more of the household's calendar reaching the glass is better" claim
 * actually means: it counts a bar's label once however many days it covers,
 * and it is **up at every size that names anything at all**. Both are asserted,
 * so a later phase cannot quietly lose real names down to this lower node
 * count.
 *
 * **`runsUnderFloor` at 1080x1920 was already broken on `main`.** The same
 * clean worktree measures **9** against the 7 recorded here — two agenda rota
 * chips at 21.7px against the 22px floor, arriving with the type-hierarchy
 * pass, whose own note in `CLAUDE.md` says it "moved none of that file's own
 * `BASELINE` numbers". It moved that one, and this file was red on `main` for
 * it. This phase's agenda changes put it back to 7, so the number is left
 * exactly as it was rather than raised to bless a regression.
 *
 * **`markedCells` and `spanBars` are new**, and both exist to close holes this
 * file's own comments point at. `plusNCells` alone cannot tell a grid that
 * stopped spending its one row on "+3" from a grid that went back to `dots` and
 * says nothing — the revert the comment below names as passing silently — and
 * at 480x800 and 800x480 `monthNamesVisible` is 0 either way, so the pairing
 * does not catch it there. `spanBars` is what a multi-day event costs the grid:
 * 2 at the three larger sizes (a seven-day half term crossing a week boundary
 * is two bars) and 0 at the two smallest, where a cell has no room for a lane
 * and `trimCellRows` measures the bars back out again.
 *
 * The audit that this file exists to make repeatable reported, at these same
 * five sizes: 6 agenda events across 3 days at every size; 0 month names
 * visible at 480x800 and 800x480, 3 at 1080x1920, 7 at 1920x1080, 8 at
 * 2560x1440; 13, 13, 10, 8 and 8 "+N" cells; and 51, 49, 20, 18 and 1 runs
 * under the 22px floor (out of 127, 127, 124, 122 and 122). This file's own
 * fixture and measurement code are a faithful rebuild of that audit's method
 * rather than a byte-for-byte replay of its script — this fixture has 21
 * events across the same three feeds rather than 19, and its agenda window
 * lands on 2 visible days rather than 3 — so the `monthNamesVisible` and
 * `plusNCells` columns below reproduce the audit exactly (they depend only on
 * the month grid's own geometry) while `runsUnderFloor` and the agenda counts
 * are this fixture's own numbers, measured directly and not copied from the
 * audit's report. Every value below was read off a real run of this file, not
 * estimated.
 */
export const BASELINE: Record<string, Baseline> = {
  '480x800': {
    monthNamesVisible: 0,
    distinctNames: 0,
    plusNCells: 0,
    markedCells: 19,
    // No room for a lane under the numeral at this cell size, so the bars are
    // measured out by `trimCellRows` and the events go back to being rows.
    spanBars: 0,
    runsUnderFloor: 45,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 93.5,
    contentSharePercent: 85.5,
  },
  '800x480': {
    monthNamesVisible: 0,
    distinctNames: 0,
    plusNCells: 0,
    markedCells: 19,
    spanBars: 0,
    runsUnderFloor: 46,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 93.5,
    contentSharePercent: 80,
  },
  '1080x1920': {
    monthNamesVisible: 11,
    distinctNames: 9,
    plusNCells: 4,
    markedCells: 19,
    spanBars: 2,
    runsUnderFloor: 7,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 85.5,
  },
  '1920x1080': {
    monthNamesVisible: 8,
    distinctNames: 8,
    plusNCells: 2,
    markedCells: 19,
    spanBars: 2,
    runsUnderFloor: 15,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
  '2560x1440': {
    monthNamesVisible: 10,
    distinctNames: 8,
    plusNCells: 1,
    markedCells: 19,
    spanBars: 2,
    runsUnderFloor: 0,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
};

describe('the Classic wall, measured for density', () => {
  for (const size of VIEWPORTS) {
    const key = `${size.width}x${size.height}`;
    const baseline = BASELINE[key];
    if (baseline === undefined) throw new Error(`no baseline recorded for ${key}`);

    it(
      `${key}: does not lose ground on names, overflow, legibility or fill`,
      async () => {
        const measured = await measureViewport(size);

        /*
         * Checked by breaking what each measures: dropping `HOUSEHOLD_CALENDARS`
         * to one feed collapses `monthNamesVisible` to 0 at every size and this
         * assertion goes red; reverting `measureMonthGrid`'s hidden-row filter
         * makes it report the fixture's full title count regardless of size,
         * which would pass here and is exactly the bug this file exists to
         * catch — so that revert is the one this assertion cannot be trusted
         * without having tried.
         */
        expect(
          measured.monthNamesVisible,
          `${key}: the month grid named ${measured.monthNamesVisible} events, below the recorded ${baseline.monthNamesVisible}`,
        ).toBeGreaterThanOrEqual(baseline.monthNamesVisible);

        /*
         * Fewer "+N" cells is the improving direction: an overflow count that
         * could have been a name is the exact fault "An overflow count never
         * costs a name" (CLAUDE.md, Design rules) names. Checked by reverting
         * the cell-events default to `dots`, which turns every named cell back
         * into an unlabelled shaded square with no "+N" at all — silently
         * *passing* this assertion while failing every other one in the file,
         * which is why `monthNamesVisible` and `plusNCells` are asserted
         * together rather than either alone.
         */
        expect(
          measured.plusNCells,
          `${key}: the month grid drew ${measured.plusNCells} "+N" cells, above the recorded ${baseline.plusNCells}`,
        ).toBeLessThanOrEqual(baseline.plusNCells);

        /*
         * And a cell that stopped drawing a count still says *something*.
         *
         * This is the half `plusNCells` cannot see on its own, and the comment
         * above says so: reverting the cell treatment to `dots` takes every
         * counter away and passes that assertion, and at 480x800 and 800x480
         * `monthNamesVisible` is 0 either way so the pairing does not catch it
         * there. The density mark is what those cells draw, and it is read as a
         * **width** rather than as a class — `.hz-mark` with no length is still
         * `.hz-mark`, and this codebase has shipped exactly that bug once.
         */
        expect(
          measured.markedCells,
          `${key}: ${measured.markedCells} cells carry a density mark, below the recorded ${baseline.markedCells}`,
        ).toBeGreaterThanOrEqual(baseline.markedCells);

        /*
         * How many *different* events the grid names, a span bar's label
         * counting once however many days it covers.
         *
         * This is the "more of the household's calendar reaching the glass"
         * claim measured in a way the multi-day rule cannot flatter or be
         * punished by — see the table above, where `monthNamesVisible` falls
         * by six for a change that removed six *repetitions* of one title.
         * Checked by reverting the span grouping, which puts the repeats back:
         * the node count rises and this number does not move.
         */
        expect(
          measured.distinctNames,
          `${key}: the month grid named ${measured.distinctNames} different events, below the recorded ${baseline.distinctNames}`,
        ).toBeGreaterThanOrEqual(baseline.distinctNames);

        /*
         * And a multi-day event is drawn once rather than per cell.
         *
         * Zero at the two smallest sizes is the honest answer rather than a
         * missing case: a cell there has no room for a lane under its numeral,
         * so `trimCellRows` measures the bars back out and the events return to
         * being rows. Asserting the larger three is what makes removing the
         * rule fail here rather than only in its own file.
         */
        expect(
          measured.spanBars,
          `${key}: ${measured.spanBars} multi-day bars, below the recorded ${baseline.spanBars}`,
        ).toBeGreaterThanOrEqual(baseline.spanBars);

        /*
         * Checked by lowering `FLOOR_PX` here to 1px, which drops every
         * viewport's count to 0 and this assertion (correctly) stops being
         * able to fail — the guard against exactly that is
         * `browser-classic-proportions.test.ts`'s own floor assertion holding
         * the constant to `display.css`'s `--t-floor`, unchanged by this file.
         */
        expect(
          measured.runsUnderFloor,
          `${key}: ${measured.runsUnderFloor} of ${measured.totalRuns} runs are under the ${FLOOR_PX}px floor, ` +
            `above the recorded ${baseline.runsUnderFloor}`,
        ).toBeLessThanOrEqual(baseline.runsUnderFloor);

        /*
         * Checked by seeding a household with no calendars at all: the agenda
         * widget is dropped from the manifest outright
         * (`keepWidgetsWithSomethingToSay`), `days`/`events` both go to 0, and
         * this assertion turns red at every size.
         */
        expect(
          measured.agendaDays,
          `${key}: the agenda drew ${measured.agendaDays} days, below the recorded ${baseline.agendaDays}`,
        ).toBeGreaterThanOrEqual(baseline.agendaDays);
        expect(
          measured.agendaEvents,
          `${key}: the agenda drew ${measured.agendaEvents} events, below the recorded ${baseline.agendaEvents}`,
        ).toBeGreaterThanOrEqual(baseline.agendaEvents);

        /*
         * Checked by reading `--aspect` off a canvas deliberately mis-set to a
         * square: `measureWall`'s letterbox arithmetic then reports a canvas
         * far smaller than the viewport at every size, and this assertion
         * fails everywhere rather than only on the off-aspect phone sizes.
         */
        expect(
          measured.canvasSharePercent,
          `${key}: the canvas filled ${measured.canvasSharePercent.toFixed(1)}% of the viewport, ` +
            `below the recorded ${baseline.canvasSharePercent}%`,
        ).toBeGreaterThanOrEqual(baseline.canvasSharePercent);

        /*
         * Checked by removing the Shift and Weather widgets from Classic's
         * seed: fewer boxes cover less of the canvas, `coveredFraction` drops
         * and this assertion fails — which is the "hole in a fresh wall" fault
         * CLAUDE.md's "Current state" section records, made visible as a number
         * rather than left as a screenshot only a person can judge.
         */
        expect(
          measured.contentSharePercent,
          `${key}: widgets covered ${measured.contentSharePercent.toFixed(1)}% of the canvas, ` +
            `below the recorded ${baseline.contentSharePercent}%`,
        ).toBeGreaterThanOrEqual(baseline.contentSharePercent);
      },
      SLOW,
    );
  }
});

/**
 * The wall's type hierarchy, on the same paired wall (RFC — wall type
 * hierarchy — see "Design rules: do not reintroduce" above).
 *
 * Measured on a paired 1920x1080 Classic wall with three ordinary family
 * calendars, the clock drew at 137.7px and an actual event name at 31.6px —
 * 4.4x. A month cell's date numeral drew at 1.4x the event in that same cell.
 * The two largest things on the wall were the two facts a household already
 * possesses; the one thing they do not — an event — was drawn smaller than
 * either. The token changes hold two ratios: a month numeral (`.hz-num`) is at
 * most 1.2x its cell's event text (`.hz-rowtext`), and the clock (`.clock`) is
 * at most 1.8x an agenda event name (`.dr-ev-title`).
 *
 * This measures the *stylesheet's* ratio — `getComputedStyle` on each class,
 * in the live document, so the real cascade resolves every `var()` and
 * `calc()` exactly as it would for real content — rather than either of the
 * two things that would make a wrong ratio look right:
 *
 *  - a declared `font-size` read off the *source*, which would not catch a
 *    mistyped token name or a stale value nothing recomputed;
 *  - an actual rendered word's on-glass size, which depends on which box the
 *    household dragged each widget to. `fitToBox` scales a whole section
 *    independently of its neighbours, so `.clock` and `.dr-ev-title` sitting
 *    in differently-sized boxes can carry the *right* ratio in their own
 *    `font-size` and still land nowhere near it on the glass — measured, the
 *    Classic seed alone puts them at 2.44x in portrait even with this fix
 *    applied. That is real and is exactly what the arc-minute scale (a later
 *    phase) exists to close; a layout change to Classic's own box sizes is
 *    explicitly out of scope here (token changes only), so this holds the
 *    ratio this phase actually owns rather than a number no CSS-only change
 *    could satisfy.
 *  - a real month cell's `.hz-rowtext`, which `trimCellRows` may hide
 *    entirely at a small enough box — measured, every cell on the same paired
 *    wall at 480x800 and 800x480 (this file's own smallest sizes) falls back
 *    to "+N" with no event text drawn at all, which is a pre-existing fact
 *    about Classic's cell size at those two, confirmed by reverting `.hz-num`
 *    to its old size and measuring again — still nothing.
 *
 * Reading the cascade directly sidesteps both: a bare, undropped element with
 * the right class, appended to the same paired wall's `.canvas` above so it
 * inherits the same `--t-*`/`--rule` tokens a real one would, is what the
 * stylesheet actually promises for that class — independent of which box a
 * household drags a widget into and of whether this particular calendar's
 * events happened to fit a cell today. It reuses this file's own `link`
 * rather than pairing a second wall, since both halves measure the one
 * Classic seed this file already has settled and loaded.
 *
 * Three of this file's five viewports, because a ratio expressed in `rem` and
 * `calc()` has to survive the wall it is measured on: the portrait design
 * target, a landscape television and the smallest wall this project measures
 * anywhere (`--t-floor`'s own 1280x720 is not one of the five above, so it is
 * measured directly here rather than reused).
 */

/**
 * The cascade's own `font-size` for a class, read off a bare element planted
 * inside `.canvas` (so it inherits the same `--t-*` tokens and rem basis a
 * real widget's content would) and removed immediately after.
 */
async function stylesheetFontSize(page: Page, className: string): Promise<number> {
  return page.evaluate((cls) => {
    const canvas = document.querySelector('.canvas');
    if (canvas === null) throw new Error('no .canvas on the paired wall');
    const probe = document.createElement('div');
    probe.className = cls;
    canvas.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  }, className);
}

async function measureRatios(size: {
  readonly width: number;
  readonly height: number;
}): Promise<{ readonly numeralRatio: number; readonly clockRatio: number }> {
  const { page, close } = await loadWallSettled(link, size);
  try {
    const numeralPx = await stylesheetFontSize(page, 'hz-num');
    const eventPx = await stylesheetFontSize(page, 'hz-rowtext');
    const clockPx = await stylesheetFontSize(page, 'clock');
    const agendaEventPx = await stylesheetFontSize(page, 'dr-ev-title');
    return { numeralRatio: numeralPx / eventPx, clockRatio: clockPx / agendaEventPx };
  } finally {
    await close();
  }
}

/*
 * A whisker of slack over the exact ratio: browsers round a resolved
 * `font-size` to hundredths of a pixel independently on each side of a
 * `calc()`, so a bare `<=` would go red on rounding rather than on a real
 * regression.
 */
const RATIO_SLACK = 1.001;

const RATIO_VIEWPORTS: readonly { readonly label: string; readonly width: number; readonly height: number }[] = [
  { label: 'portrait (design target)', width: 1080, height: 1920 },
  { label: 'landscape television', width: 1920, height: 1080 },
  { label: 'the smallest wall this project measures', width: 1280, height: 720 },
];

describe('the type hierarchy, on the same paired wall', () => {
  for (const { label, width, height } of RATIO_VIEWPORTS) {
    it(
      `holds both ratios in ${label}`,
      async () => {
        const { numeralRatio, clockRatio } = await measureRatios({ width, height });
        expect(numeralRatio, `.hz-num is ${numeralRatio.toFixed(3)}x .hz-rowtext`).toBeLessThanOrEqual(
          1.2 * RATIO_SLACK,
        );
        expect(clockRatio, `.clock is ${clockRatio.toFixed(3)}x .dr-ev-title`).toBeLessThanOrEqual(
          1.8 * RATIO_SLACK,
        );
      },
      SLOW,
    );
  }
});
