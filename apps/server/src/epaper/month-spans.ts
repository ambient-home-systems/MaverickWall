/**
 * Which of a month grid's events are drawn once, as a bar across their days —
 * `apps/display/src/month-spans.ts` transcribed, and nothing else.
 *
 * **Written twice because it has to be.** The display bundle has no
 * dependencies and no bundler — plain `tsc` output with `rootDir` pinned to its
 * own `src` — so it cannot import from here, and a test here cannot import from
 * it without falling outside `tsconfig.test.json`'s root. `ladder.ts` and
 * `calendar-view.ts` have the same seam for the same reason, and the same
 * guard: `month-spans-parity.test.ts` reads *both* files and holds everything
 * below this comment to being character-identical.
 *
 * A panel that follows a wall has to draw the same month, and "the same month"
 * now includes which events are one bar and which are rows. Getting that from
 * a second opinion is the fault this repository has shipped under four names —
 * `shifts[0]`, `display_mode`, `cellEvents`, `mode` — and the cure each time
 * was to resolve it once and hand over the answer. **The wall is the spec**;
 * this is a copy of the wall's reading and must never become an opinion about
 * it.
 */

/** The least a cell has to say about one of its events for a span to be found. */
export interface SpanEvent {
  /**
   * The event's identity, which is the same on every date it touches — the
   * server buckets one row onto each of them. Grouping on the *title* would
   * merge two unrelated "Bin day" entries a week apart into one seven-day bar.
   */
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly allDay: boolean;
  /** The server's own word for "this event covers more than one date". */
  readonly continues: boolean;
}

/** One bar, as the renderers draw it. */
export interface MonthSpan {
  readonly id: string;
  readonly title: string;
  readonly color: string;
  /** Where it starts, as a 0-based column within the week. */
  readonly column: number;
  /** How many columns it covers — at least one, never past the week's end. */
  readonly span: number;
  /** Which stacked lane, 0 being nearest the day number. */
  readonly lane: number;
  /**
   * Whether this bar carries the words.
   *
   * True for the first bar of a run anywhere in the grid and false for every
   * continuation, including one that begins a later week. An event whose run
   * started before the window still gets its title on the first bar that is
   * actually drawn — otherwise it would be nameless on the whole wall.
   */
  readonly leading: boolean;
}

/** What one week draws, and what each of its cells owes the bars above it. */
export interface WeekSpans {
  readonly bars: readonly MonthSpan[];
  /** Per column: how many lanes are reserved between the number and the rows. */
  readonly lanes: readonly number[];
  /** Per column: the event ids a bar already draws, so the cell can skip them. */
  readonly drawn: readonly (readonly string[])[];
}

/**
 * How many bars may stack in one week before the rest fall back to rows.
 *
 * Every lane is height taken off every cell in the row, whether or not a bar
 * crosses it, and a cell on the shipped Classic wall has room for one row in
 * total. Three simultaneous multi-day all-day events is already an unusual
 * week; a fourth draws as ordinary rows, which is what the grid did for all of
 * them until now — worse than a bar and much better than a row of squares with
 * nothing in them but lanes.
 */
export const MAX_SPAN_LANES = 3;

/** How many steps the density mark has, the longest being "this day is full". */
export const DENSITY_STEPS = 4;

/**
 * How busy a day looks from the doorway, as 0 to `DENSITY_STEPS`.
 *
 * The mark under the day number is the one thing in a cell that carries with
 * no legible text at all, and it is the whole answer for a cell too small to
 * name anything — which on the shipped Classic wall is most of them, most
 * weeks. So it counts, one step per event, and saturates: past four the
 * difference between six and nine is not a thing anybody reads across a
 * kitchen, and a longer bar would only be a longer bar.
 *
 * **Zero is zero.** An empty day draws its numeral and nothing else — a mark
 * of no length is a mark, and a household would read it as something on. An
 * empty day *is* the information.
 */
export function densitySteps(count: number): number {
  if (!(count > 0)) return 0;
  return Math.min(DENSITY_STEPS, Math.round(count));
}

interface Run {
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly from: number;
  to: number;
}

/**
 * The bars for a whole grid, week by week.
 *
 * `weeks` is the grid's own shape — weeks of columns of that day's events, in
 * the order the manifest sent them, which is all-day first and then by start
 * time. Nothing here re-sorts: the order a cell draws in is decided in one
 * place (`buildManifest`) and two renderers reading it differently is the
 * fault this file exists to avoid.
 */
