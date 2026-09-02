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
 *  - **Hidden is not absent.** The tier pass hides the month rows a cell has
 *    no form for with `display: none` and leaves them in the DOM, so a bare
 *    `querySelectorAll` count reports every title in the fixture at every
 *    viewport regardless of what is drawn. `measureMonthGrid` already
 *    filters on computed `display`/`visibility`, which is the whole reason to
 *    call it rather than count nodes here.
 *  - **`font-size` is not what is drawn.** `fitToBox` writes a `scale()`
 *    transform on the whole section, so `getComputedStyle().fontSize` reports
 *    the stylesheet's number on a wall where the ink is a quarter of it.
 *    `measureWall`'s `scaleOf` walker multiplies every ancestor transform back
 *    in, which is the only honest way to ask "how big is this on the glass".
 *  - **The first draw is not the steady state.** `fitToBox` and
 *    the tier pass measure once, synchronously, against whatever font metrics
 *    have arrived by then — a cold context can report anywhere from 2 to 13
 *    named month cells for the *identical* wall. `loadWallSettled` holds the
 *    first manifest back and reloads, which is the state a wall that has been
 *    hanging in a kitchen for a while is actually in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { mountedSize, wallSizePreset } from '../src/wall-sizes.js';
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
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // `pairLink` is the real `POST /admin/screens`, which is where a new
  // display is seeded with Classic — so this measures the seed a household
  // actually gets rather than a fixture built by hand.
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
}, SLOW);

/**
 * What this wall is, physically — or nothing, which is every household until
 * they open the setting.
 *
 * Written straight onto the screen row rather than through the settings form
 * because the form is not the subject here: `wall-editor.test.ts` proves it
 * reaches the manifest and `browser-wall-sizing.test.ts` proves the page reads
 * it, and this file is only ever asking what the wall *draws*. Every
 * measurement below sets it — including back to `null` — so no test in this
 * file can inherit the state another one left, which is the one way a file
 * with both a measured and an unmeasured wall in it silently measures the
 * wrong one.
 */
function measureScreen(size: PanelFacts | undefined): void {
  wall.db
    .prepare(
      `UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ?
        WHERE id = ?`,
    )
    .run(
      size?.widthMm ?? null,
      size?.heightMm ?? null,
      size?.distanceMm ?? null,
      screenId,
    );
}

interface PanelFacts {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly distanceMm: number;
  readonly label: string;
}

/**
 * A household for each of the five sizes, taken from the product's own
 * catalogue rather than invented here.
 *
 * `WALL_SIZE_PRESETS` is what the wall's settings page offers and `readAtMm`
 * is its own claim about where somebody stands to *read* one — so a fixture
 * built from a preset key and a rotation is a household who picked their panel
 * off the list and touched nothing else. That matters more than it looks:
 * every number this scale produces is linear in the read distance, so a
 * distance chosen here is a thumb on every measurement below, and "the preset,
 * unedited" is the one choice that is not one. `mountedSize` turns the pair to
 * how the panel is hung, exactly as the settings form does.
 *
 * The pairings are the ordinary ones: a 7.5" e-ink panel is 800x480 and is
 * hung either way up, and a 32" television is 1920x1080. 2560x1440 has no
 * preset of its own — it is a 43" panel at the nearest size the list carries.
 */
const MEASURED: Record<string, PanelFacts> = {};
for (const [key, presetKey, rotation] of [
  ['480x800', 'eink-7.5', 90],
  ['800x480', 'eink-7.5', 0],
  ['1080x1920', 'tv-32', 90],
  ['1920x1080', 'tv-32', 0],
  ['2560x1440', 'tv-43', 0],
] as const) {
  const preset = wallSizePreset(presetKey);
  if (preset === undefined) throw new Error(`no such wall-size preset: ${presetKey}`);
  const mounted = mountedSize(preset, rotation);
  MEASURED[key] = {
    widthMm: mounted.widthMm,
    heightMm: mounted.heightMm,
    distanceMm: preset.readAtMm,
    label: `${preset.label} at ${preset.readAtMm}mm`,
  };
}

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * The agenda's and the clock's runs, at the size they are drawn on glass.
 *
 * `.clock` is read from the real widget rather than from a planted probe, and
 * that is a correction rather than a preference: the only `.clock` a wall emits
 * is inside `.fw-clock`, whose rule is box-relative, so a bare probe measures
 * the stacked layout's retired rem rule and cannot go red for anything a
 * household would see. The month grid keeps its probe below for the opposite
 * reason — the tier pass draws no title at all in a small cell.
 */
interface DrawnRuns {
  readonly title: number;
  readonly time: number;
  readonly numeral: number;
  readonly weekday: number;
  readonly rota: number;
  readonly label: number;
  readonly clock: number;
  /**
   * What `fitToBox` did to the agenda: the drawn title over the declared one.
   *
   * The whole point of the fit ceiling, and the only way to see it. A section
   * whose type is stated in arc-minutes and then scaled is not drawn at the
   * angle it declares, and the scale is *self-cancelling* — smaller type means
   * a shorter section means a larger factor — so without this the roles could
   * move and the glass not move at all.
   */
  readonly agendaFit: number;
}

