import type { DisplayTemplate } from '../api/templates.js';
import { widgetIsSetUp, type HouseholdSetUp } from '../api/manifest.js';

/**
 * The Classic layout: the kitchen calendar Maverick Wall has always drawn, now
 * expressed as freeform widgets rather than a bespoke stacked renderer.
 *
 * This is the universal default — what a new or untouched display shows, and
 * what every wall was migrated onto when the "auto" stacked layout was retired
 * (see `backfillClassic`). So, unlike every other template, it sets **no theme
 * and no background**: it must keep whatever theme the wall already has, the way
 * the old stacked layout did. It is a faithful *approximation* of that layout —
 * the clock and today's rota up top, the forecast, an agenda of what's next, and
 * the month grid — built only from widgets a household could place by hand, so
 * it is a real starting point they can rearrange, not a special case.
 *
 * **The month was the anchor and it should not have been**, and rebalancing it
 * is the whole of this file. It used to take 45% of the portrait height and the
 * entire right-hand column in landscape, while the agenda took 20% and 7.8%.
 * Measured on a paired wall carrying three ordinary family calendars, a rota and
 * a forecast, that put **17 of the agenda's 28 text runs below the 22px
 * legibility floor** in portrait — "Upcoming" at 15.0px, the rota chip at
 * 13.8px — and 19 of 21 in landscape, where three event titles were cut to 35%,
 * 38% and 44% of their strings.
 *
 * The mechanism is worth writing down, because it is invisible in the CSS. Every
 * widget whose body is a section reused from the stacked layout — the agenda,
 * the forecast, the rota badge — is laid out at its box width and then
 * `transform: scale()`d to fill the box. A transform multiplies straight through
 * `max(…, var(--t-floor))`, so **the 22px floor does not survive scale-to-fit**.
 * The month grid is the one widget that fills its box instead of being scaled
 * (`fw-fill`), which is exactly why it was the only thing on the wall with
 * nothing under the floor at any size — it *cannot* go under it, so it looked
 * fine while everything beside it quietly did not. A bigger box is the only
 * lever a template has on that.
 *
 * **In portrait almost all of it came out of slack, which is the surprise.**
 * The obvious move is to take the height off the month, and there is a hard
 * floor under that: below about 0.40 of the portrait height a cell has no room
 * for a row under its date number, and a row is where the *calendar's colour*
 * lives — the dot on a timed event, the rule down an all-day one. Take the
 * month under it and the grid stops saying not just what is on but **whose**,
 * which is most of what a family wall is for. Measured, a household loses
 * colours outright at 0.35 and 0.36; at 0.38 it keeps them only on a good draw,
 * because the grid trims *once*, at first draw, against whatever font metrics
 * have arrived by then — so a wall that boots cold on a busy box keeps a worse
 * trim until something redraws it. (`browser-source-colours.test.ts` is the
 * guard, and it measures the *shipped* wall rather than a widget nobody has.)
 *
 * So the month gives up almost nothing — 0.45 to 0.435 — and the agenda's extra
 * height comes from the roughly 0.09 of the wall that was sitting in gaps and
 * margins: the bottom margin was 0.03, the band above the agenda carried three
 * separate 0.02-ish gaps, and the forecast gave a token 0.005. The agenda goes
 * from 0.20 to 0.305 of the height — **a little over half as much again** — and
 * every one of its runs clears the floor. Nothing else on the wall was made
 * smaller by more than a rounding error.
 *
 * Portrait therefore stops at a peer rather than an anchor: the month is still
 * fractionally the larger box. Landscape has width to spare, so there the
 * agenda really does become the anchor.
 *
 * Measured after, on the same wall: the portrait agenda has **no run below the
 * floor** (smallest 22.5px, up from 13.8px) while the month keeps every calendar
 * colour it had; landscape cuts **no** titles where it cut three, its forecast
 * goes from 15 runs under the floor to 5, and its agenda holds 37.4% of the
 * canvas against the month's 28.8% — where it used to hold 7.8% against 55.8%.
 *
 * Every number here was chosen by rendering a real wall and measuring it, never
 * by arithmetic — `test/browser-classic-proportions.test.ts` is that measurement.
 * The fit is a step function, so interpolating between these values does not give
 * you a layout between these outcomes.
 */
