import { describe, expect, it } from 'vitest';
import { analyseTitles, type TitleObservation } from '../src/domain/shift/titles.js';
import { matchShiftTitle } from '../src/domain/shift/resolve.js';

/**
 * Telling a rota apart from an appointment.
 *
 * Shaped after a real Google feed: shift markers on nearly every day in runs,
 * a fortnight-long block, ordinary appointments, a weekly class, a holiday, and
 * a weekly chore. Every one of those is all-day or recurring or both, so no
 * single signal separates them.
 */

const days = (start: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10),
  );

/** One observation per occurrence, so timed entries carry their own start time. */
const timed = (title: string, pairs: [string, string][]): TitleObservation[] =>
  pairs.map(([date, startTime]) => ({ title, dates: [date], allDay: false, startTime }));

const OBSERVATIONS: TitleObservation[] = [
  { title: 'Daddy - Working Day Shift', allDay: true, dates: [...days('2026-09-06', 4), ...days('2026-09-13', 4), ...days('2026-09-20', 3)] },
  { title: 'Daddy - Break Day', allDay: true, dates: [...days('2026-09-10', 3), ...days('2026-09-17', 3), ...days('2026-09-23', 4)] },
  { title: 'Daddy Working - Day Shift', allDay: true, dates: days('2026-10-04', 5) },
  { title: 'Daddy - Straights (Not on shift)', allDay: true, dates: days('2026-08-09', 14) },
  // The other parent's shifts, recorded as timed events at four different
  // start times. Requiring all-day, as an earlier version did, silently
  // excluded every household whose shifts have real hours attached.
  ...timed('Mommy working', [
    ['2026-09-01', '05:00'], ['2026-09-02', '05:00'], ['2026-09-05', '07:00'],
    ['2026-09-08', '07:00'], ['2026-09-12', '11:00'], ['2026-09-15', '11:00'],
    ['2026-09-19', '16:00'], ['2026-09-22', '16:00'], ['2026-09-26', '05:00'],
  ]),
  // A standing weekly class, always at the same hour.
  ...timed('Jui Jitsu/Muay Thai', [
    ['2026-09-03', '18:00'], ['2026-09-10', '18:00'], ['2026-09-17', '18:00'],
    ['2026-09-24', '18:00'], ['2026-10-01', '18:00'], ['2026-10-08', '18:00'],
  ]),
  ...timed('Town Council Meeting', [
    ['2026-09-02', '19:00'], ['2026-09-16', '19:00'], ['2026-10-07', '19:00'],
  ]),
  ...timed('Mommy nail appt', [['2026-09-10', '15:30']]),
  { title: 'Disney Trip', allDay: true, dates: days('2026-08-14', 9) },
  { title: 'Trash pickup', allDay: true, dates: ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30'] },
];

const candidates = analyseTitles({ observations: OBSERVATIONS, windowDays: 70 });
const by = (title: string) => candidates.find((candidate) => candidate.title === title);

describe('likely: strong evidence', () => {
  // A settings screen pre-selects these.
  it.each([
    'Daddy - Working Day Shift',
    'Daddy - Break Day',
    'Daddy Working - Day Shift',
    'Daddy - Straights (Not on shift)',
  ])('recognises %s', (title) => {
    expect(by(title)?.confidence).toBe('likely');
  });

  it('catches a feed’s own inconsistent wording', () => {
    // One real calendar writes both of these. Nobody typing patterns by hand
    // would have produced the second.
    expect(by('Daddy - Working Day Shift')?.confidence).toBe('likely');
    expect(by('Daddy Working - Day Shift')?.confidence).toBe('likely');
  });
});

describe('shifts recorded as timed events', () => {
  // Not every rota is all-day. Nurses, retail and hospitality shifts routinely
  // carry real start and end times, and an earlier version could not see any
  // of them.
  it('finds a rota with real hours', () => {
    expect(by('Mommy working')?.confidence).toBe('likely');
  });

  it('uses start-time variance as the signal', () => {
    // An appointment keeps its slot; only a shift moves around the clock.
    expect(by('Mommy working')?.distinctStartTimes).toBe(4);
    expect(by('Jui Jitsu/Muay Thai')?.distinctStartTimes).toBe(1);
  });

  it('leaves the shift type open when the wording does not say', () => {
    // "Mommy working" is unmistakably work and gives no clue whether it is a
    // day or a night. The right answer is to ask.
    expect(by('Mommy working')?.suggestedShiftKey).toBeUndefined();
  });
});

describe('possible: could be either, so ask', () => {
  // The tier that exists because "Work 09:00 every Monday" and a martial arts
  // class every Monday are indistinguishable from the data. Refusing to offer
  // the first because it resembles the second would be worse than offering
  // both.
  it('a weekly commitment at a fixed hour', () => {
    expect(by('Jui Jitsu/Muay Thai')?.confidence).toBe('possible');
    expect(by('Jui Jitsu/Muay Thai')?.reason).toContain('fixed shift or a standing commitment');
  });

  it('names the hour, so the person can recognise it', () => {
    expect(by('Jui Jitsu/Muay Thai')?.reason).toContain('18:00');
  });

  it('a recurring evening meeting', () => {
    expect(by('Town Council Meeting')?.confidence).toBe('possible');
  });

  it('a weekly all-day chore', () => {
    expect(by('Trash pickup')?.confidence).toBe('possible');
  });

  it('offers a plain nine-to-five rather than dropping it', () => {
    const weekdays = [
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
    ];
    const analysed = analyseTitles({
      windowDays: 70,
      observations: timed('Work', weekdays.map((date) => [date, '09:00'])),
    });
    expect(analysed[0]?.confidence).toBe('possible');
  });
});

describe('unlikely: hidden by default', () => {
  it('a one-off appointment', () => {
    expect(by('Mommy nail appt')?.confidence).toBe('unlikely');
    expect(by('Mommy nail appt')?.reason).toBe('happens once');
  });

  it('a holiday, which is one continuous block', () => {
    // Nine consecutive all-day events. Coverage cannot tell this apart from a
    // rota — it is 13% against Break Day's 14% — but block count can.
    expect(by('Disney Trip')?.confidence).toBe('unlikely');
    expect(by('Disney Trip')?.blocks).toBe(1);
    expect(by('Disney Trip')?.reason).toContain('single event');
  });
});

describe('suggesting a shift type', () => {
  it.each([
    ['Daddy - Working Day Shift', 'day'],
    ['Daddy - Straights (Not on shift)', 'straight'],
  ] as [string, string][])('%s reads as %s', (title, expected) => {
    expect(by(title)?.suggestedShiftKey).toBe(expected);
  });

  it('treats a break as explicitly not working', () => {
    expect(by('Daddy - Break Day')?.suggestedShiftKey).toBe(null);
  });

  it('offers nothing when the wording gives nothing away', () => {
    expect(by('Mommy nail appt')?.suggestedShiftKey).toBeUndefined();
  });
});

describe('ordering', () => {
  it('puts the confident ones first, for a settings screen', () => {
    const order = candidates.map((candidate) => candidate.confidence);
    const rank = { likely: 0, possible: 1, unlikely: 2 } as const;
    expect(order.map((c) => rank[c])).toEqual([...order.map((c) => rank[c])].sort());
  });

  it('finds both parents’ rotas and nothing else at the top tier', () => {
    expect(
      candidates.filter((c) => c.confidence === 'likely').map((c) => c.title).sort(),
    ).toEqual([
      'Daddy - Break Day',
      'Daddy - Straights (Not on shift)',
      'Daddy - Working Day Shift',
      // The same rota under the second spelling this feed uses.
      'Daddy Working - Day Shift',
      'Mommy working',
    ]);
  });
});

describe('match modes', () => {
  const one = (pattern: string, matchMode: 'exact' | 'contains' | 'regex') => [
    { shiftTypeKey: 'day', pattern, matchMode },
  ];

  it('exact will not match a longer title', () => {
    // The reason exact is the right default once somebody has picked a title
    // from a list: "Daddy - Break" must not also claim "Daddy - Break Day".
    expect(matchShiftTitle(one('Daddy - Break', 'exact'), 'Daddy - Break')).toBe('day');
    expect(matchShiftTitle(one('Daddy - Break', 'exact'), 'Daddy - Break Day')).toBeUndefined();
  });

  it('exact ignores case and surrounding space', () => {
    expect(matchShiftTitle(one('daddy - break', 'exact'), '  Daddy - Break ')).toBe('day');
  });

  it('contains is available for feeds that vary their wording', () => {
    expect(matchShiftTitle(one('break', 'contains'), 'Daddy - Break Day')).toBe('day');
  });

  it('keeps working for matchers stored before matchMode existed', () => {
    expect(matchShiftTitle([{ shiftTypeKey: 'day', pattern: 'break' }], 'Daddy - Break')).toBe('day');
    expect(
      matchShiftTitle([{ shiftTypeKey: 'day', pattern: '^Daddy', isRegex: true }], 'Daddy - X'),
    ).toBe('day');
  });
});