interface ViewportMeasurement {
  /** CSS pixels per arc-minute, or absent on a wall nobody has measured. */
  readonly pxArcmin: number | undefined;
  readonly drawn: DrawnRuns;
  /**
   * Whether the agenda was drawn at its declared size rather than scaled down
   * to fit — which is where "the role is the size" can be asserted as an
   * equality rather than as a ceiling.
   */
  readonly agendaFitsWhole: boolean;
  /** Every text run inside the month grid, at the size it is drawn on glass. */
  readonly gridRuns: readonly { readonly where: string; readonly fontPx: number }[];
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
 * already excludes rows the tier pass has hidden. `runsUnderFloor` comes from
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
async function measureViewport(
  size: { readonly width: number; readonly height: number },
  panel?: PanelFacts,
): Promise<ViewportMeasurement> {
  measureScreen(panel);
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

    /*
     * What one arc-minute of the reader's vision is worth here, read off the
     * root rather than recomputed — `main.ts` writes it and the eight roles
     * from one place, so asking the page is asking the thing under test. Empty
     * on an unmeasured wall, which is the state that must draw as it always
     * has.
     */
    const pxArcmin = Number(
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--px-arcmin')),
    );

    const drawn = await page.evaluate(() => {
      // The cascade size times every ancestor transform — `measureWall`'s own
      // walker, spelled again here because these are agenda-specific runs no
      // shared helper reaches into.
      const scaleOf = (element: Element): number => {
        let scale = 1;
        for (
          let node: Element | null = element;
          node !== null && node !== document.documentElement;
          node = node.parentElement
        ) {
          const transform = getComputedStyle(node).transform;
          if (transform === '' || transform === 'none') continue;
          const numbers = /matrix\(([^)]+)\)/.exec(transform);
          if (numbers === null) continue;
          const [a, b, c, d] = numbers[1]!.split(',').map(Number) as [number, number, number, number];
          const determinant = Math.abs(a * d - b * c);
          if (determinant > 0) scale *= Math.sqrt(determinant);
        }
        return scale;
      };
      const px = (selector: string): number => {
        const node = document.querySelector(`#wall .canvas ${selector}`);
        if (node === null) return 0;
        return parseFloat(getComputedStyle(node).fontSize) * scaleOf(node);
      };
      const declared = (selector: string): number => {
        const node = document.querySelector(`#wall .canvas ${selector}`);
        return node === null ? 0 : parseFloat(getComputedStyle(node).fontSize);
      };
      const title = px('.dr-ev-title');
      const declaredTitle = declared('.dr-ev-title');
      return {
        title,
        time: px('.dr-ev-time'),
        numeral: px('.dr-num'),
        weekday: px('.dr-dow'),
        rota: px('.dr-shift'),
        label: px('.section-label'),
        clock: px('.fw-clock .clock'),
        agendaFit: declaredTitle > 0 ? title / declaredTitle : 0,
      };
    });

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
      drawn,
      agendaFitsWhole: drawn.agendaFit >= 0.999,
      pxArcmin: Number.isFinite(pxArcmin) && pxArcmin > 0 ? pxArcmin : undefined,
      gridRuns: grid.texts.map((run) => ({ where: run.where, fontPx: run.fontPx })),
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
 * 2 at the three larger sizes (an eight-day half term always crosses a week
 * boundary, which is why it is eight) and 0 at the two smallest, where a cell
 * has no room for a lane and the tier pass measures the bars back out again.
 *
 * **Raised again, by the density tiers.** A month cell reads its own inner box
 * in characters of the type it would draw and takes a *form* from a table
 * (`tiers.ts`) rather than drawing everything and hiding what spilled. The
 * "before" column here is a clean worktree of `main` running this *same*
 * fixture at the same hour — not the numbers above it, which were taken when
 * the half term lasted seven days rather than eight:
 *
 *   |     viewport | distinct | names |  +N  | marked |
 *   |--------------|----------|-------|------|--------|
 *   |      480x800 |   0 →  0 |  0→ 0 | 0→ 0 |  20→20 |
 *   |      800x480 |   0 →  0 |  0→ 0 | 0→ 0 |  20→20 |
 *   |    1080x1920 |   9 →  9 | 11→11 | 4→ 1 |  20→20 |
 *   |    1920x1080 |   8 →  8 |  8→10 | 2→ 1 |  20→20 |
 *   |    2560x1440 |   8 →  9 | 10→11 | 1→ 1 |  20→20 |
 *
 * Two things about it are worth saying out loud.
 *
 * **`markedCells` went 19 → 20 for a reason that is not this change.** The
 * fixture's half term is eight days rather than seven now, so it touches one
 * more square — and the reason it is eight is that seven was a property of the
 * *calendar*: a run of exactly seven days lands on one grid row whenever it
 * happens to start on the household's week start and on two rows every other
 * day of the week, so `spanBars` read 2 for six days out of seven and 1 on the
 * seventh. Measured: the same clean worktree passed at 22:46 UTC and failed at
 * 23:10, when the fixture's dates rolled into the next London day. That is the
 * hour `HARNESS_HOUR` pins, one unit up — a test reading the calendar as though
 * it were reading the code — and it is the third time this file's own history
 * has had to record one.
 *
 * **`plusNCells` falls at three sizes and none of them is a name lost**, which
 * is the direction this metric is asserted in and is worth checking rather than
 * assuming: `monthNamesVisible` rises or holds at every one of the five, and
 * the two are asserted together for exactly that reason. Under a tier a cell
 * knows how many rows it is drawing before it draws them, so the counter no
 * longer arrives as an experiment that can push a title onto a line the cell
 * has not got — it shares the last name's line where that costs nothing, takes
 * a line of its own out of room the names declined, and otherwise says nothing
 * and leaves the density mark to say the day is busy.
 *
 * **Raised again, by the density tiers for the other six widgets — and this is
 * the pass that moves numbers the worsening way.** `fitToBox` is gone: nothing
 * on this wall is laid out at one size and scaled into its box any more, so a
 * widget's type is its role and its *form* comes from the box
 * (`widget-tiers.ts`). The "before" column is a clean worktree of `main`
 * running this same fixture at the same hour:
 *
 *   |     viewport | names | distinct |  +N  | floor |  days |  events |
 *   |--------------|-------|----------|------|-------|-------|---------|
 *   |      480x800 |  0→ 0 |    0→ 0  | 0→ 0 | 45→41 |  2→ 2 |   6→  6 |
 *   |      800x480 |  0→ 0 |    0→ 0  | 0→ 0 | 46→58 |  2→ 4 |   6→ 11 |
 *   |    1080x1920 | 11→12 |    9→10  | 1→ 0 |  7→ 0 |  2→ 2 |   6→  6 |
 *   |    1920x1080 | 10→10 |    8→ 8  | 1→ 1 | 15→18 |  2→ 4 |   6→ 11 |
 *   |    2560x1440 | 11→12 |    9→10  | 1→ 3 |  0→ 0 |  2→ 4 |   6→ 11 |
 *
 * The headline is the two right-hand columns: **the agenda stops drawing the
 * same six events on every wall in a 3.7-megapixel range.** Classic's own
 * `count: 6` went with the transform it was written for — the template said so
 * in as many words, "the section is scaled to fit, so two more rows is a
 * shorter scale factor on every character in the widget" — and with nothing
 * scaled a seventh event costs the six above it nothing. The two portrait
 * sizes are unchanged because their box genuinely holds six.
 *
 * Three columns move the wrong way and are recorded rather than buried, which
 * is this file's own rule.
 *
 * **`runsUnderFloor` rises at 800x480 (46→58) and 1920x1080 (15→18), and no
 * individual run got smaller for it.** Both are the sizes whose agenda went
 * from 6 events to 11: there are simply more runs on the glass, at sizes that
 * were already under the floor. The one run that *did* shrink is the agenda's
 * type at 800x480, 16.6px → 14.0px (`AGENDA_BASELINE`), and that is the fit's
 * growth being removed rather than a size anybody chose — `fitToBox` grew that
 * section by 1.18x because its box had spare height, and the spare height now
 * buys events. Neither number is legible on a 7.5" panel either way; what makes
 * one legible is measuring the wall, which is the block below.
 *
 * **`plusNCells` rises at 2560x1440 (1→3), paired with names 11→12.** The same
 * argument the previous phase recorded and the reason the two are asserted
 * together: a cell that can name nothing draws no counter at all, so a cell
 * that *starts* naming something becomes a cell that can carry a count. A loss
 * of names would still fail.
 *
 * **`runsUnderFloor` then falls by exactly five at 480x800 and 800x480, and
 * not one word got bigger.** The forecast strip's icon
 * used to be a *character* — an emoji, set at 2.1rem — so it counted as a run
 * of type, and at those two sizes 2.1rem is 15.7px and 9.4px. It is a drawing
 * now (`glyphs.ts`), so five columns' worth of runs stopped existing. The
 * arithmetic is what says so rather than the direction: at 1920x1080 the same
 * 2.1rem is 22.7px, above the floor, and that size's count is unchanged; at
 * 1080x1920 and 2560x1440 the count was already 0. A metric whose *population*
 * changed is not a metric that improved, and recording it as one is how a
 * baseline stops meaning anything.
 *
 * **The recorded values are 41 and 58, and the arithmetic to reach them is why
 * this was measured on the merged tree rather than computed.** Roboto Flex
 * landed on `main` while the glyphs were being built and raised these same two
 * numbers by five each, for its own unrelated reason (41→46, 58→63, the
 * paragraph above). Two independent deltas of five on one metric, in opposite
 * directions, land back where they started — which is exactly the coincidence
 * that would let a merge resolved by picking a side pass while measuring
 * something nobody intended. Measured after merging: 41 and 58, the same
 * numbers this file carried before either change, reached by two mechanisms
 * that cancel. Neither is a return to a previous state, and the paragraph for
 * each stays.
 *
 * **`AGENDA_BASELINE`'s numeral falls at every size**, 59.7px → 44.9px at
 * 1080x1920. That is `.dr-num` finally honouring this project's own design rule
 * on a wall nobody has measured — "the date numeral is never larger than the
 * event name beside it by more than 1.2x", which its rem fallback had been
 * breaking at 1.59x. The room it frees goes straight into the agenda.
 *
 * **`runsUnderFloor` rises again, at the same two sizes, for a fourth reason:
 * `--f-sans` and `--f-cond` are a real self-hosted face now instead of
 * `system-ui` and Roboto Condensed.** 41→46 at 480x800, 58→63 at 800x480 —
 * both unmeasured sizes, where the calendar widget's density tier and every
 * rem-derived size on the wall are read off Roboto Flex's own metrics rather
 * than whatever font a tablet happened to already have. `AGENDA_BASELINE`'s
 * seven named runs do not move at either size, which is what says this is the
 * font measuring differently rather than a size anybody chose falling — the
 * runs that cross the floor are the ones this file does not name individually
 * (event and weekday text elsewhere on the glass), pushed under 22px by a few
 * tenths of a pixel each. The two measured sizes (1080x1920, 1920x1080,
 * 2560x1440) do not move, because there a household's own panel dimensions
 * drive the arc-minute scale rather than this rem fallback — the fallback is
 * exactly the thing rule three's font work exists to make consistent, and a
 * one-time cost on the sizes nobody has measured yet is the honest price of
 * two panels on the same version finally drawing the same type.
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
    markedCells: 20,
    // No room for a lane under the numeral at this cell size, so the bars are
    // measured back out by the tier pass and the events go back to being rows.
    spanBars: 0,
    runsUnderFloor: 41,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 93.5,
    contentSharePercent: 85.5,
  },
  '800x480': {
    monthNamesVisible: 0,
    distinctNames: 0,
    plusNCells: 0,
    markedCells: 20,
    spanBars: 0,
    runsUnderFloor: 58,
    agendaDays: 4,
    agendaEvents: 11,
    canvasSharePercent: 93.5,
    contentSharePercent: 80,
  },
  '1080x1920': {
    monthNamesVisible: 12,
    distinctNames: 10,
    plusNCells: 0,
    markedCells: 20,
    spanBars: 2,
    runsUnderFloor: 0,
    agendaDays: 2,
    agendaEvents: 6,
    canvasSharePercent: 99.5,
    contentSharePercent: 85.5,
  },
  '1920x1080': {
    monthNamesVisible: 10,
    distinctNames: 8,
    plusNCells: 1,
    markedCells: 20,
    spanBars: 2,
    runsUnderFloor: 18,
    agendaDays: 4,
    agendaEvents: 11,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
  '2560x1440': {
    monthNamesVisible: 12,
    distinctNames: 10,
    plusNCells: 3,
    markedCells: 20,
    spanBars: 2,
    runsUnderFloor: 0,
    agendaDays: 4,
    agendaEvents: 11,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
};

/** The runs `AGENDA_BASELINE` pins, in the order a failure reads best. */
const DRAWN_RUNS = ['title', 'time', 'numeral', 'weekday', 'rota', 'label', 'clock'] as const;

/**
 * What an **unmeasured** wall draws for the agenda and the clock, in CSS
 * pixels on the glass.
 *
 * Measured on this fixture, and recorded rather than derived: every one of
 * these is a rem times whatever `fitToBox` did to the section it sits in, and
 * that product is not something a reader can work out from the stylesheet.
 * They are the rule-nine half of the arc-minute work — a household who has not
 * opened the wall's size setting gets these numbers, and this file is what
 * says so.
 *
 * **Every figure here moved when `fitToBox` went**, and two of the movements
 * are the point rather than noise. The **numeral** falls at every size (59.7 →
 * 44.9 at 1080x1920) because `.dr-num`'s rem fallback finally honours the 1.2x
 * ceiling this project's own design rules set for it. And the **800x480 title**
 * falls 16.6 → 14.0, which is the only run on the wall that got smaller: the
 * fit used to *grow* that section by 1.18x because its box had spare height,
 * and the spare height now buys five more events instead. Everything else is
 * within a percent of what it was, which is what says the rest of the wall did
 * not move.
 *
 * Two of them are worth reading on their own. The clock at 1080x1920 is
 * **99.8px against a 37.5px event name — 2.66x**, where this product's own
 * design rule says a clock may not be more than 1.8x an event, and the
 * portrait rule that was supposed to hold it (`calc(var(--t-event) * 1.8)`) is
 * beaten by the widget's box sizing. And the date numeral is **59.7px against
 * that same 37.5px — 1.59x**, the largest inversion left on the wall after the
 * month grid's was fixed. Neither is repaired here, because repairing them
 * would move a wall nobody measured; both are what the roles fix on a wall
 * somebody did.
 */
const AGENDA_BASELINE: Record<string, Record<(typeof DRAWN_RUNS)[number], number>> = {
  '480x800': { title: 15.6, time: 12.0, numeral: 18.7, weekday: 13.2, rota: 9.2, label: 10.0, clock: 41.6 },
  '800x480': { title: 14.0, time: 10.8, numeral: 16.8, weekday: 11.9, rota: 8.3, label: 9.0, clock: 25.3 },
  '1080x1920': { title: 37.4, time: 28.8, numeral: 44.9, weekday: 31.7, rota: 22.1, label: 24.0, clock: 99.8 },
  '1920x1080': { title: 31.6, time: 24.3, numeral: 37.9, weekday: 26.7, rota: 18.6, label: 20.3, clock: 56.9 },
  '2560x1440': { title: 42.1, time: 32.4, numeral: 50.5, weekday: 35.6, rota: 24.8, label: 27.0, clock: 75.8 },
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
         * so the tier pass measures the bars back out and the events return to
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

        /*
         * And **nothing on this wall moved at all**, which is rule nine rather
         * than a ratchet.
         *
         * The arc-minute scale replaced the type floor for the whole calendar
         * widget, and a household who has not opened the wall's size setting —
         * which is every household until they do — must get the wall they had
         * yesterday, to the name. That is why every use site in `display.css`
         * is `var(--t-wall-role, <what that selector drew before>)` with the
         * old expression written out as the fallback, and why `main.ts`
         * *removes* the properties rather than leaving stale ones behind: the
         * unmeasured wall reaches those fallbacks by the same mechanism in
         * both directions.
         *
         * Every one of the assertions above would pass a wall that quietly
         * drew *more*, which on this change would mean the roles had reached a
         * screen that never asked for them. The identity is the one that
         * cannot. It is deliberately stated on the counts and not on the two
         * share percentages, which are floats recorded to one decimal.
         *
         * A later phase that deliberately improves the unmeasured wall raises
         * this and `BASELINE` in the same commit — it is the same constant.
         */
        expect(
          {
            monthNamesVisible: measured.monthNamesVisible,
            distinctNames: measured.distinctNames,
            plusNCells: measured.plusNCells,
            markedCells: measured.markedCells,
            spanBars: measured.spanBars,
            runsUnderFloor: measured.runsUnderFloor,
            agendaDays: measured.agendaDays,
            agendaEvents: measured.agendaEvents,
          },
          `${key}: an unmeasured wall drew something other than what it drew before the arc-minute scale`,
        ).toEqual({
          monthNamesVisible: baseline.monthNamesVisible,
          distinctNames: baseline.distinctNames,
          plusNCells: baseline.plusNCells,
          markedCells: baseline.markedCells,
          spanBars: baseline.spanBars,
          runsUnderFloor: baseline.runsUnderFloor,
          agendaDays: baseline.agendaDays,
          agendaEvents: baseline.agendaEvents,
        });

        // And it reached none of the scale, which is what that identity is a
        // consequence of rather than a coincidence beside it.
        expect(measured.pxArcmin, `${key}: an unmeasured wall derived a scale`).toBeUndefined();

        /*
         * The agenda and the clock, at the size they are drawn, to within a
         * percent.
         *
         * The counts above cannot see either: an agenda draws the same two
         * days at any type size until it stops fitting, and the clock is not
         * in the month grid at all. These are the numbers a household would
         * notice first and the ones this phase moves on a measured wall, so
         * pinning them here is what makes "nothing changed" mean it.
         *
         * It caught something real. Fixing the specificity accident on
         * `:root[data-layout="landscape"] .clock` — which had been overriding
         * the widget's own box sizing on every landscape wall — moves the
         * unmeasured landscape clock from 25.3px to 37.4px unless the rule
         * that replaces it restates the rem expression first, and it is these
         * two sizes that say so rather than any count in the file.
         */
        const drawnBaseline = AGENDA_BASELINE[key];
        if (drawnBaseline === undefined) throw new Error(`no agenda baseline for ${key}`);
        for (const run of DRAWN_RUNS) {
          const now = measured.drawn[run];
          const before = drawnBaseline[run];
          expect(
            now,
            `${key}: an unmeasured wall draws ${run} at ${now.toFixed(1)}px, not the recorded ${before}px`,
          ).toBeGreaterThan(before * 0.99);
          expect(
            now,
            `${key}: an unmeasured wall draws ${run} at ${now.toFixed(1)}px, not the recorded ${before}px`,
          ).toBeLessThan(before * 1.01);
        }
      },
      SLOW,
    );
  }
});