export const template: DisplayTemplate = {
  id: 'classic',
  name: 'Classic',
  category: 'home',
  blurb: 'The standard kitchen calendar — clock, rota, weather, what’s next and the month.',
  // No theme, no background: Classic inherits the wall's own theme (see above).
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.02, w: 0.5, h: 0.1 },
      { type: 'shift', x: 0.57, y: 0.02, w: 0.38, h: 0.12 },
      { type: 'weather', x: 0.05, y: 0.125, w: 0.9, h: 0.115 },
      /*
       * Six, not eight. The count is part of the legibility budget rather than a
       * setting beside it: the section is scaled to fit, so two more rows is a
       * shorter scale factor on every character in the widget. Measured in this
       * box, eight events put the rota chip under the floor and six clear it —
       * which is the grid's own rule ("give up a row rather than a point") one
       * widget along. A household who wants more asks for more.
       *
       * What the count cannot fix is a *thin* week. Measured, four events and
       * five and six all scale identically in a given box: the agenda's height
       * is mostly its day headers, so what sets the type is how many days the
       * events are spread over, and no template geometry reaches that. The floor
       * is cleared for a household with a busy few days, which is the wall this
       * layout is drawn for.
       *
       * 0.305 is not a tidy number and is not meant to be. The rota chip lands
       * at 21.7px at 0.30 — three tenths of a pixel under the floor — and at
       * 22.5px here, which is the first height with any margin at all.
       */
      { type: 'calendar', x: 0.05, y: 0.245, w: 0.9, h: 0.305, config: { mode: 'list', count: 6 } },
      /*
       * 0.435 rather than 0.45: the smallest trim that buys the agenda its last
       * rung without taking the grid anywhere near the height at which its cells
       * stop painting a calendar colour. The margin is deliberate — see the
       * first-draw trim race above, which is why this is not tuned to the cliff.
       *
       * No `cellEvents`: the month takes the default cell treatment, which is
       * flat event names. It used to say `pills` here, and that made Classic
       * the wall the pill measurements were taken on — 37 titles, 32 of them
       * clipped, the worst showing 26% of its string. A template that names the
       * treatment is a template that cannot follow the default when the default
       * is corrected.
       */
      { type: 'calendar', x: 0.05, y: 0.555, w: 0.9, h: 0.435, config: { mode: 'month' } },
    ],
  },
  /*
   * Landscape is not portrait rearranged, and the utility strip is why.
   *
   * The old landscape stacked the clock, the rota, the forecast and the agenda
   * down one 26%-wide column, which starved all four: the forecast is a
   * horizontal strip of days, and in a 499px column it drew 15 of its 20 runs
   * below the floor. Moving those three into a strip across the top gives each
   * of them the shape it wants, frees the whole body of the wall for the two
   * calendar views, and takes the forecast from 15 runs under the floor to 5.
   *
   * The agenda gets the wider of the two columns and the month the narrower —
   * the inversion, again — but the month keeps enough width here to go on naming
   * events, which portrait cannot afford: 130px-tall cells at 1920x1080 name 10
   * of 17 busy cells. That asymmetry between the two orientations is deliberate
   * and measured, not an oversight.
   */
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.03, y: 0.04, w: 0.22, h: 0.16 },
      { type: 'weather', x: 0.27, y: 0.04, w: 0.45, h: 0.16 },
      { type: 'shift', x: 0.75, y: 0.04, w: 0.22, h: 0.16 },
      { type: 'calendar', x: 0.03, y: 0.24, w: 0.52, h: 0.72, config: { mode: 'list', count: 6 } },
      { type: 'calendar', x: 0.57, y: 0.24, w: 0.4, h: 0.72, config: { mode: 'month' } },
    ],
  },
};

