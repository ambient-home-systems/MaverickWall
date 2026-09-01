/**
 * The e-paper frame's own ink, measured rather than looked at.
 *
 * A design audit rendered `renderEpaper` directly — no browser, the panel's own
 * code path — at six real panel sizes with thirty days of an ordinary
 * household's events, and asked two questions the structural tests in
 * `epaper-render.test.ts` never ask: how much of the frame actually carries
 * ink, and how far down the panel the last row of it sits. The answer, at
 * every size, was "less than half, and a long way short of the bottom edge" —
 * up to 51% of a large portrait panel's height was blank below the last drawn
 * row, on hardware that costs a redraw and cannot animate its way out of
 * looking unfinished.
 *
 * `CLAUDE.md`'s "Verification is the job" names the pattern this file follows:
 * a real fixture, a real renderer, a number rather than a screenshot. This is
 * a **ratchet**, the same discipline as the migration journal parity check —
 * `BASELINE` below is today's record, every assertion compares a fresh
 * measurement against it in the improving direction only, and a phase that
 * moves a number must move the baseline in the same commit. It is one of two
 * acceptance gates (with `wall-density.test.ts`) for the twelve phases meant
 * to close this gap.
 *
 * Pure and synchronous on purpose: `renderEpaper` takes a manifest and a panel
 * size and returns a `Framebuffer` with no I/O anywhere in between, so this
 * needs no server, no browser and no `MW_BROWSER_EXECUTABLE` — the six sizes
 * below run in milliseconds each.
 */
import { describe, expect, it } from 'vitest';
import { addDays, type CivilDate } from '@maverick-wall/core';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderEpaper } from '../src/epaper/render.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * `render.ts`'s own header band height — not exported, so it is transcribed
 * here rather than imported, the same way `epaper/ladder.ts` is transcribed
 * into the display bundle: two packages (here, a private constant and a test)
 * that cannot share the value directly. It only decides where "body" starts
 * for the measurement below; a change to it moves the split point rather than
 * silently invalidating anything.
 */
const HEADER_H = 54;

// ---------------------------------------------------------------------------
// A month of an ordinary household's calendar
// ---------------------------------------------------------------------------

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e', uid: 'e', title: 'Event', startsAt: 0, endsAt: 0, allDay: false,
    sourceId: 's', color: '#000', status: 'confirmed', continues: false, ...over,
  };
}

/** `date` at `hour:00` UTC, as an epoch. `date` is `YYYY-MM-DD`. */
function atHour(date: CivilDate, hour: number): number {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hour, 0, 0);
}

/**
 * Titles a real household writes, cycled rather than repeated, so thirty days
 * of fixture reads like thirty days of a calendar rather than one event
 * copy-pasted — the same reasoning `browser-classic-proportions.test.ts`
 * gives for using three named feeds instead of one.
 */
const TITLE_POOL = [
  'Dentist appointment', 'Football practice', 'Parents evening', 'Bin day',
  'Swimming lesson', 'Book club', 'Standup', 'Quarterly planning review',
  'School trip to the aquarium', "Grandma's 80th birthday", 'Car service',
  'Cake sale', 'One to one', 'Design critique - wall renderer', 'Half term',
  'INSET day - school closed', 'Assembly', 'School photos', 'Piano lesson',
  'Cinema night', 'Vet checkup for the dog', 'Parcel delivery window',
] as const;

const SOURCES = [
  { id: 'family', color: '#E8A33D' },
  { id: 'school', color: '#4C8BF5' },
  { id: 'work', color: '#7A5FD1' },
] as const;

/** Two to four events, mixing all-day and timed, deterministic per day index. */
function buildDay(date: CivilDate, index: number): ManifestDay {
  const count = 2 + (index % 3);
  const events: ManifestEvent[] = [];
  for (let i = 0; i < count; i++) {
    const title = TITLE_POOL[(index * 3 + i) % TITLE_POOL.length]!;
    const source = SOURCES[(index + i) % SOURCES.length]!;
    const allDay = (index + i) % 5 === 0;
    const hour = 8 + ((index + i * 3) % 11);
    events.push(
      ev({
        id: `${date}-${i}`,
        uid: `${date}-${i}`,
        title,
        allDay,
        startsAt: allDay ? atHour(date, 0) : atHour(date, hour),
        endsAt: allDay ? atHour(date, 0) : atHour(date, hour + 1),
        sourceId: source.id,
        color: source.color,
      }),
    );
  }
  return { date, shifts: [], events };
}

/** Today, plus two days either side of it, and twenty-seven more ahead. */
const TODAY: CivilDate = '2026-08-13';
const DAYS: readonly ManifestDay[] = Array.from({ length: 30 }, (_, index) =>
  buildDay(addDays(TODAY, index - 2), index),
);

function buildManifest(days: readonly ManifestDay[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: atHour(TODAY, 12),
    window: { from: days[0]!.date, to: days[days.length - 1]!.date },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'monday' },
    days,
  } as unknown as Manifest;
}

const MANIFEST = buildManifest(DAYS);

// ---------------------------------------------------------------------------
// Ink, measured rather than looked at
// ---------------------------------------------------------------------------

interface InkStats {
  /** Ink pixels as a percentage of the whole frame. */
  readonly totalInkPercent: number;
  /** Ink pixels as a percentage of the frame *below* the header band. */
  readonly bodyInkPercent: number;
  /** The y of the last row containing any ink at all. -1 if the frame is blank. */
  readonly lastInkRow: number;
  /** Blank rows below `lastInkRow`, down to the panel's own bottom edge. */
  readonly blankBottomPx: number;
  readonly blankBottomPercent: number;
}

