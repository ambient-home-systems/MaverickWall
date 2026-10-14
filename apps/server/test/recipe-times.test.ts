import { describe, expect, it } from 'vitest';
import { recipeSchema, runRecipePanel, type Recipe } from '../src/modules/external/recipe.js';

/**
 * What seeding the store found the recipe language could not say (plan item
 * M7.11), held here so the store's fixtures are not the only thing that would
 * notice it going:
 *
 * - a feed's time with no zone is read as UTC on every server, where it used
 *   to be read in whatever zone the server ran in;
 * - `iso` writes any time a recipe can read as the instant a timeline wants;
 * - `date:short` and `date:relative` speak the household's zone and count
 *   calendar days, as `time` already did;
 * - `.` is the whole answer, and a path may start with an index, so a feed
 *   that answers a list at the top can be read at all.
 *
 * The tests run with `TZ` set to Pacific/Chatham (vitest.config.ts), so a
 * reading that leans on the server's zone is thirteen and three-quarter hours
 * wrong here rather than right by accident.
 */

const recipe = (panel: unknown): Recipe => {
  const parsed = recipeSchema.safeParse({ name: 'T', contract: 1, fetch: { url: 'https://example.com/t' }, panel });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
};
const takes = (panel: unknown): boolean =>
  recipeSchema.safeParse({ name: 'T', contract: 1, fetch: { url: 'https://example.com/t' }, panel }).success;

function says(template: string, body: unknown, now: number, timezone = 'Europe/London'): string {
  const built = runRecipePanel(recipe({ kind: 'text', text: template }), body, now, {}, timezone);
  if (!built.ok) throw new Error(built.error);
  return (built.panel as { text: string }).text;
}

const NOW = Date.parse('2026-10-14T12:00:00Z');

describe('a time with no zone', () => {
  it('is read as UTC, whatever zone the server runs in', () => {
    expect(says('{t | iso}', { t: '2026-10-14 02:56' }, NOW)).toBe('2026-10-14T02:56:00Z');
    expect(says('{t | iso}', { t: '2026-10-15T03:00:00' }, NOW)).toBe('2026-10-15T03:00:00Z');
    // London is on summer time, an hour ahead of UTC.
    expect(says('{t | time}', { t: '2026-10-14 02:56' }, NOW)).toBe('03:56');
  });

  it('leaves a time that names its zone as it says', () => {
    expect(says('{t | iso}', { t: '2026-10-14T07:50:00.000-04:00' }, NOW)).toBe('2026-10-14T11:50:00Z');
    expect(says('{t | iso}', { t: '2026-10-14T02:56:00Z' }, NOW)).toBe('2026-10-14T02:56:00Z');
  });

  it('sorts as the instant it is', () => {
    const built = runRecipePanel(
      recipe({
        kind: 'readings',
        items: { for: 'rows', label: '{n}', value: '{t | time}', sort: { by: 't', as: 'time' } },
      }),
      { rows: [{ n: 'b', t: '2026-10-14 10:00' }, { n: 'a', t: '2026-10-14T09:30:00Z' }] },
      NOW,
      {},
      'UTC',
    );
    expect(built.ok && (built.panel as { items: { label: string }[] }).items.map((row) => row.label)).toEqual(['a', 'b']);
  });
});

describe('iso', () => {
  it('writes seconds and milliseconds since 1970 as an instant', () => {
    expect(says('{t | iso}', { t: 1791974987 }, NOW)).toBe('2026-10-14T10:49:47Z');
    expect(says('{t | iso}', { t: 1791974987588 }, NOW)).toBe('2026-10-14T10:49:47.588Z');
  });

  it('leaves what is not a time as it is, for the panel to refuse', () => {
    expect(says('{t | iso}', { t: 'Oct/14/2026 07 AM' }, NOW)).toBe('Oct/14/2026 07 AM');
  });

  it('makes a timeline from a feed whose times name no zone', () => {
    const built = runRecipePanel(
      recipe({ kind: 'timeline', items: { for: 'p', at: '{t | iso}', label: '{type}' } }),
      { p: [{ t: '2026-10-14 15:12', type: 'H' }, { t: '2026-10-14 09:01', type: 'L' }] },
      NOW,
    );
    expect(built.ok && built.panel).toEqual({
      kind: 'timeline',
      items: [
        { at: '2026-10-14T09:01:00Z', label: 'L' },
        { at: '2026-10-14T15:12:00Z', label: 'H' },
      ],
    });
  });
});

