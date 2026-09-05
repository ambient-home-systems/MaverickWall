import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { weekdayFaults, type NamedFeed, type WeekdayRules } from './browser-harness.js';

/**
 * No fixture in this suite may read the calendar and report it as code.
 *
 * This repository has recorded that fault four times, and the fourth is what
 * this file is for — `browser-calendar-density` passed on CI at 19:22 London
 * and failed at 00:44 on the identical tree, because every event in its feeds
 * sat at `day >= 0` and the drawn Monday-to-Sunday week therefore carried a
 * different amount depending on what weekday it happened to be. The three
 * before it were `HARNESS_HOUR`'s two-minute window, the seven-day half term
 * that occupied one grid row or two, and `wall-density`'s span bars, which is
 * the same half term one file along.
 *
 * A fifth fixture fix would have been the wrong answer. What the four have in
 * common is not a value but a *question nobody was made to ask*, so the guard
 * is a forcing function rather than a rule: **every `NamedFeed[]` in the suite
 * must appear in `NEEDS` below**, declaring what its consuming test depends on
 * — and `{}` with a reason is a perfectly good answer. A new fixture cannot be
 * added without someone answering "would this look different on a Tuesday?".
 *
 * ## Why the fixtures are scanned rather than imported
 *
 * They are `const`s inside `*.test.ts` files, and importing one of those from
 * here would execute it: its `describe` blocks would register a second time,
 * inside this file's suite, and the whole run would double. So the declarations
 * are read as text. That is weaker than an import in exactly one way and it is
 * guarded below — a regex over a file that has moved matches nothing and passes
 * by checking an empty set, so the parse is asserted to find the fixtures it
 * knows are there and to agree with an independent count of the events in each.
 *
 * A fixture built by a *function* rather than declared (`reflow-stability`'s
 * `feed()`, `browser-running-event`'s `withOneRunning()`) is invisible here and
 * deliberately so: its shape is decided at the call site, which is where it can
 * be reasoned about.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * What each fixture's consuming test actually depends on.
 *
 * `weekCoverage` is what a test measuring a *week* needs — how many events
 * every day of the drawn week must carry, on every weekday. `stableSpans` is
 * what a test counting multi-day bars needs. Most fixtures need neither, and
 * saying so with the reason is the point: the value of this table is that
 * somebody had to look.
 */
interface Need {
  readonly rules: WeekdayRules;
  readonly why: string;
  /**
   * Set when this file could not read every one of the fixture's offsets as a
   * literal — a spread, a `.map`, an `Array.from`, or a value derived at run
   * time — so nothing here can evaluate them.
   *
   * `browser-month-spans` is the case that forced this and is the good kind:
   * its `WEEK_START_OFFSET` is computed from today's own weekday precisely so
   * a seven-day run always begins on a week start. A fixture that solves the
   * problem *dynamically* cannot be checked statically, and a guard that
   * pretended otherwise would report the solution as the fault. What it still
   * gets is the forcing function: the reason has to be written down.
   */
  readonly computed?: string;
}