/**
 * The same wall, once its household has said how large it is and how far away
 * they stand.
 *
 * This is the other half of the change and the half that has to *earn* it. The
 * block above proves an unmeasured wall did not move; this one measures the
 * one that did, at the same five sizes, on the same Classic seed, with the
 * same three family calendars.
 *
 * **The headline assertion is an angle, not a count.** Measured on the shipped
 * wall, the month's event text was 22.0px at 480x800, 22.0px at 1920x1080 and
 * 24.8px at 2560x1440 — one number across a 5.7x range of panel area, which is
 * the clearest possible statement that it was not a function of the wall it
 * was drawn on. On a measured wall every run in the grid is its role's cap
 * height in arc-minutes at *every* one of the five, which is the sentence this
 * phase exists to make true. It is also the assertion with the most reach: it
 * goes red if any of the seven sites reverts to the floor, if a role is
 * mistyped, if `main.ts` stops writing one, or if an ancestor transform starts
 * eating the grid — which is how the type-hierarchy pass's own floor was
 * quietly undermined once already.
 *
 * **`runsUnderFloor` is deliberately not carried into this block.** A count of
 * runs under 22px is a count of runs under the mechanism this phase retired:
 * on a measured 7.5" e-ink panel the *correct* event size is 16.9px, so the
 * number is 88 of 92 and means nothing. The angle assertion replaces it and is
 * strictly stronger — it pins the exact cap height rather than a lower bound.
 * The unmeasured block above still asserts it, because there 22px is still the
 * mechanism.
 */

