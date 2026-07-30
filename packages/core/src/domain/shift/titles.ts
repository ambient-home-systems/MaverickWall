import { daysBetween, type CivilDate } from '../../time/civil.js';

/**
 * Work out which event titles in a feed look like shift markers.
 *
 * This exists so nobody has to write a pattern. Asking somebody to describe
 * their shifts in the abstract gets you guesses; showing them the titles
 * actually in their calendar and asking which are work gets you the truth, and
 * it catches the variations a real feed contains — one calendar this was built
 * against writes both "Daddy - Working Day Shift" and "Daddy Working - Day
 * Shift", and no amount of careful typing would have produced both.
 *
 * Pure, so it can run over cached events without a database.
 */

export interface TitleObservation {
  readonly title: string;
  /** Local dates this exact title appears on. */
  readonly dates: readonly CivilDate[];
  readonly allDay: boolean;
  /**
   * Local start time as `HH:MM`, for timed events.
   *
   * The discriminator that makes timed shifts detectable. A recurring
   * appointment happens at the same time every week; a shift does not. One real
   * feed records "Mommy working" at 05:00, 07:00, 11:00 and 16:00 — four start
   * times for one title is a rota, not a standing engagement.
   */
  readonly startTime?: string;
}

export interface TitleCandidate {
  readonly title: string;
  readonly occurrences: number;
  /** Fraction of days in the observed range carrying this title, 0 to 1. */
  readonly coverage: number;
  /** Longest run of consecutive days. */
  readonly longestRun: number;
  /**
   * How many separate runs of consecutive days.
   *
   * The signal that separates a rota from a holiday. "Disney Trip" is nine
   * all-day events in one block; "Break Day" is ten in three blocks. Coverage
   * cannot tell them apart — a fortnight of Straights covers less of a
   * seventy-day window than a nine-day trip does.
   */
  readonly blocks: number;
  readonly allDay: boolean;
  /**
   * How confident we are that this is a work schedule entry.
   *
   * Three tiers rather than a yes-or-no, because the honest answer for a lot of
   * titles is "it might be, and only you know". A fixed weekly slot is the
   * clearest example: "Work 09:00" every Monday and a martial arts class every
   * Monday are indistinguishable from here, and refusing to offer the first
   * because it resembles the second is worse than offering both and asking.
   *
   *   likely    strong evidence; a settings screen should pre-select it
   *   possible  recurring, could be either; offered unselected
   *   unlikely  a one-off or a single continuous span; hidden by default
   */
  readonly confidence: 'likely' | 'possible' | 'unlikely';
  /** Why, in words, so a settings screen can explain its suggestion. */
  readonly reason: string;
  /** A guess at the shift type, from common vocabulary. Always overridable. */
  readonly suggestedShiftKey: string | null | undefined;
  /** Distinct local start times seen. Meaningless for all-day entries. */
  readonly distinctStartTimes: number;
}

/**
 * Words that name a particular kind of shift.
 *
 * Only used to pre-fill a suggestion, never to decide anything on its own:
 * "Night at the theatre" is not a night shift.
 */
const TYPE_WORDS: readonly { readonly words: readonly string[]; readonly key: string | null }[] = [
  { words: ['break day', 'rest day', 'day off', 'off duty', 'rdo'], key: null },
  { words: ['night shift', 'nights', 'mid shift', 'mids', 'midnight'], key: 'night' },
  { words: ['straight', 'admin day', 'office day'], key: 'straight' },
  { words: ['day shift', 'dayshift', 'earlies'], key: 'day' },
  { words: ['swing', 'evening shift', 'lates'], key: 'swing' },
];

/**
 * Words that say "this is work" without saying which shift.
 *
 * Kept separate from the type words because they answer a different question.
 * "Mommy working" is unmistakably a work entry and gives no clue whether it is
 * a day or a night, so the answer is: yes it is a shift, and ask which kind.
 */
const WORK_WORDS: readonly string[] = [
  'working',
  'work shift',
  'on shift',
  'on duty',
  'rota',
  'roster',
  'shift',
  'scheduled',
];

function suggestKey(title: string): string | null | undefined {
  const lowered = title.toLowerCase();
  for (const entry of TYPE_WORDS) {
    for (const word of entry.words) {
      if (lowered.includes(word)) return entry.key;
    }
  }
  return undefined;
}

function mentionsWork(title: string): boolean {
  const lowered = title.toLowerCase();
  return WORK_WORDS.some((word) => lowered.includes(word));
}

function runs(dates: readonly CivilDate[]): { longest: number; blocks: number } {
  if (dates.length === 0) return { longest: 0, blocks: 0 };
  const sorted = [...dates].sort();
  let longest = 1;
  let current = 1;
  let blocks = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1]!, sorted[i]!) === 1) {
      current += 1;
    } else {
      blocks += 1;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return { longest, blocks };
}

