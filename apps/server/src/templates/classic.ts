import type { DisplayTemplate } from '../api/templates.js';

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
