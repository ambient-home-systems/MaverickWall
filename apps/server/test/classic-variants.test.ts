/**
 * The four Classic arrangements, and the property that makes them worth having.
 *
 * A free-form canvas is absolutely positioned, so a box the manifest later drops
 * — a forecast with no location, a rota badge with no rotation — does not close
 * up, it leaves a hole. Measured on a paired 1080x1920 wall with one calendar
 * and nothing else configured, the shipped Classic drew the clock, then nothing
 * at all for 280px, then the agenda.
 *
 * The fix is to seed a canvas that has nothing to drop, so the claim under test
 * is not "these look nice" — it is **completeness**: for each variant, every box
 * in it survives the very filter that made the hole. That is checkable without a
 * browser and it is what the geometry rests on; `browser-empty-bands.test.ts` is
 * the measurement of the pixels.
 */
import { describe, expect, it } from 'vitest';
import { templateSchema, type DisplayTemplate } from '../src/api/templates.js';
import { CLASSIC_VARIANTS, classicFor, template as CLASSIC } from '../src/templates/classic.js';
import { keepWidgetsWithSomethingToSay, widgetIsSetUp, type HouseholdSetUp } from '../src/api/manifest.js';

/** The four set-up states a household can be in, as far as Classic can see. */
const STATES: readonly { readonly label: string; readonly setUp: HouseholdSetUp }[] = [
  { label: 'a location and a rota', setUp: { modules: ['weather'], shift: true } },
  { label: 'a location, no rota', setUp: { modules: ['weather'], shift: false } },
  { label: 'a rota, no location', setUp: { modules: [], shift: true } },
  { label: 'neither — a fresh install', setUp: { modules: [], shift: false } },
];

const ORIENTATIONS = ['portrait', 'landscape'] as const;

describe('the Classic variants', () => {
  it('are all valid templates', () => {
    for (const variant of CLASSIC_VARIANTS) {
      const parsed = templateSchema.safeParse(variant);
      expect(parsed.success, `${variant.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('is the shipped Classic when the household has everything', () => {
    const both = classicFor({ modules: ['weather', 'home', 'chores'], shift: true });
    expect(both.portrait).toEqual(CLASSIC.portrait);
    expect(both.landscape).toEqual(CLASSIC.landscape);
  });

  it.each(STATES)('seeds nothing the manifest would drop, with $label', ({ setUp }) => {
    const seeded = classicFor(setUp);
    for (const orientation of ORIENTATIONS) {
      const widgets = seeded[orientation].widgets;
      /*
       * The claim, in the strongest form available without a browser: the
       * filter that leaves the hole has nothing to take. Not "the seed has no
       * weather box" — that would pass just as happily on a seed with no
       * *calendar* — but that every box placed survives `widgetIsSetUp`, which
       * is the same function `buildManifest` filters with.
       */
      for (const widget of widgets) {
        expect(
          widgetIsSetUp(widget.type, setUp),
          `${orientation}: a ${widget.type} box would be dropped from the manifest`,
        ).toBe(true);
      }
      expect(
        keepWidgetsWithSomethingToSay(widgets, setUp),
        `${orientation}: the manifest keeps every box`,
      ).toHaveLength(widgets.length);
    }
  });

  it.each(STATES)('always draws the clock and both calendar views, with $label', ({ setUp }) => {
    // The product is the calendar. A variant that dropped a view to close a gap
    // would pass every geometric check in this file and be a worse wall.
    for (const orientation of ORIENTATIONS) {
      const widgets = classicFor(setUp)[orientation].widgets;
      const modes = widgets
        .filter((widget) => widget.type === 'calendar')
        .map((widget) => (widget.config as { mode?: string } | undefined)?.mode);
      expect(widgets.filter((w) => w.type === 'clock')).toHaveLength(1);
      expect(modes.sort()).toEqual(['list', 'month']);
    }
  });

  /**
   * The geometry, as arithmetic rather than as pixels.
   *
   * Vertical only, which is the axis the fault was on: a box removed from a
   * column leaves a band of the wall with nothing in it. Every gap has to stay
   * small enough to read as a margin — the reported fault was a 280px band on a
   * 1920px wall — and the total has to stay near Classic's own, which is 4% in
   * portrait and 12% in landscape (three 0.04 bands: above the strip, below it,
   * and under the calendars).
   */
  const emptyBands = (widgets: readonly { y: number; h: number }[]): number[] => {
    const covered = new Array<boolean>(1000).fill(false);
    for (const widget of widgets) {
      const from = Math.max(0, Math.round(widget.y * 1000));
      const to = Math.min(1000, Math.round((widget.y + widget.h) * 1000));
      for (let i = from; i < to; i += 1) covered[i] = true;
    }
    const bands: number[] = [];
    let run = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (covered[i] === true) {
        if (run > 0) bands.push(run);
        run = 0;
      } else run += 1;
    }
    if (run > 0) bands.push(run);
    return bands;
  };

  it.each(STATES)('leaves no band of the wall empty, with $label', ({ setUp }) => {
    const seeded: DisplayTemplate = classicFor(setUp);
    for (const orientation of ORIENTATIONS) {
      /*
       * Measured on what the wall is *sent*, not on what was seeded. That is
       * the whole fault: the seed has no gap in it and the manifest makes one.
       * Measuring the seed here would pass on the shipped Classic, which is the
       * layout the 280px hole was photographed on.
       */
      const drawn = keepWidgetsWithSomethingToSay(seeded[orientation].widgets, setUp);
      const bands = emptyBands(drawn);
      const worst = Math.max(0, ...bands);
      const total = bands.reduce((sum, band) => sum + band, 0);
      /*
       * 62 thousandths is 120px of a 1920px portrait wall and 67px of a 1080px
       * landscape one — the threshold the report measured the fault at, applied
       * to the taller wall. The unconfigured portrait seed had a 146-thousandth
       * band (280px); the shipped Classic's worst is its 20-thousandth top
       * margin, and landscape's is 40.
       */
      expect(worst, `${orientation}: an empty band of ${worst}/1000 of the wall`).toBeLessThan(62);
      const cap = orientation === 'portrait' ? 50 : 125;
      expect(total, `${orientation}: ${total}/1000 of the wall is empty`).toBeLessThanOrEqual(cap);
    }
  });
});