/** Cap height as a fraction of the em — `CAP_RATIO` in `orientation.ts`. */
const CAP_RATIO = 0.71;

/**
 * What each run in the month grid is, in arc-minutes of cap height.
 *
 * Transcribed from `WALL_TYPE_CAPS` in `apps/display/src/orientation.ts`,
 * which this package cannot import — the seam `epaper-ladder-parity` and
 * `calendar-view-parity` already live at, for the reason they do (the display
 * bundle has no bundler and the server cannot reach into it). No parity check
 * is needed in this direction and one would be weaker than what is here: these
 * literals are the *specification*, and the assertion below holds a real drawn
 * wall to them, so moving a rung in `orientation.ts` turns this red rather
 * than agreeing with itself.
 */
/**
 * The agenda's and the clock's runs, in arc-minutes of cap height.
 *
 * The same transcription as `GRID_ROLE_ARCMIN` below and the same argument for
 * it. `clock` is 39.6 rather than the table's 40 because the rung is capped at
 * 1.8x the lede's 22' — the cap is the reason the ratio assertion further down
 * can be an equality rather than a hope.
 */
const AGENDA_ROLE_ARCMIN: readonly { readonly run: (typeof DRAWN_RUNS)[number]; readonly arcmin: number }[] = [
  { run: 'title', arcmin: 22 },
  { run: 'time', arcmin: 12 },
  { run: 'numeral', arcmin: 16 },
  { run: 'weekday', arcmin: 11 },
  { run: 'rota', arcmin: 11 },
  { run: 'label', arcmin: 10 },
];