const NEEDS: Readonly<Record<string, Need>> = {
  'browser-harness.ts:HOUSEHOLD_CALENDARS': {
    rules: { stableSpans: true },
    why: "wall-density counts its span bars; the half term is eight days for exactly this reason. No week coverage: every consumer measures the month, where the fixture's own density is the subject.",
  },
  'browser-calendar-density.test.ts:CALENDARS': {
    rules: { weekCoverage: 2, stableSpans: true },
    why: 'measures the week at two densities, and compact only shows more where comfortable had to give something up — so a day of the week must be busy, not merely non-empty.',
  },
  'browser-month-spans.test.ts:CALENDARS': {
    rules: {},
    why: 'the whole file is about multi-day runs, and it already handles the weekday itself.',
    computed:
      "`WEEK_START_OFFSET` is derived from today's own weekday so the seven-day run always begins on a week start, and the fortnight is deliberately long enough to cross a boundary from any start. Both are run-time values; the argument lives in that file's own comments, which is the only place it can.",
  },
  'browser-month-grid.test.ts:CALENDARS': {
    rules: { stableSpans: true },
    why: 'counts named cells and "+N" counters across the grid; a run that moves between one row and two moves both.',
  },
  'browser-grid-calendar.test.ts:FEEDS': {
    rules: {},
    why: "asserts which event names reach the month grid and the agenda once a calendar is taken off the grid. It counts names, never days or rows, so the weekday cannot change the answer.",
    computed:
      "its Work feed is `Array.from({ length: 31 })` — a standup every day for a month, which is the point of that feed. Found by the event count disagreeing with the `title:` count rather than by the spread and `.map` tells, which is what that second count is for.",
  },
  'browser-agenda-now.test.ts:CALENDARS': {
    rules: {},
    why: 'about where the current-time rule falls among today\'s timed events, which is an hour question. `HARNESS_HOUR` pins the hour; the weekday is not read.',
  },
  'browser-font-race.test.ts:CALENDARS': {
    rules: {},
    why: 'compares one wall against itself with and without the webfont. Both sides see the same day, so a weekday difference cancels.',
  },
  'browser-empty-bands.test.ts:CALENDARS': {
    rules: {},
    why: 'compares two templates drawn from the same fixture at the same instant; the weekday is common to both.',
  },
  'browser-running-event.test.ts:OVERNIGHT': {
    rules: {},
    why: 'one timed event straddling midnight, measured against the same wall without it. A single event has no week shape to lose.',
  },
  'browser-source-colours.test.ts:FEEDS': {
    rules: {},
    why: 'asks whether three calendars reach the glass as three colours. A count of distinct hues does not depend on which day they land on.',
  },
  'browser-source-colours.test.ts:HUE_FEEDS': {
    rules: { stableSpans: true },
    why: 'its span bar is the element whose ink is measured, so the bar has to be drawn — and drawn the same way — whatever the weekday.',
  },
};

interface Fixture {
  readonly key: string;
  readonly feeds: readonly NamedFeed[];
  /** Independent of the parse: how many `title:` keys the block's text carries. */
  readonly titlesInText: number;
  /**
   * Whether every offset in it is a numeric literal.
   *
   * False for a spread, a `.map`, or a `day:` naming something computed — none
   * of which this file can evaluate, and all of which it must therefore decline
   * to judge rather than mis-judge.
   */
  readonly literal: boolean;
}

/**
 * Every `const NAME: readonly NamedFeed[] = [ … ];` in the suite, read as text.
 *
 * The event shape is fixed and small — `{ title, day, from?, to?, days?,
 * toDay? }` — so it is split on `{ title:` and each chunk read for the two
 * numbers that matter here. Anything it fails to understand shows up as a
 * count mismatch against `titlesInText`, which is asserted rather than assumed.
 */