/**
 * The same kitchen calendar for a household that has not set everything up.
 *
 * `template` above is Classic for a household with a location *and* a rota. It
 * is also the layout every fresh install is seeded with, and most of them have
 * neither — so measured on a paired 1080x1920 wall with one calendar added and
 * nothing else configured, the wall drew the clock at y=58..250, then **nothing
 * at all until y=576**, where the agenda starts. A 280px hole, and 19% of the
 * wall's height in empty bands of 120px or more.
 *
 * Nothing was broken: the manifest drops a widget the household has nothing
 * behind (`widgetIsSetUp`), which is the honest answer — a Weather box that can
 * only ever say "Nothing to show yet." is a sentence about somebody's admin
 * printed on their kitchen calendar. But a free-form canvas is *absolutely
 * positioned*, so a dropped box leaves its space behind. The old responsive
 * layout reflowed and this one cannot, which is the trade that made it worth
 * having: what you dragged is what is drawn.
 *
 * So the adaptation moves to the one moment it is safe — **seeding**. A canvas
 * is chosen once, from what the household actually has, and is a plain
 * arrangement of boxes they can drag afterwards like any other. There is no
 * reflow at draw time and no second opinion about geometry: the wall draws the
 * rows it is given, exactly as before.
 *
 * Four arrangements, because Classic has exactly two widgets whose prerequisite
 * lives on another screen: the forecast (a location) and the rota badge (a
 * rotation). The key is derived from `widgetIsSetUp` rather than from a second
 * reading of the same settings — one opinion about "is this set up", shared
 * with the manifest that will later decide whether to draw it. That is what
 * makes the seeded canvas *complete*: every box in it is one the manifest keeps,
 * so there is nothing left to omit and nothing left to leave a hole.
 * `classic-variants.test.ts` asserts exactly that, for all four.
 *
 * **The reclaimed height goes to the month, and the agenda never moves off the
 * 0.305 the rebalance above settled on.** That is measured, and it is the
 * opposite of what the arithmetic suggests. The month *fills* its box
 * (`fw-fill`), so height there becomes rows of event names on the glass. The
 * agenda is laid out at its box width and `transform: scale()`d to fit, and
 * `fitToBox` re-flows a section that fits its box to the box's *aspect* before
 * scaling up — so a taller box at the same width re-flows the agenda narrower,
 * its rows wrap, and the final scale factor comes out **smaller**. Measured on
 * a calendar-only 1080x1920 wall: giving the agenda 0.354 instead of 0.305 took
 * its section label from 15.7px to 15.2px. More height, smaller type.
 * `browser-empty-bands.test.ts` holds the whole variant to that, class by class,
 * against the wall Classic itself was measured on.
 *
 * Landscape therefore changes in one way only: whatever is left in the top
 * strip widens to fill it. The two calendar columns are Classic's own in all
 * four variants.
 *
 * Margins and gaps are Classic's own — 0.02 above, 0.005 between, 0.01 below —
 * which is what keeps the total empty height at 3.5-4.5% of the portrait wall in
 * every variant, where the unconfigured wall was at 19% in bands of 120px alone.
 */

/** Classic's two calendar views, so a variant cannot drift from the original. */
const AGENDA = { mode: 'list', count: 6 } as const;
const MONTH = { mode: 'month' } as const;

/** The clock alone in the top band takes its whole width; `fitToBox` centres it. */
const PORTRAIT_CLOCK_WIDE = { type: 'clock', x: 0.05, y: 0.02, w: 0.9, h: 0.1 } as const;
const PORTRAIT_CLOCK = { type: 'clock', x: 0.05, y: 0.02, w: 0.5, h: 0.1 } as const;
const PORTRAIT_SHIFT = { type: 'shift', x: 0.57, y: 0.02, w: 0.38, h: 0.12 } as const;
const PORTRAIT_WEATHER = { type: 'weather', x: 0.05, y: 0.125, w: 0.9, h: 0.115 } as const;

/**
 * One variant, keyed by what the household has: `w` a location, `s` a rota.
 *
 * `ws` is `template` above, reused rather than re-typed — a copy would be a
 * second set of numbers to keep in step with the measurement that chose them.
 */
type ClassicKey = 'ws' | 'w-' | '-s' | '--';

