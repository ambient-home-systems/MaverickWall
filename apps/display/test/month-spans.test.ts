/**
 * Which events become one bar, and where each bar lands.
 *
 * A pure module gets pure tests, and the value of them here is that every trap
 * in the rule is a *table* rather than a rendering: a week boundary, a title
 * drawn twice, a daily standup swept into a seven-day band, two half terms
 * drawn on top of each other. None of those is visible in a passing screenshot
 * and all of them are one assertion away here.
 *
 * Every case was checked by breaking its own fix and watching it go red.
 */
import { describe, expect, it } from 'vitest';

import { MAX_SPAN_LANES, densitySteps, monthSpans, type SpanEvent } from '../src/month-spans.js';

/** An all-day occurrence of a multi-day event, as the manifest sends it. */
function part(id: string, title = id): SpanEvent {
  return { id, title, color: '#c33', allDay: true, continues: true };
}

/** A one-day all-day event: a birthday, a bin day. Never a bar. */
function single(id: string, title = id): SpanEvent {
  return { id, title, color: '#3c3', allDay: true, continues: false };
}

/** A timed occurrence — the daily standup, which is seven separate events. */
function timed(id: string, title = id): SpanEvent {
  return { id, title, color: '#33c', allDay: false, continues: false };
}

/** An overnight timed event: `continues`, and emphatically not a bar. */
function overnight(id: string, title = id): SpanEvent {
  return { id, title, color: '#33c', allDay: false, continues: true };
}

/** A week of seven columns, from a sparse map of column → events. */
function week(cells: Readonly<Record<number, readonly SpanEvent[]>>): readonly SpanEvent[][] {
  const out: SpanEvent[][] = [];
  for (let column = 0; column < 7; column++) out.push([...(cells[column] ?? [])]);
  return out;
}