describe('date', () => {
  it('writes the date in the household’s zone, not the server’s', () => {
    // 14:58 UTC on the 10th is the 11th in Chatham, where the tests run.
    expect(says('{t | date:short}', { t: '2026-10-10T14:58:00Z' }, NOW, 'America/New_York')).toBe('10 Oct');
    expect(says('{t | date:short}', { t: '2026-10-10T14:58:00Z' }, NOW, 'Pacific/Auckland')).toBe('11 Oct');
  });

  it('counts calendar days in the household’s zone for relative', () => {
    // At 01:00 in London, 23:00 the same evening is today, not tomorrow.
    const lateAtNight = Date.parse('2026-10-14T00:00:00Z');
    expect(says('{t | date:relative}', { t: '2026-10-14T22:00:00Z' }, lateAtNight)).toBe('today');
    expect(says('{t | date:relative}', { t: '2026-10-14T23:30:00Z' }, lateAtNight)).toBe('tomorrow');
    expect(says('{t | date:relative}', { t: '2026-10-13T23:30:00Z' }, lateAtNight)).toBe('today');
    expect(says('{t | date:relative}', { t: '2026-10-11T12:00:00Z' }, lateAtNight)).toBe('3 days ago');
  });

  it('never moves a bare calendar date into a zone', () => {
    // Christmas is the 25th in New York and in Auckland, whatever UTC says.
    expect(says('{d | date:short}', { d: '2026-12-25' }, NOW, 'America/New_York')).toBe('25 Dec');
    expect(says('{d | date:short}', { d: '2026-12-25' }, NOW, 'Pacific/Auckland')).toBe('25 Dec');
    // 20:00 on the 14th in New York is still the 14th there: the 25th is 72 days away.
    const evening = Date.parse('2026-10-15T00:00:00Z');
    expect(says('{d | date:relative}', { d: '2026-12-25' }, evening, 'America/New_York')).toBe('in 72 days');
    expect(says('{d | date:relative}', { d: '2026-10-14' }, evening, 'America/New_York')).toBe('today');
  });

  it('falls back to UTC for a zone this runtime does not know', () => {
    expect(says('{t | date:short}', { t: '2026-10-10T23:30:00Z' }, NOW, 'Mars/Olympus_Mons')).toBe('10 Oct');
  });
});

describe('a feed that answers a list at the top', () => {
  it('is read whole with `.`, and by index with `[0]`', () => {
    expect(takes({ kind: 'readings', items: { for: '.', label: '{a}', value: '{b}' } })).toBe(true);
    expect(takes({ kind: 'text', text: '{[0].a} and {[1].b}' })).toBe(true);
    const built = runRecipePanel(
      recipe({ kind: 'readings', title: '{[0].a}', items: { for: '.', label: '{a}', value: '{b}' } }),
      [{ a: 'one', b: '1' }, { a: 'two', b: '2' }],
      NOW,
    );
    expect(built.ok && built.panel).toEqual({
      kind: 'readings',
      title: 'one',
      items: [
        { label: 'one', value: '1' },
        { label: 'two', value: '2' },
      ],
    });
  });

  it('still refuses what is not a path', () => {
    expect(takes({ kind: 'readings', items: { for: '..', label: '{a}', value: '{b}' } })).toBe(false);
    expect(takes({ kind: 'readings', items: { for: '.a', label: '{a}', value: '{b}' } })).toBe(false);
    expect(takes({ kind: 'text', text: '{a > 3}' })).toBe(false);
  });
});
