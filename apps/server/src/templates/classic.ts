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
 * **The rectangles tile the canvas, and that is the whole of what changed most
 * recently.** They used to carry a 5% side margin *and* a gap between boxes *and*
 * the `.fw` padding every box already has — three separate whitespaces stacked on
 * top of each other, so a third of the wall was gutter and slack rather than
 * calendar (measured: 63.6% of a 1080x1920 canvas carried content, 66.2% at
 * 1920x1080). The boxes now share edges and reach the canvas edge, and the one
 * gutter a household sees is the space between two boxes' *content* — which is
 * twice the `.fw` padding and nothing else. Measured after, content covers
 * upwards of 80% of the canvas in both orientations, and there is no band of dead
 * wall left to reclaim.
 *
 * **The proportions were re-derived against the density tiers, not against
 * scale-to-fit.** The month used to be tuned to a 22px absolute floor and the
 * agenda to whatever `transform: scale()` a box happened to grow it by — both of
 * which are gone (`fitToBox` is deleted; the calendar reads the reader's own
 * angle, and each widget takes a *form* from its box). So the split between the
 * agenda and the month is now a fact about two tier decisions, measured directly
 * on a real wall:
 *
 *   - **The agenda's floor.** On a wall nobody has measured the agenda is drawn
 *     at the rem scale, and below about 0.30 of the portrait height its smallest
 *     run — the rota chip — falls under the 22px legibility floor. So the agenda
 *     keeps 0.33, which clears it (`browser-classic-proportions.test.ts` asserts
 *     no run under the floor, and is the measurement that found the number).
 *   - **The month's colour.** A month cell paints a calendar's colour only on an
 *     event row (a dot on a timed event, a rule down an all-day one), and a cell
 *     with no room for a row under its date numeral drops to M0 and says only
 *     *that* a day is busy, not *whose*. The old derivation put that cliff at
 *     0.38 of the portrait height; with the numeral demoted (it is 1.2x the
 *     event text now, not 1.85rem) and the type distance-derived, the month at
 *     0.48 clears it with room to spare and every busy cell keeps its colour.
 *
 * (4) and (5) of `browser-classic-proportions.test.ts` pull in opposite
 * directions on purpose — the agenda wants height, the month wants height — and
 * between them there is one band of month heights that satisfies both. Every
 * number here was chosen by rendering a real wall with three ordinary family
 * calendars and measuring it, never by arithmetic; the fit is a step function
 * (a tier, literally), so interpolating between these values does not give a
 * layout between these outcomes.
 *
 * **A screen whose panel facts are set is seeded at its panel's own aspect**, so
 * there is no letterbox to lose a further band to (`classicSeed` in
 * `api/templates.ts`). The aspects below are the nominal 9:16 and 16:9 a wall
 * nobody has measured gets, and the ones the template gallery offers.
 */

/**
 * The portrait bands, as fractions of the canvas height. They tile it — the four
 * add to 1.0 with the month taking the remainder — so a change here is a change
 * to the split and never to the total.
 *
 * `TOP_H` is the clock (and, beside it, the rota badge); `WEATHER_H` the forecast
 * strip; `AGENDA_H` the "what's next" list. These three were measured to the
 * agenda's floor above; the month is 1 - their sum, and its colour was the check
 * that the remainder is enough.
 */
const TOP_H = 0.09;
const WEATHER_H = 0.1;
const AGENDA_H = 0.33;
/** The clock's share of the top band when a rota badge sits beside it. */
const CLOCK_W = 0.56;

/**
 * The landscape strip and columns. The utility widgets go in a strip across the
 * top — a forecast is a horizontal strip of days and starves in a narrow column
 * — and the two calendar views take the body as two columns. The agenda gets the
 * wider one (it reads best) and the month the narrower, which is the inversion
 * portrait cannot afford; the month still keeps enough width here to name events.
 */
const LAND_STRIP_H = 0.11;
const LAND_AGENDA_W = 0.56;

/** Classic's two calendar views, so a variant cannot drift from the original. */
const AGENDA = { mode: 'list' } as const;
const MONTH = { mode: 'month' } as const;

const P_AGENDA_Y_WITH_WEATHER = TOP_H + WEATHER_H;
const P_MONTH_Y_WITH_WEATHER = P_AGENDA_Y_WITH_WEATHER + AGENDA_H;
const P_MONTH_Y_NO_WEATHER = TOP_H + AGENDA_H;

const LAND_BODY_H = 1 - LAND_STRIP_H;

/**
 * The two calendar columns of the landscape body — Classic's own, in every
 * variant. Only the top strip changes with what the household has.
 */
const LAND_AGENDA = { type: 'calendar', x: 0, y: LAND_STRIP_H, w: LAND_AGENDA_W, h: LAND_BODY_H, config: AGENDA } as const;
const LAND_MONTH = {
  type: 'calendar',
  x: LAND_AGENDA_W,
  y: LAND_STRIP_H,
  w: 1 - LAND_AGENDA_W,
  h: LAND_BODY_H,
  config: MONTH,
} as const;

/**
 * The portrait agenda and month, as the tiling bands place them. `weather` picks
 * whether the forecast strip is present, which moves the agenda up and the month
 * with it.
 */