export interface AnalyseTitlesInput {
  readonly observations: readonly TitleObservation[];
  /** Days covered by the data, used for the coverage figure. */
  readonly windowDays: number;
  /**
   * Minimum share of days a title must cover to be suggested. Shift markers
   * cover a large fraction of the calendar; a recurring appointment does not.
   */
  readonly minimumCoverage?: number;
}

export function analyseTitles(input: AnalyseTitlesInput): TitleCandidate[] {
  const minimumCoverage = input.minimumCoverage ?? 0.15;
  const windowDays = Math.max(1, input.windowDays);

  const byTitle = new Map<
    string,
    { dates: Set<CivilDate>; allDay: boolean; startTimes: Set<string> }
  >();
  for (const observation of input.observations) {
    const key = observation.title.trim();
    if (key === '') continue;
    const entry =
      byTitle.get(key) ?? { dates: new Set<CivilDate>(), allDay: true, startTimes: new Set<string>() };
    for (const date of observation.dates) entry.dates.add(date);
    // A title is only treated as all-day if every occurrence is.
    entry.allDay = entry.allDay && observation.allDay;
    if (observation.startTime !== undefined) entry.startTimes.add(observation.startTime);
    byTitle.set(key, entry);
  }

  const candidates: TitleCandidate[] = [];

  for (const [title, entry] of byTitle) {
    const dates = [...entry.dates];
    const coverage = dates.length / windowDays;
    const { longest: longestRun, blocks } = runs(dates);
    const suggested = suggestKey(title);

    /*
     * Three signals, and the weighting matters.
     *
     * Wording is the strongest: a title containing "night shift" or "break day"
     * is describing work, and a person who has confirmed it in a settings
     * screen has said so outright. Recurrence in *several separate blocks* is
     * the next strongest, because that is what a rota looks like and what a
     * holiday does not. Coverage turned out to be a poor gate on its own: ten
     * Break Days across a seventy-day window is fourteen percent, which an
     * earlier version rejected, while a nine-day Disney trip is thirteen.
     */
    const namedType = suggested !== undefined;
    const namedWork = mentionsWork(title);
    const named = namedType || namedWork;
    const recurring = dates.length >= 3;
    const patterned = blocks >= 2 && coverage >= minimumCoverage;
    const distinctStartTimes = entry.startTimes.size;
    // Three or more start times for one recurring title is a rota. A standing
    // appointment keeps its slot; only a shift moves around the clock.
    const irregularHours = distinctStartTimes >= 3;

    /*
     * All-day and timed entries need different evidence for the top tier.
     *
     * An all-day marker is already unusual enough that block structure carries
     * it: several separate runs across the calendar is a rota, one continuous
     * run is a holiday. A timed entry is far more likely to be an ordinary
     * appointment, so it has to either say it is work or move around the clock.
     *
     * Requiring all-day, as an earlier version did, silently excluded every
     * household whose shifts are recorded with real start and end times.
     */
    const strong = recurring && (entry.allDay ? named || patterned : named || irregularHours);

    /*
     * Anything else that recurs in separate blocks is a maybe.
     *
     * This is where a fixed weekly shift lands, alongside a weekly class and a
     * fortnightly bin collection. Nothing in the data separates them, so the
     * question goes to the person who knows.
     */
    const maybe = !strong && recurring && blocks >= 2;

    const confidence: 'likely' | 'possible' | 'unlikely' = strong
      ? 'likely'
      : maybe
        ? 'possible'
        : 'unlikely';

    const reasons: string[] = [];
    if (confidence === 'likely') {
      reasons.push(`${dates.length} days in ${blocks} block${blocks === 1 ? '' : 's'}`);
      if (namedType) reasons.push('wording names a shift type');
      else if (namedWork) reasons.push('wording says it is work');
      if (irregularHours) reasons.push(`${distinctStartTimes} different start times`);
    } else if (confidence === 'possible') {
      reasons.push(
        entry.allDay
          ? `all-day, ${dates.length} times across the calendar`
          : distinctStartTimes <= 1
            ? `always at ${[...entry.startTimes][0] ?? 'the same time'}, so it could be a fixed shift or a standing commitment`
            : `${dates.length} times at ${distinctStartTimes} different hours`,
      );
    } else if (!recurring) {
      reasons.push(dates.length === 1 ? 'happens once' : `only ${dates.length} occurrences`);
    } else {
      reasons.push('one continuous block, so it reads as a single event');
    }

    candidates.push({
      title,
      occurrences: dates.length,
      coverage: Math.round(coverage * 100) / 100,
      longestRun,
      blocks,
      allDay: entry.allDay,
      confidence,
      reason: reasons.join('; '),
      suggestedShiftKey: suggested,
      distinctStartTimes,
    });
  }

  // Most confident first, then by how much of the calendar they occupy, so the
  // interesting ones are at the top of a settings screen.
  const rank = { likely: 0, possible: 1, unlikely: 2 } as const;
  return candidates.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      b.occurrences - a.occurrences ||
      a.title.localeCompare(b.title),
  );
}