/** The clock's own rung, after its cap. */
const CLOCK_ARCMIN = 39.6;

const GRID_ROLE_ARCMIN: readonly { readonly cls: string; readonly arcmin: number }[] = [
  { cls: 'hz-rowtext', arcmin: 14 },
  { cls: 'hz-spantext', arcmin: 14 },
  { cls: 'hz-num', arcmin: 16 },
  { cls: 'hz-head', arcmin: 11 },
  { cls: 'hz-more', arcmin: 11 },
  { cls: 'hz-wk', arcmin: 11 },
];

/**
 * A whisker, for the same reason `RATIO_SLACK` below is a whisker: a role is
 * emitted rounded to hundredths of a pixel and a browser resolves it again, so
 * an exact equality would go red on the rounding rather than on a wall.
 */
const ARCMIN_SLACK = 0.05;

/**
 * Today's numbers on a measured wall, and the same ratchet rule as `BASELINE`.
 *
 * Measured, before -> after, against the unmeasured wall recorded above:
 *
 *   |     viewport |         panel | distinct | names |  +N  | spans |
 *   |--------------|---------------|----------|-------|------|-------|
 *   |      480x800 |  7.5" e-ink   |   0 →  1 |  0→ 0 |  0→0 |   0→2 |
 *   |      800x480 |  7.5" e-ink   |   0 →  1 |  0→ 0 |  0→0 |   0→2 |
 *   |    1080x1920 |  32" TV       |   9 → 10 | 11→12 |  1→0 |   2→2 |
 *   |    1920x1080 |  32" TV       |   8 →  9 | 10→11 |  1→4 |   2→2 |
 *   |    2560x1440 |  43" TV       |   9 →  9 | 11→11 |  1→4 |   2→2 |
 *
 * Re-measured against the unmeasured wall the tiers left, so the two tables
 * read against each other rather than against two different trees. What the
 * tiers move here is smaller than on the wall nobody has measured, which is the
 * honest shape of it: a measured wall already draws its type at the reader's
 * angle, so the tier mostly agrees with what the box was doing and disagrees
 * where the *box* was the binding constraint rather than the type.
 *
 * Three columns need saying out loud, and the third is the one that would
 * otherwise read as a regression.
 *
 * **The two e-ink sizes name their first thing.** `spanBars` goes 0 → 2 at
 * both: at 22px a bar's lane is taller than a cell of that grid has, so
 * the trim measured every bar back out and the panel drew a month with
 * no words in it at all. At the event role's 16.9px the lane fits, the half
 * term is drawn once across its days, and `distinctNames` goes 0 → 1. It is
 * one name, and it is the first name either of those panels has ever had on
 * its grid.
 *
 * **`plusNCells` goes *up* at the two largest sizes, and that is the counter
 * getting cheaper rather than a name being lost.** A cell that can name
 * nothing draws no counter at all ("+3" alone is a number with
 * no subject), so a cell that starts naming something also becomes a cell that
 * can carry a count — which is the whole of 1920x1080, where names go 8 → 10
 * and counters 2 → 4. At 2560x1440 the names are unchanged and the counters
 * still go 1 → 4: `.hz-more` is the scaffold role there, 19.4px against the
 * event's 24.7, so a count now *fits* beside a name where before it could only
 * be had by taking the name off the glass. The metric's recorded direction was
 * written when a counter cost a name; it is asserted here paired with
 * `monthNamesVisible` and `distinctNames`, which is what makes a real loss
 * still fail.
 *
 * **2560x1440 names no more than it did**, and that is the scale disagreeing
 * with the wall rather than failing to improve it. A 43" panel read from 1.6
 * metres wants 24.7px for 14 arc-minutes, which is what it was already drawing
 * — so there is nothing for the grid to win there, and the assertion is that
 * it wins nothing rather than losing anything. Naming more at that size means
 * standing closer: at 1.2m the same panel measures 18.5px and names 13, and at
 * 1080x1920 a 32" panel read from 0.9m names 16. Those are households, not
 * levers, and this file does not get to pick one to make a number look better.
 */
