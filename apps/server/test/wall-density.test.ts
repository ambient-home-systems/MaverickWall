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
  equipHousehold(wall.db);
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
  readonly runsUnderFloor: number;
  readonly monthNamesVisible: number;
  readonly plusNCells: number;
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
    const canvasArea = wallMeasurement.canvasFit
      ? wallMeasurement.canvasFit.actual.width * wallMeasurement.canvasFit.actual.height
      : 0;
    const viewportArea = size.width * size.height;

    return {
      totalRuns: wallMeasurement.runs.length,
      runsUnderFloor: under.length,
      monthNamesVisible: grid.titles.length,
      plusNCells: plusN.length,
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
  readonly plusNCells: number;
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
    plusNCells: 13,
    runsUnderFloor: 45,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 93.5,
    contentSharePercent: 85.5,
  },
  '800x480': {
    monthNamesVisible: 0,
    plusNCells: 13,
    runsUnderFloor: 46,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 93.5,
    contentSharePercent: 80,
  },
  '1080x1920': {
    monthNamesVisible: 3,
    plusNCells: 10,
    runsUnderFloor: 7,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 85.5,
  },
  '1920x1080': {
    monthNamesVisible: 7,
    plusNCells: 8,
    runsUnderFloor: 15,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
  '2560x1440': {
    monthNamesVisible: 8,
    plusNCells: 8,
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