export function monthSpans(
  weeks: readonly (readonly (readonly SpanEvent[])[])[],
): readonly WeekSpans[] {
  // Ids whose title is already on the glass. Carried across weeks because the
  // rule is about the run, not about the row it happens to be drawn in.
  const titled: Record<string, true> = {};
  const out: WeekSpans[] = [];
  for (const week of weeks) out.push(weekSpans(week, titled));
  return out;
}

function weekSpans(
  week: readonly (readonly SpanEvent[])[],
  titled: Record<string, true>,
): WeekSpans {
  const columns = week.length;
  const runs: Run[] = [];
  /*
   * Adjacency, walked left to right.
   *
   * `open` holds the runs the previous column carried. An id the current
   * column does not carry simply falls out of it, so the same event
   * reappearing later in the week starts a *second* bar rather than one long
   * bar with a hole through the middle of it. That cannot happen with a
   * manifest this server built — it buckets every date in the span — but a bar
   * drawn over a day the event is not on is the one failure a grid must never
   * have, so it is refused by construction rather than by trust.
   */
  let open: Record<string, Run> = {};
  for (let column = 0; column < columns; column++) {
    const next: Record<string, Run> = {};
    for (const event of week[column] ?? []) {
      if (!event.allDay || !event.continues) continue;
      if (next[event.id] !== undefined) continue;
      const carried = open[event.id];
      if (carried !== undefined) {
        carried.to = column;
        next[event.id] = carried;
        continue;
      }
      const fresh: Run = {
        id: event.id,
        title: event.title,
        color: event.color,
        from: column,
        to: column,
      };
      runs.push(fresh);
      next[event.id] = fresh;
    }
    open = next;
  }

  /*
   * Lanes, lowest free first.
   *
   * Ordered by where a bar starts, then by how far it reaches, then by id —
   * deterministic, so the same week draws the same arrangement every tick and
   * a bar does not swap lanes with its neighbour between two draws of an
   * unchanged manifest. Longest-first among bars that start together puts the
   * week's spine on the top lane, which is also where a continuation from last
   * week lands.
   */
  const ordered = runs.slice().sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const length = b.to - b.from - (a.to - a.from);
    if (length !== 0) return length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const taken: boolean[][] = [];
  const bars: MonthSpan[] = [];
  for (const run of ordered) {
    let lane = 0;
    while (lane < MAX_SPAN_LANES && !isFree(taken, lane, run)) lane += 1;
    // Beyond the lanes a cell can afford: this event keeps the treatment it
    // had before spans existed, which is a row in each of its cells.
    if (lane >= MAX_SPAN_LANES) continue;
    occupy(taken, lane, run);
    const leading = titled[run.id] === undefined;
    titled[run.id] = true;
    bars.push({
      id: run.id,
      title: run.title,
      color: run.color,
      column: run.from,
      span: run.to - run.from + 1,
      lane,
      leading,
    });
  }

  const lanes: number[] = [];
  const drawn: string[][] = [];
  for (let column = 0; column < columns; column++) {
    lanes.push(0);
    drawn.push([]);
  }
  for (const bar of bars) {
    for (let column = bar.column; column < bar.column + bar.span; column++) {
      const reserved = lanes[column] ?? 0;
      lanes[column] = Math.max(reserved, bar.lane + 1);
      (drawn[column] ?? []).push(bar.id);
    }
  }

  // In drawing order: lane, then column. The DOM order of absolutely placed
  // bars decides nothing about where they land, but it decides what a reader
  // of the markup — and a screen reader — walks through.
  bars.sort((a, b) => a.lane - b.lane || a.column - b.column);
  return { bars, lanes, drawn };
}

function isFree(taken: readonly boolean[][], lane: number, run: Run): boolean {
  const row = taken[lane];
  if (row === undefined) return true;
  for (let column = run.from; column <= run.to; column++) if (row[column] === true) return false;
  return true;
}

function occupy(taken: boolean[][], lane: number, run: Run): void {
  const row = taken[lane] ?? [];
  for (let column = run.from; column <= run.to; column++) row[column] = true;
  taken[lane] = row;
}