/**
 * **Raised by the density tiers for the six widgets, and the two smallest sizes
 * move the worsening way on purpose.**
 *
 *   |     viewport | names | distinct |  +N  | days | events |
 *   |--------------|-------|----------|------|------|--------|
 *   |      480x800 |  0→ 0 |    1→ 1  | 0→ 0 | 2→ 1 |  6→  3 |
 *   |      800x480 |  0→ 0 |    1→ 1  | 0→ 0 | 2→ 2 |  6→  5 |
 *   |    1080x1920 | 12→14 |   10→12  | 0→ 3 | 2→ 3 |  6→ 10 |
 *   |    1920x1080 | 11→12 |    9→10  | 4→ 3 | 2→ 5 |  6→ 12 |
 *   |    2560x1440 | 11→12 |    9→10  | 4→ 3 | 2→ 6 |  6→ 14 |
 *
 * **A 43" television draws fourteen events over six days where it drew six over
 * two**, which is the sentence this whole line of work is for, and it is
 * measured on the same shipped seed with the same three family calendars.
 *
 * **480x800 and 800x480 lose events, and that is a decision being reversed
 * rather than a regression being blessed.** The paragraph this file replaced
 * said so explicitly: "at 480x800 and 800x480 the household's Classic box
 * genuinely cannot hold two days at 22' and the section shrinks to 0.62 and
 * 0.88 — which is the existing shrink-then-trim behaviour and the right one:
 * trimming instead would cost one of the two days to buy 13% of type". There is
 * no shrink now. A section is drawn at the size the reader needs or it is not
 * drawn, which is this project's own hard design rule — *a section that does
 * not fit gives up content, not points* — and the price on a 7.5" panel is one
 * day and three events. What the panel gets back is the other half of the
 * trade, and it is asserted a few lines down: **every run in the agenda is now
 * exactly its role's angle at all five sizes**, where before the two e-ink
 * panels could only be held to "not larger than".
 *
 * `plusNCells` rises at 1080x1920 (0→3) beside names 12→14, which is the
 * counter getting cheaper rather than a name being lost — the same pairing the
 * unmeasured table above argues, and the reason the two are asserted together.
 */