const portraitCalendars = (weather: boolean) => [
  {
    type: 'calendar' as const,
    x: 0,
    y: weather ? P_AGENDA_Y_WITH_WEATHER : TOP_H,
    w: 1,
    h: AGENDA_H,
    config: AGENDA,
  },
  {
    type: 'calendar' as const,
    x: 0,
    y: weather ? P_MONTH_Y_WITH_WEATHER : P_MONTH_Y_NO_WEATHER,
    w: 1,
    h: 1 - (weather ? P_MONTH_Y_WITH_WEATHER : P_MONTH_Y_NO_WEATHER),
    config: MONTH,
  },
];

const PORTRAIT_CLOCK_WIDE = { type: 'clock', x: 0, y: 0, w: 1, h: TOP_H } as const;
const PORTRAIT_CLOCK = { type: 'clock', x: 0, y: 0, w: CLOCK_W, h: TOP_H } as const;
const PORTRAIT_SHIFT = { type: 'shift', x: CLOCK_W, y: 0, w: 1 - CLOCK_W, h: TOP_H } as const;
const PORTRAIT_WEATHER = { type: 'weather', x: 0, y: TOP_H, w: 1, h: WEATHER_H } as const;

export const template: DisplayTemplate = {
  id: 'classic',
  name: 'Classic',
  category: 'home',
  blurb: 'The standard kitchen calendar — clock, rota, weather, what’s next and the month.',
  // No theme, no background: Classic inherits the wall's own theme (see above).
  portrait: {
    aspect: 0.5625,
    widgets: [PORTRAIT_CLOCK, PORTRAIT_SHIFT, PORTRAIT_WEATHER, ...portraitCalendars(true)],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.26, h: LAND_STRIP_H },
      { type: 'weather', x: 0.26, y: 0, w: 0.48, h: LAND_STRIP_H },
      { type: 'shift', x: 0.74, y: 0, w: 0.26, h: LAND_STRIP_H },
      LAND_AGENDA,
      LAND_MONTH,
    ],
  },
};

/**
 * The same kitchen calendar for a household that has not set everything up.
 *
 * `template` above is Classic for a household with a location *and* a rota. It
 * is also the layout every fresh install is seeded with, and most of them have
 * neither — so a Weather box or a Shift box would draw a permanent "nothing yet"
 * apology, or (since the manifest drops a widget the household has nothing behind
 * — `widgetIsSetUp`) leave a hole, because a free-form canvas is absolutely
 * positioned and a dropped box leaves its space behind.
 *
 * So the canvas is chosen at seed time from what the household actually has, and
 * is a plain arrangement of boxes they can drag afterwards. Four arrangements,
 * because Classic has exactly two widgets whose prerequisite lives on another
 * screen: the forecast (a location) and the rota badge (a rotation). The key is
 * derived from `widgetIsSetUp` — the *same* function the manifest filters with —
 * so every box in the seeded canvas is one the manifest keeps and there is
 * nothing left to leave a hole. `classic-variants.test.ts` asserts exactly that.
 *
 * The reclaimed band goes to the month, and the agenda never moves off the 0.33
 * the tiling above settled on: the month *fills* its box, so height there is rows
 * of event names on the glass, while the agenda draws the events its box affords
 * and a taller box past that point is drawing nothing more.
 */

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
      widgets: [PORTRAIT_CLOCK_WIDE, PORTRAIT_WEATHER, ...portraitCalendars(true)],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0, y: 0, w: 0.26, h: LAND_STRIP_H },
        // The forecast is a horizontal strip of days, so the freed width is
        // worth more to it than to anything else in the strip.
        { type: 'weather', x: 0.26, y: 0, w: 0.74, h: LAND_STRIP_H },
        LAND_AGENDA,
        LAND_MONTH,
      ],
    },
  },

  /*
   * A rota and no location. The top band keeps its two boxes where they are, and
   * the forecast's band goes to the month.
   */
  '-s': {
    portrait: {
      aspect: 0.5625,
      widgets: [PORTRAIT_CLOCK, PORTRAIT_SHIFT, ...portraitCalendars(false)],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0, y: 0, w: 0.5, h: LAND_STRIP_H },
        { type: 'shift', x: 0.5, y: 0, w: 0.5, h: LAND_STRIP_H },
        LAND_AGENDA,
        LAND_MONTH,
      ],
    },
  },

  /*
   * Neither — a fresh install with one calendar on it, which is the state every
   * install passes through. The clock takes the strip and the month takes the
   * reclaimed height: portrait's month reaches 0.58 of the wall, which is more
   * than the ws month's 0.48, and that is not a reversal of the split. The agenda
   * is already at the height its floor needs; the choice for the rest is between
   * the month and empty wall.
   */
  '--': {
    portrait: {
      aspect: 0.5625,
      widgets: [PORTRAIT_CLOCK_WIDE, ...portraitCalendars(false)],
    },
    landscape: {
      aspect: 1.7778,
      widgets: [
        { type: 'clock', x: 0, y: 0, w: 1, h: LAND_STRIP_H },
        LAND_AGENDA,
        LAND_MONTH,
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