describe('multi-day events become one bar', () => {
  it('draws a seven-day event once, across the week', () => {
    const half = part('half', 'Half term');
    const [first] = monthSpans([week({ 0: [half], 1: [half], 2: [half], 3: [half], 4: [half], 5: [half], 6: [half] })]);
    expect(first?.bars).toHaveLength(1);
    expect(first?.bars[0]).toMatchObject({ column: 0, span: 7, lane: 0, leading: true, title: 'Half term' });
    // And every one of the seven cells knows not to draw it as a row, which is
    // the half that stops the title being printed seven times underneath the
    // bar that already says it.
    expect(first?.drawn.map((ids) => ids.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(first?.lanes).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('breaks at the week boundary, and only the first bar carries the title', () => {
    /*
     * The trap this rule is *for*. A fortnight cannot wrap a seven-column
     * grid, so it has to be two bars — and a title on the second one is the
     * repetition being fixed, one row down instead of seven columns across.
     */
    const trip = part('trip', 'Skiing');
    const weeks = monthSpans([
      week({ 5: [trip], 6: [trip] }),
      week({ 0: [trip], 1: [trip], 2: [trip] }),
    ]);
    expect(weeks[0]?.bars).toMatchObject([{ column: 5, span: 2, leading: true, title: 'Skiing' }]);
    expect(weeks[1]?.bars).toMatchObject([{ column: 0, span: 3, leading: false }]);
    expect(weeks.flatMap((one) => one.bars).filter((bar) => bar.leading)).toHaveLength(1);
  });

  it('names a run that began before the grid, on the first bar it can', () => {
    /*
     * A half term that started last month has no first bar in this grid, and
     * "only the first bar is labelled" read literally would leave it nameless
     * on the whole wall. The rule is the first bar *drawn*, not the first day
     * of the event.
     */
    const running = part('running', 'Away');
    const [first] = monthSpans([week({ 0: [running], 1: [running] })]);
    expect(first?.bars[0]?.leading).toBe(true);
  });

  it('is one day wide where a run only just reaches into the week', () => {
    // A Saturday-start fortnight: one column in week one, five in week two.
    // The single column is still a bar — it is the same event continuing —
    // and it is the one that carries the name.
    const trip = part('trip', 'Cottage');
    const weeks = monthSpans([week({ 6: [trip] }), week({ 0: [trip], 1: [trip] })]);
    expect(weeks[0]?.bars).toMatchObject([{ column: 6, span: 1, leading: true }]);
    expect(weeks[1]?.bars).toMatchObject([{ column: 0, span: 2, leading: false }]);
  });
});

describe('what is not a bar', () => {
  it('leaves a one-day all-day event as a row', () => {
    // `DTEND` is exclusive, so a birthday on the 15th ends on the 16th and is
    // one day long. Deriving the length from the dates is what puts every
    // birthday on a two-day bar; this reads the server's own `continues`.
    const [first] = monthSpans([week({ 2: [single('bday', "Grandma's 80th")] })]);
    expect(first?.bars).toHaveLength(0);
    expect(first?.drawn.every((ids) => ids.length === 0)).toBe(true);
    expect(first?.lanes).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('leaves a daily standup as seven rows, not a seven-day band', () => {
    /*
     * Seven occurrences of one series, each its own event with its own id and
     * `continues: false`. Grouping on the *title* would sweep them into a band
     * across the whole week and take the words off six days.
     */
    const days: Record<number, readonly SpanEvent[]> = {};
    for (let column = 0; column < 7; column++) days[column] = [timed(`s${column}`, 'Standup')];
    const [first] = monthSpans([week(days)]);
    expect(first?.bars).toHaveLength(0);
  });

  it('leaves an overnight timed event as rows on both its days', () => {
    // `continues` is true — it touches two dates — and it is not all-day, so a
    // bar would claim a whole second day for something that ended at one in
    // the morning. Both halves of the test are load-bearing.
    const late = overnight('late', 'Night shift');
    const [first] = monthSpans([week({ 3: [late], 4: [late] })]);
    expect(first?.bars).toHaveLength(0);
  });

  it('groups on identity and never on the words', () => {
    /*
     * Two different events called the same thing, overlapping by a day — a
     * school's half term and a workplace's, say, or the two "Bin day" entries
     * this brief names. Grouping on the title merges them into one bar over
     * all three days and drops one of them off the wall entirely; grouping on
     * the id keeps them as what they are, stacked.
     *
     * This is the case that separates the two readings. A single multi-day
     * event proves nothing about which key the grouping used, because its id
     * and its title agree.
     */
    const mine = part('mine', 'Half term');
    const theirs = part('theirs', 'Half term');
    const [first] = monthSpans([week({ 0: [mine], 1: [mine, theirs], 2: [theirs] })]);
    expect(first?.bars.map((bar) => [bar.id, bar.column, bar.span])).toEqual([
      ['mine', 0, 2],
      ['theirs', 1, 2],
    ]);
    // Both named, because they are two events. Under title-grouping the second
    // is a continuation of the first and silently loses its name.
    expect(first?.bars.every((bar) => bar.leading)).toBe(true);
  });

  it('refuses to bridge a gap, even if the manifest ever left one', () => {
    // The server buckets an event onto every date it touches, so this cannot
    // happen — and a bar drawn over a day the event is not on is the one thing
    // a grid must never do, so it is refused by construction rather than by
    // trust. Two bars, not one four-day one.
    const odd = part('odd', 'Odd');
    const [first] = monthSpans([week({ 0: [odd], 1: [odd], 4: [odd] })]);
    expect(first?.bars.map((bar) => [bar.column, bar.span])).toEqual([
      [0, 2],
      [4, 1],
    ]);
  });
});

describe('bars stack rather than overlap', () => {
  it('gives two events over the same days separate lanes', () => {
    const half = part('half', 'Half term');
    const away = part('away', 'Away');
    const [first] = monthSpans([
      week({ 1: [half, away], 2: [half, away], 3: [half, away] }),
    ]);
    expect(first?.bars.map((bar) => bar.lane).sort()).toEqual([0, 1]);
    expect(first?.lanes).toEqual([0, 2, 2, 2, 0, 0, 0]);
    // Both are still drawn, and both cells know to skip both.
    expect(first?.drawn[2]).toHaveLength(2);
  });

  it('reuses a lane once the bar in it has finished', () => {
    const early = part('early', 'Early');
    const late = part('late', 'Late');
    const [first] = monthSpans([week({ 0: [early], 1: [early], 4: [late], 5: [late] })]);
    expect(first?.bars.every((bar) => bar.lane === 0)).toBe(true);
  });

  it('hands a fifth simultaneous span back to the rows rather than to a lane', () => {
    // Every lane is height taken off every cell in the row, and a cell on the
    // shipped wall has room for one row in total. Past the cap an event keeps
    // the treatment it had before spans existed.
    const many = Array.from({ length: MAX_SPAN_LANES + 2 }, (_, index) =>
      part(`e${index}`, `Trip ${index}`),
    );
    const [first] = monthSpans([week({ 2: many, 3: many })]);
    expect(first?.bars).toHaveLength(MAX_SPAN_LANES);
    expect(first?.lanes[2]).toBe(MAX_SPAN_LANES);
    expect(first?.drawn[2]).toHaveLength(MAX_SPAN_LANES);
  });

  it('draws the same arrangement twice from the same week', () => {
    // A wall redraws every fifteen seconds. A bar swapping lanes with its
    // neighbour between two draws of an unchanged manifest is a flicker
    // nobody could explain, so the ordering is deterministic by construction.
    const a = part('a');
    const b = part('b');
    const one = week({ 0: [a, b], 1: [a, b], 2: [b] });
    expect(monthSpans([one])).toEqual(monthSpans([one]));
  });
});

describe('the density mark', () => {
  it('draws nothing at all for an empty day', () => {
    // An empty day is the information. A mark of no length is still a mark.
    expect(densitySteps(0)).toBe(0);
    expect(densitySteps(-1)).toBe(0);
  });

  it('steps with the count and then saturates', () => {
    expect([1, 2, 3, 4].map(densitySteps)).toEqual([1, 2, 3, 4]);
    // Past four, six and nine are the same thing from across a kitchen.
    expect(densitySteps(9)).toBe(4);
    expect(densitySteps(40)).toBe(4);
  });
});