const MEASURED_BASELINE: Record<string, Omit<Baseline, 'runsUnderFloor'>> = {
  '480x800': {
    monthNamesVisible: 0,
    distinctNames: 1,
    plusNCells: 0,
    markedCells: 20,
    spanBars: 2,
    agendaDays: 1,
    agendaEvents: 3,
    canvasSharePercent: 93.5,
    contentSharePercent: 85.5,
  },
  '800x480': {
    monthNamesVisible: 0,
    distinctNames: 1,
    plusNCells: 0,
    markedCells: 20,
    spanBars: 2,
    agendaDays: 2,
    agendaEvents: 5,
    canvasSharePercent: 93.5,
    contentSharePercent: 80,
  },
  '1080x1920': {
    monthNamesVisible: 14,
    distinctNames: 12,
    plusNCells: 3,
    markedCells: 20,
    spanBars: 2,
    agendaDays: 3,
    agendaEvents: 10,
    canvasSharePercent: 99.5,
    contentSharePercent: 85.5,
  },
  '1920x1080': {
    monthNamesVisible: 12,
    distinctNames: 10,
    plusNCells: 3,
    markedCells: 20,
    spanBars: 2,
    agendaDays: 5,
    agendaEvents: 12,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
  '2560x1440': {
    monthNamesVisible: 12,
    distinctNames: 10,
    plusNCells: 3,
    markedCells: 20,
    spanBars: 2,
    agendaDays: 6,
    agendaEvents: 14,
    canvasSharePercent: 99.5,
    contentSharePercent: 80,
  },
};

describe('the same wall, once its household has measured it', () => {
  for (const size of VIEWPORTS) {
    const key = `${size.width}x${size.height}`;
    const baseline = MEASURED_BASELINE[key];
    const panel = MEASURED[key];
    if (baseline === undefined || panel === undefined) {
      throw new Error(`no measured baseline recorded for ${key}`);
    }

    it(
      `${key}: draws the grid at the reader's angle on a ${panel.label}`,
      async () => {
        const measured = await measureViewport(size, panel);
        const pxArcmin = measured.pxArcmin;

        expect(pxArcmin, `${key}: the page derived no scale from a measured wall`).toBeDefined();
        if (pxArcmin === undefined) return;

        /*
         * Every run in the grid, at its role's cap height in arc-minutes.
         *
         * Read off the drawn size — `measureMonthGrid`'s `fontPx` is the
         * cascade size times every ancestor transform — and divided by the
         * page's own `--px-arcmin`, so this is the angle a household's eye
         * actually meets rather than the number the stylesheet asked for.
         *
         * Checked by breaking each of the seven fixes in turn: reverting any
         * `var(--t-wall-role, …)` to the `max(…)` pair it replaced puts that
         * class back on the rem scale and this fails at every size at once,
         * naming the class and both numbers.
         */
        const runs = measured.gridRuns.filter((run) =>
          GRID_ROLE_ARCMIN.some((role) => run.where.split('.').includes(role.cls)),
        );
        expect(runs.length, `${key}: no role-driven runs in the grid at all`).toBeGreaterThan(0);
        for (const run of runs) {
          const role = GRID_ROLE_ARCMIN.find((candidate) =>
            run.where.split('.').includes(candidate.cls),
          );
          if (role === undefined) continue;
          const arcmin = (run.fontPx * CAP_RATIO) / pxArcmin;
          expect(
            arcmin,
            `${key}: ${run.where} is drawn at ${run.fontPx.toFixed(2)}px, which is ` +
              `${arcmin.toFixed(2)}' of cap height and not the ${role.arcmin}' its role is`,
          ).toBeCloseTo(role.arcmin, 1);
          expect(Math.abs(arcmin - role.arcmin)).toBeLessThanOrEqual(ARCMIN_SLACK);
        }

        /*
         * And the ratchet, on the same measurements the block above records —
         * more of the household's calendar on the glass, and never fewer of
         * the things a cell that can name nothing still says.
         */
        expect(
          measured.monthNamesVisible,
          `${key}: the measured wall named ${measured.monthNamesVisible} events, below the recorded ${baseline.monthNamesVisible}`,
        ).toBeGreaterThanOrEqual(baseline.monthNamesVisible);
        expect(
          measured.distinctNames,
          `${key}: the measured wall named ${measured.distinctNames} different events, below the recorded ${baseline.distinctNames}`,
        ).toBeGreaterThanOrEqual(baseline.distinctNames);
        expect(
          measured.plusNCells,
          `${key}: the measured wall drew ${measured.plusNCells} "+N" cells, above the recorded ${baseline.plusNCells}`,
        ).toBeLessThanOrEqual(baseline.plusNCells);
        expect(
          measured.markedCells,
          `${key}: ${measured.markedCells} cells carry a density mark, below the recorded ${baseline.markedCells}`,
        ).toBeGreaterThanOrEqual(baseline.markedCells);
        expect(
          measured.spanBars,
          `${key}: ${measured.spanBars} multi-day bars, below the recorded ${baseline.spanBars}`,
        ).toBeGreaterThanOrEqual(baseline.spanBars);
        expect(
          measured.agendaDays,
          `${key}: the agenda drew ${measured.agendaDays} days, below the recorded ${baseline.agendaDays}`,
        ).toBeGreaterThanOrEqual(baseline.agendaDays);
        expect(
          measured.agendaEvents,
          `${key}: the agenda drew ${measured.agendaEvents} events, below the recorded ${baseline.agendaEvents}`,
        ).toBeGreaterThanOrEqual(baseline.agendaEvents);
        expect(
          measured.canvasSharePercent,
          `${key}: the canvas filled ${measured.canvasSharePercent.toFixed(1)}% of the viewport, ` +
            `below the recorded ${baseline.canvasSharePercent}%`,
        ).toBeGreaterThanOrEqual(baseline.canvasSharePercent);
        expect(
          measured.contentSharePercent,
          `${key}: widgets covered ${measured.contentSharePercent.toFixed(1)}% of the canvas, ` +
            `below the recorded ${baseline.contentSharePercent}%`,
        ).toBeGreaterThanOrEqual(baseline.contentSharePercent);

        /*
         * The agenda, at the reader's angle — **or smaller where its box
         * cannot hold it, and never larger.**
         *
         * Both halves are the assertion. "Never larger" is the one that holds
         * everywhere and is the one the fit ceiling exists for: `fitToBox`
         * grows a section that fits (measured, 1.18x at 800x480 today), and a
         * transform multiplies straight through a font size, so without the
         * ceiling a role could move and the glass not move at all. "Equal" is
         * asserted only where the fit came out at 1, because at 480x800 and
         * 800x480 the household's Classic box genuinely cannot hold two days
         * at 22' and the section shrinks to 0.62 and 0.88 — which is the
         * existing shrink-then-trim behaviour and the right one: trimming
         * instead would cost one of the two days to buy 13% of type.
         */
        const fitted = measured.agendaFitsWhole;
        for (const { run, arcmin } of AGENDA_ROLE_ARCMIN) {
          const drawnPx = measured.drawn[run];
          const angle = (drawnPx * CAP_RATIO) / pxArcmin;
          expect(
            angle,
            `${key}: the agenda's ${run} is drawn at ${drawnPx.toFixed(1)}px, which is ` +
              `${angle.toFixed(2)}' of cap height — larger than the ${arcmin}' its role is`,
          ).toBeLessThanOrEqual(arcmin + ARCMIN_SLACK);
          if (fitted) {
            expect(
              angle,
              `${key}: the agenda fits its box whole, so its ${run} should be exactly ` +
                `${arcmin}' and is ${angle.toFixed(2)}'`,
            ).toBeGreaterThanOrEqual(arcmin - ARCMIN_SLACK);
          }
        }

        /*
         * And the clock, which is not in that section and is not scaled at all
         * — it sizes itself to its own box. So it has no "or smaller because
         * the section shrank" case: it is the role, or the box, whichever is
         * less.
         */
        const clockAngle = (measured.drawn.clock * CAP_RATIO) / pxArcmin;
        expect(
          clockAngle,
          `${key}: the clock is drawn at ${measured.drawn.clock.toFixed(1)}px, which is ` +
            `${clockAngle.toFixed(2)}' — larger than the ${CLOCK_ARCMIN}' its capped role is`,
        ).toBeLessThanOrEqual(CLOCK_ARCMIN + ARCMIN_SLACK);

        /*
         * The ratio this whole line of work is named for, measured **on the
         * glass** rather than in the cascade.
         *
         * The type-hierarchy pass could only assert the declared ratio and
         * said so at the time: "`fitToBox` scales a whole section
         * independently of its neighbours, so `.clock` and `.dr-ev-title`
         * sitting in differently-sized boxes can carry the right ratio in
         * their own `font-size` and still land nowhere near it on the glass —
         * measured, the Classic seed alone puts them at 2.44x". On this
         * fixture it is 2.66x, and `AGENDA_BASELINE` records that as what an
         * unmeasured wall still draws. Measured, the two are 1.80.
         *
         * **Where the agenda does not fit whole, this is not a fact about
         * either widget and is deliberately not asserted.** At 480x800 the
         * measured ratio is 2.53 — and neither half is too large: the clock is
         * drawn at 41.6px, which is its own *box* limit and under its 39.6'
         * role, while the agenda is squeezed to 0.62 of a 22' lede by a box
         * that cannot hold two days at that size. The ratio is broken by
         * Classic's proportions on a 7.5" panel, which is a layout decision
         * and a different change; what the roles can promise is that neither
         * widget draws larger than the reader needs, and that is asserted
         * unconditionally above.
         */
        if (fitted) {
          const clockRatio = measured.drawn.clock / measured.drawn.title;
          expect(
            clockRatio,
            `${key}: the clock is ${clockRatio.toFixed(2)}x the agenda's event name on the glass`,
          ).toBeLessThanOrEqual(1.8 * RATIO_SLACK);
        }
      },
      SLOW,
    );
  }
});

/**
 * A clock may not overflow the box a household dragged it into.
 *
 * This is the assertion the first pass of this work did not have, and the gap
 * was found the way this project finds them: by reverting a fix and watching
 * the suite stay green. `:root[data-layout="landscape"] .clock` is (0,3,0) and
 * `.fw-clock .clock` is (0,2,0), so on every landscape wall the clock widget
 * has never been sized by its own box — it took the stacked layout's rem
 * expression instead, and `--clock-chars` has been inert there since the day
 * it was written. Give the clock an arc-minute role through that rule and it
 * is a size with no box term beside it at all.
 *
 * **A 24-hour clock hides it and a 12-hour clock does not**, which is the
 * whole reason `--clock-chars` exists: "20:26" is five characters and
 * "08:26 pm" is eight, so the same type size that fits one runs a third of the
 * way out of the box for the other. The measured wall is what makes it
 * reachable — the role asks for 47.7px where the box's own eight-character
 * term allows 28.6 — so this is a real fault of the change rather than a
 * pre-existing one being tidied.
 *
 * Measured as `scrollWidth` past `clientWidth`, not as a rectangle past a
 * rectangle — and that correction is the second half of the same lesson.
 * `.clock` is a block, so its border box is the width its parent gives it
 * whatever is inside; `white-space: nowrap` is on it precisely so an oversized
 * clock *clips* rather than wrapping, which means neither its own rect nor a
 * line break says anything at all. The first draft of this test held the rects
 * against each other, passed with the fix reverted, and only went red for the
 * wrong reason — because the broken revert also took `nowrap` with it. The
 * overflow of the text inside the element is the only thing that can see this.
 */
describe('a 12-hour clock on a measured landscape wall', () => {
  it('fits the box it was dragged into', async () => {
    const panel = MEASURED['800x480'] as PanelFacts;
    wall.db.prepare('UPDATE screens SET clock_24 = 0 WHERE id = ?').run(screenId);
    try {
      measureScreen(panel);
      const { page, close } = await loadWallSettled(link, { width: 800, height: 480 });
      try {
        const clock = await page.evaluate(() => {
          const face = document.querySelector('#wall .canvas .fw-clock .clock');
          const box = face?.closest('.fw');
          if (!(face instanceof HTMLElement) || !(box instanceof HTMLElement)) return undefined;
          const style = getComputedStyle(box);
          const rect = face.getBoundingClientRect();
          const inner = box.getBoundingClientRect();
          return {
            text: (face.textContent ?? '').trim(),
            fontPx: parseFloat(getComputedStyle(face).fontSize),
            // The digits themselves, past the element that clips them.
            overWide: face.scrollWidth - face.clientWidth,
            // And the element past the box, which a taller clock still does.
            overTall:
              rect.bottom - (inner.bottom - parseFloat(style.paddingBottom || '0')),
          };
        });
        expect(clock, 'no clock widget on the wall').toBeDefined();
        if (clock === undefined) return;
        // The setting reached the wall at all: without this the test would
        // pass on a 24-hour clock, which is the case that cannot fail.
        expect(clock.text, 'the wall is not drawing a 12-hour clock').toMatch(/[ap]m/i);
        expect(
          clock.overWide,
          `the clock "${clock.text}" at ${clock.fontPx.toFixed(1)}px is ` +
            `${clock.overWide.toFixed(1)}px wider than the box that clips it`,
        ).toBeLessThanOrEqual(1);
        expect(
          clock.overTall,
          `the clock "${clock.text}" at ${clock.fontPx.toFixed(1)}px runs ` +
            `${clock.overTall.toFixed(1)}px below its box`,
        ).toBeLessThanOrEqual(1);
      } finally {
        await close();
      }
    } finally {
      wall.db.prepare('UPDATE screens SET clock_24 = 1 WHERE id = ?').run(screenId);
      measureScreen(undefined);
    }
  }, SLOW);
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
 *  - a real month cell's `.hz-rowtext`, which the tier pass may hide
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

async function measureRatios(
  size: { readonly width: number; readonly height: number },
  panel?: PanelFacts,
): Promise<{ readonly numeralRatio: number; readonly clockRatio: number }> {
  measureScreen(panel);
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

/**
 * A measured wall for the ratio block.
 *
 * One panel for all three viewports on purpose: what is under test here is the
 * *ratio*, which the arc-minute scale makes a property of the table (16'/14'
 * and the clock's cap) rather than of the screen — so measuring three
 * viewports against one household is exactly the question "does the hierarchy
 * survive being drawn somewhere else". 1280x720 is not one of the five sizes
 * above and carries no preset of its own, which is the second reason not to
 * pair a panel to each.
 */
const RATIO_PANEL = MEASURED['1920x1080'] as PanelFacts;

describe('the type hierarchy, on the same paired wall', () => {
  for (const { label, width, height } of RATIO_VIEWPORTS) {
    for (const [state, panel] of [
      ['unmeasured', undefined],
      ['measured', RATIO_PANEL],
    ] as const) {
      it(
        `holds both ratios in ${label}, ${state}`,
        async () => {
          const { numeralRatio, clockRatio } = await measureRatios({ width, height }, panel);
          /*
           * On a measured wall this is 16'/14' = 1.143 and is a fact about the
           * table rather than about the wall — which is the point, and is what
           * "size-independent" means: the rem version could only ever hold the
           * ratio at one design height, and held it by being written as a
           * multiplication. Both states are asserted because both ship: every
           * household is unmeasured until they open the setting.
           */
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
  }
});