function measureInk(fb: Framebuffer): InkStats {
  const { width, height } = fb;
  let totalInk = 0;
  let bodyInk = 0;
  let lastInkRow = -1;
  for (let y = 0; y < height; y++) {
    let rowInk = 0;
    for (let x = 0; x < width; x++) {
      if (fb.get(x, y)) rowInk++;
    }
    totalInk += rowInk;
    if (y >= HEADER_H) bodyInk += rowInk;
    if (rowInk > 0) lastInkRow = y;
  }
  const bodyRows = Math.max(0, height - HEADER_H);
  const bodyArea = width * bodyRows;
  const blankBottomPx = height - 1 - lastInkRow;
  return {
    totalInkPercent: (totalInk / (width * height)) * 100,
    bodyInkPercent: bodyArea > 0 ? (bodyInk / bodyArea) * 100 : 0,
    lastInkRow,
    blankBottomPx,
    blankBottomPercent: (blankBottomPx / height) * 100,
  };
}

const SIZES = [
  { width: 640, height: 384 },
  { width: 800, height: 480 },
  { width: 1304, height: 984 },
  { width: 1872, height: 1404 },
  { width: 480, height: 800 },
  { width: 1404, height: 1872 },
] as const;

interface Baseline {
  readonly bodyInkPercent: number;
  readonly blankBottomPx: number;
}

/**
 * Today's numbers, measured on this fixture by this file.
 *
 * **This is a ratchet, the same discipline as the migration journal parity
 * check: the constant is the record.** `bodyInkPercent` is asserted at least
 * the baseline — more of the panel below the header actually carrying the
 * household's calendar is the improving direction. `blankBottomPx` is
 * asserted at most the baseline — less dead space below the last drawn row is
 * the improving direction, and on hardware that redraws in seconds and cannot
 * animate, a panel that looks unfinished stays looking unfinished until the
 * next redraw.
 *
 * **A phase that improves one of these numbers MUST raise (`bodyInkPercent`)
 * or lower (`blankBottomPx`) the recorded baseline in the same commit.**
 * Leaving it as it is means the next phase's floor is this phase's ceiling.
 * Moving a number in the *worsening* direction is a regression and needs its
 * own justification in the commit that does it.
 *
 * The audit that this file exists to make repeatable reported, on its own
 * thirty-day fixture: 13.4% / 69px at 640x384, 12.0% / 140px at 800x480,
 * 7.5% / 479px at 1304x984, 6.8% / 714px at 1872x1404, 16.6% / 77px at
 * 480x800, 16.8% / 39px at 1404x1872. `renderEpaper` is a pure function of the
 * manifest and the panel size, so this file's fixture — thirty days, several
 * events a day, realistic titles, the same method as the audit rather than a
 * byte-for-byte replay of its script — reproduces `blankBottomPx` exactly at
 * five of the six sizes (140, 479, 714, 77 and 39, all matched to the pixel;
 * only 640x384 differs, at 99px against the audit's 69px, from which column —
 * agenda or grid — happens to run deepest on this fixture's event mix). The
 * `bodyInkPercent` values are this fixture's own, measured directly rather
 * than copied from the audit's report, because ink density is sensitive to
 * exactly which events land where and this fixture does not attempt to
 * reproduce the audit's day-by-day content byte for byte. Every value below
 * was read off a real run of this file.
 */
export const BASELINE: Record<string, Baseline> = {
  '640x384': { bodyInkPercent: 17.1, blankBottomPx: 99 },
  '800x480': { bodyInkPercent: 17.4, blankBottomPx: 140 },
  '1304x984': { bodyInkPercent: 13.1, blankBottomPx: 479 },
  '1872x1404': { bodyInkPercent: 12.9, blankBottomPx: 714 },
  '480x800': { bodyInkPercent: 26.9, blankBottomPx: 77 },
  '1404x1872': { bodyInkPercent: 33.6, blankBottomPx: 39 },
};

describe('the e-paper frame, measured for ink', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    const baseline = BASELINE[key];
    if (baseline === undefined) throw new Error(`no baseline recorded for ${key}`);

    it(`${key}: does not lose ground on body ink or blank bottom`, () => {
      const fb = renderEpaper(buildEpaperModel(MANIFEST), size);
      const stats = measureInk(fb);

      /*
       * Checked by breaking what it measures: rendering the *empty*-day frame
       * from `epaper-render.test.ts` ("says so rather than leaving the column
       * blank") in place of this fixture drops `bodyInkPercent` well under
       * every baseline here and this assertion goes red at every size.
       */
      expect(
        stats.bodyInkPercent,
        `${key}: the body carries ${stats.bodyInkPercent.toFixed(1)}% ink, below the recorded ${baseline.bodyInkPercent}%`,
      ).toBeGreaterThanOrEqual(baseline.bodyInkPercent);

      /*
       * Checked the same way, from the other side: the same empty-day frame
       * pushes the last inked row up near the header, so `blankBottomPx`
       * balloons past every baseline here and this assertion goes red too —
       * confirming the two are not the same check wearing two names, since a
       * frame could in principle ink a small area right at the bottom (low
       * `bodyInkPercent`, low `blankBottomPx`) or a large area that stops well
       * short of the edge (the opposite pairing).
       */
      expect(
        stats.blankBottomPx,
        `${key}: ${stats.blankBottomPx}px (${stats.blankBottomPercent.toFixed(1)}%) blank below the last inked row, ` +
          `above the recorded ${baseline.blankBottomPx}px`,
      ).toBeLessThanOrEqual(baseline.blankBottomPx);
    });
  }
});