function fixtures(): Fixture[] {
  const found: Fixture[] = [];
  const files = readdirSync(HERE).filter(
    (name) => name.endsWith('.test.ts') || name === 'browser-harness.ts',
  );

  for (const file of files) {
    const source = readFileSync(join(HERE, file), 'utf8');
    const declaration = /(?:export )?const ([A-Z_][A-Z0-9_]*)\s*:\s*readonly NamedFeed\[\]\s*=\s*\[/g;
    for (const match of source.matchAll(declaration)) {
      const name = match[1] as string;
      // From the opening bracket to the `];` that closes it at column zero —
      // the file's own formatting, and the only close that is not nested.
      const from = (match.index ?? 0) + match[0].length;
      const close = source.indexOf('\n];', from);
      if (close < 0) continue;
      const body = source.slice(from, close);

      /*
       * Split on each feed's own `name:` rather than on the file's bracket
       * formatting. The first draft split on `\n  {\n`, which reads a feed
       * written across lines and misses one written on a single line — and
       * then reported it as a *computed* fixture, which is a wrong diagnosis
       * rather than a missing one. A parse limitation that names the wrong
       * cause sends the next person looking in the wrong place.
       */
      const feeds: NamedFeed[] = [];
      for (const feed of body.split(/name:\s*'/).slice(1).map((part) => `name: '${part}`)) {
        const feedName = /name: '([^']*)'/.exec(feed)?.[1] ?? '';
        const events: NamedFeed['events'][number][] = [];
        for (const chunk of feed.split('{ title:').slice(1)) {
          const day = /\bday:\s*(-?\d+)/.exec(chunk);
          if (day === null) continue;
          const days = /\bdays:\s*(\d+)/.exec(chunk);
          const toDay = /\btoDay:\s*(-?\d+)/.exec(chunk);
          const title = /^\s*'((?:[^'\\]|\\.)*)'/.exec(chunk)?.[1] ?? '(untitled)';
          events.push({
            title,
            day: Number(day[1]),
            ...(days !== null ? { days: Number(days[1]) } : {}),
            ...(toDay !== null ? { toDay: Number(toDay[1]) } : {}),
          });
        }
        feeds.push({ name: feedName, events });
      }
      const parsed = feeds.reduce((n, feed) => n + feed.events.length, 0);
      const titlesInText = (body.match(/title:/g) ?? []).length;
      found.push({
        key: `${file}:${name}`,
        feeds,
        titlesInText,
        // Three tells, and the count is the backstop for anything they miss.
        literal:
          !body.includes('...') &&
          !body.includes('.map(') &&
          /\bday:\s*-?\d/.test(body) &&
          !/\bday:\s*[A-Za-z_]/.test(body) &&
          parsed === titlesInText,
      });
    }
  }
  return found;
}

const FOUND = fixtures();

describe('the fixture scan', () => {
  it('finds the fixtures it knows are there, so a rename fails loudly', () => {
    /*
     * Without this, a regex over files that have moved matches nothing, every
     * assertion below iterates an empty list, and the guard passes by having
     * looked at nothing — which is the failure mode this repository has
     * recorded for a regex-based check twice already.
     */
    const keys = FOUND.map((fixture) => fixture.key);
    expect(keys).toContain('browser-harness.ts:HOUSEHOLD_CALENDARS');
    expect(keys).toContain('browser-calendar-density.test.ts:CALENDARS');
    expect(FOUND.length).toBeGreaterThanOrEqual(10);
  });

  it('reads every event of every fixture it claims to have read', () => {
    /*
     * The parse's own honesty check, counted a second way from the same text —
     * and asked only of the fixtures the scan says are literal, because a
     * fixture built with a spread has more events than it has `title:` keys by
     * construction. A mismatch *inside* the literal set is a parse that quietly
     * dropped an event, which would make its weekday check a check of less
     * than the fixture.
     */
    const short = FOUND.filter((fixture) => fixture.literal)
      .filter(
        (fixture) =>
          fixture.feeds.reduce((n, feed) => n + feed.events.length, 0) !== fixture.titlesInText,
      )
      .map(
        (fixture) =>
          `${fixture.key}: parsed ${fixture.feeds.reduce((n, f) => n + f.events.length, 0)} of ` +
          `${fixture.titlesInText}`,
      );
    expect(short, `the scan did not understand every event:\n  ${short.join('\n  ')}`).toEqual([]);
  });

  it('asks for a reason exactly where it cannot judge, and nowhere else', () => {
    /*
     * The escape and its limit, in one assertion. A fixture whose offsets are
     * computed has to say so — the argument then lives in that file's own
     * comments, which is the only place it can. And a fixture that *is*
     * literal may not claim the escape, or the exemption becomes the easy
     * answer and the table stops meaning anything.
     */
    const unexplained = FOUND.filter(
      (fixture) => !fixture.literal && NEEDS[fixture.key]?.computed === undefined,
    ).map((fixture) => fixture.key);
    expect(
      unexplained,
      `${unexplained.length} fixture(s) have offsets this file cannot read as literals, and ` +
        `say nothing about why they are safe anyway. Add \`computed:\` to their NEEDS ` +
        `entry:\n  ${unexplained.join('\n  ')}`,
    ).toEqual([]);

    const overclaimed = FOUND.filter(
      (fixture) => fixture.literal && NEEDS[fixture.key]?.computed !== undefined,
    ).map((fixture) => fixture.key);
    expect(
      overclaimed,
      `${overclaimed.length} fixture(s) claim their offsets cannot be read and they can — ` +
        `these are checkable, so they must be checked:\n  ${overclaimed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('holds every fixture to a declared answer about the weekday', () => {
    /*
     * The forcing function, and the reason this file exists rather than a fifth
     * fixture fix. A fixture in neither state — checked, or exempt with a reason
     * — fails; nobody can add one without answering the question that has now
     * cost this repository four bugs.
     */
    const undeclared = FOUND.map((fixture) => fixture.key)
      .filter((key) => NEEDS[key] === undefined)
      .sort();
    expect(
      undeclared,
      `${undeclared.length} fixture(s) say nothing about whether they depend on the weekday. ` +
        `Add each to NEEDS in this file — \`rules: {}\` with a reason is a fine answer, ` +
        `and writing the reason is the point:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([]);

    // And the other direction: an entry for a fixture that has gone is a reason
    // nobody can check, sitting in a table people trust.
    const stale = Object.keys(NEEDS)
      .filter((key) => !FOUND.some((fixture) => fixture.key === key))
      .sort();
    expect(stale, `NEEDS names ${stale.length} fixture(s) that no longer exist`).toEqual([]);
  });
});

describe.each(
  FOUND.filter((fixture) => fixture.literal && NEEDS[fixture.key] !== undefined),
)(
  'the $key fixture',
  (fixture: Fixture) => {
    const entry = NEEDS[fixture.key] as Need;

    it('looks the same shape whatever weekday it is run on', () => {
      const faults = weekdayFaults(fixture.feeds, entry.rules);
      expect(
        faults,
        `${fixture.key} is weekday-dependent (${entry.why})\n  ${faults.join('\n  ')}`,
      ).toEqual([]);
    });
  },
);

describe('the rule itself', () => {
  /*
   * The arithmetic, asked directly. Everything above is a fixture's answer to
   * these two questions, so a mistake here would make every one of those a
   * quiet pass — and both rules are the sort that read as obviously right in
   * either direction.
   */
  const one = (events: NamedFeed['events']): NamedFeed[] => [{ name: 'F', events }];

  it('calls a seven-day run unstable and an eight-day one stable', () => {
    // The half term, which is the whole reason `HOUSEHOLD_CALENDARS` says 8.
    expect(
      weekdayFaults(one([{ title: 'Half term', day: 3, days: 7 }]), { stableSpans: true }),
    ).toHaveLength(1);
    expect(
      weekdayFaults(one([{ title: 'Half term', day: 3, days: 8 }]), { stableSpans: true }),
    ).toEqual([]);
    // And the general form: one more than a multiple of seven, at both ends.
    for (const days of [1, 8, 15, 22]) {
      expect(
        weekdayFaults(one([{ title: 'Run', day: 0, days }]), { stableSpans: true }),
        `${days} days should be row-stable`,
      ).toEqual([]);
    }
    for (const days of [2, 6, 7, 9, 14]) {
      expect(
        weekdayFaults(one([{ title: 'Run', day: 0, days }]), { stableSpans: true }),
        `${days} days should not be row-stable`,
      ).not.toEqual([]);
    }
  });

  it('catches a week that is only populated forwards', () => {
    // `browser-calendar-density`'s own bug, in miniature: seven days of events
    // starting today leaves the earlier part of the week empty on every weekday
    // but the week's first.
    const forwards = one([0, 1, 2, 3, 4, 5, 6].map((day) => ({ title: `E${day}`, day })));
    const faults = weekdayFaults(forwards, { weekCoverage: 1 });
    expect(faults).toHaveLength(6);
    expect(faults[0]).toContain('Monday');

    // Spread back six days and every weekday's week is covered.
    const spread = one(
      [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((day) => ({ title: `E${day}`, day })),
    );
    expect(weekdayFaults(spread, { weekCoverage: 1 })).toEqual([]);
    // …but only one deep, which is not the same as busy.
    expect(weekdayFaults(spread, { weekCoverage: 2 })).not.toEqual([]);
  });

  it('counts a multi-day event on every day it covers', () => {
    // A run is what keeps a week non-empty in most real fixtures, so reading it
    // as a single day would make the coverage rule far too strict.
    const run = one([{ title: 'Away', day: -6, days: 13 }]);
    expect(weekdayFaults(run, { weekCoverage: 1 })).toEqual([]);
  });
});