const VARIANT_CANVASES: Readonly<Record<ClassicKey, Pick<DisplayTemplate, 'portrait' | 'landscape'>>> = {
  ws: { portrait: template.portrait, landscape: template.landscape },

  /*
   * A location and no rota — the commonest wall after a completed wizard, which
   * asks for a location and does not ask for a rota. Only the top band changes:
   * the clock takes the width the badge had, and the three rows below it are
   * Classic's own, untouched.
   */
  'w-': {
    portrait: {
      aspect: 0.5625,
      widgets: [
        PORTRAIT_CLOCK_WIDE,
        PORTRAIT_WEATHER,
        { type: 'calendar', x: 0.05, y: 0.245, w: 0.9, h: 0.305, config: AGENDA },
        { type: 'calendar', x: 0.05, y: 0.555, w: 0.9, h: 0.435, config: MONTH },
      ],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0.03, y: 0.04, w: 0.22, h: 0.16 },
        // The forecast is a horizontal strip of days, so the freed width is
        // worth more to it than to anything else in the band.
        { type: 'weather', x: 0.27, y: 0.04, w: 0.7, h: 0.16 },
        { type: 'calendar', x: 0.03, y: 0.24, w: 0.52, h: 0.72, config: AGENDA },
        { type: 'calendar', x: 0.57, y: 0.24, w: 0.4, h: 0.72, config: MONTH },
      ],
    },
  },

  /*
   * A rota and no location. The top band keeps its two boxes exactly where they
   * are — moving the badge would be a change nobody asked for — and the
   * forecast's 0.115 band goes to the month.
   */
  '-s': {
    portrait: {
      aspect: 0.5625,
      widgets: [
        PORTRAIT_CLOCK,
        PORTRAIT_SHIFT,
        { type: 'calendar', x: 0.05, y: 0.145, w: 0.9, h: 0.305, config: AGENDA },
        { type: 'calendar', x: 0.05, y: 0.455, w: 0.9, h: 0.535, config: MONTH },
      ],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0.03, y: 0.04, w: 0.45, h: 0.16 },
        { type: 'shift', x: 0.52, y: 0.04, w: 0.45, h: 0.16 },
        { type: 'calendar', x: 0.03, y: 0.24, w: 0.52, h: 0.72, config: AGENDA },
        { type: 'calendar', x: 0.57, y: 0.24, w: 0.4, h: 0.72, config: MONTH },
      ],
    },
  },

  /*
   * Neither — a fresh install with one calendar on it, which is the state every
   * install passes through and the wall the 280px hole was measured on.
   *
   * The clock takes the band and the month takes the height. Portrait's month
   * reaches 0.555 of the wall, which is more than the 0.45 the rebalance above
   * cut it back from — and that is not a reversal of it. The rebalance took
   * height off the month *to give it to the agenda*, whose type was under the
   * floor; here the agenda is already at the height that measurement settled
   * on, and the choice is between the month and empty wall.
   */
  '--': {
    portrait: {
      aspect: 0.5625,
      widgets: [
        PORTRAIT_CLOCK_WIDE,
        { type: 'calendar', x: 0.05, y: 0.125, w: 0.9, h: 0.305, config: AGENDA },
        { type: 'calendar', x: 0.05, y: 0.435, w: 0.9, h: 0.555, config: MONTH },
      ],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0.03, y: 0.04, w: 0.94, h: 0.16 },
        { type: 'calendar', x: 0.03, y: 0.24, w: 0.52, h: 0.72, config: AGENDA },
        { type: 'calendar', x: 0.57, y: 0.24, w: 0.4, h: 0.72, config: MONTH },
      ],
    },
  },
};

const variant = (key: ClassicKey): DisplayTemplate => ({
  ...template,
  portrait: VARIANT_CANVASES[key].portrait,
  landscape: VARIANT_CANVASES[key].landscape,
});

/**
 * Every arrangement this build seeds, in one list.
 *
 * The re-seed on boot recognises a canvas as *ours and untouched* by comparing
 * it against exactly these, so this list is the whole definition of "a wall
 * nobody has arranged". A variant added here is one a boot may rewrite; that is
 * the reason it is an export rather than a private table.
 */
export const CLASSIC_VARIANTS: readonly DisplayTemplate[] = [
  variant('ws'),
  variant('w-'),
  variant('-s'),
  variant('--'),
];

/**
 * The Classic arrangement matching what this household has actually set up.
 *
 * `widgetIsSetUp` is the *same* function the manifest filters with, deliberately
 * — asking the settings a second time here is how two readers of one stored
 * value come to disagree, which is this repository's most repeated bug.
 */
export function classicFor(setUp: HouseholdSetUp): DisplayTemplate {
  const key = `${widgetIsSetUp('weather', setUp) ? 'w' : '-'}${
    widgetIsSetUp('shift', setUp) ? 's' : '-'
  }` as ClassicKey;
  return variant(key);
}
