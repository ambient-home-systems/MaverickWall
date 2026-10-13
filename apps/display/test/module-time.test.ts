import { describe, expect, it } from 'vitest';

import { nextIndex, untilWords, whenWords } from '../src/module-time.js';
import { panelFrom } from '../src/viewmodel.js';

/**
 * What a module's countdown and timeline say (plan item M7.5), and how the wall
 * reads contract 2's four kinds out of a manifest it does not trust.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-14T10:00:00Z');

describe('a countdown’s words', () => {
  it('says Now in the last minute and the minute after', () => {
    expect(untilWords(NOW + MIN, NOW)).toBe('Now');
    expect(untilWords(NOW, NOW)).toBe('Now');
    expect(untilWords(NOW - MIN + 1, NOW)).toBe('Now');
  });

  it('rounds minutes up while they are to come, so it never claims a minute fewer', () => {
    expect(untilWords(NOW + MIN + 1, NOW)).toBe('In 2 min');
    expect(untilWords(NOW + 59 * MIN + 1, NOW)).toBe('In 60 min');
    expect(untilWords(NOW - 5 * MIN - 30_000, NOW)).toBe('5 min ago');
  });

  it('says hours and minutes under two days, and whole days after', () => {
    expect(untilWords(NOW + HOUR, NOW)).toBe('In 1 h');
    expect(untilWords(NOW + 4 * HOUR + 20 * MIN + 59_000, NOW)).toBe('In 4 h 20 min');
    expect(untilWords(NOW + 2 * DAY - 1, NOW)).toBe('In 47 h 59 min');
    expect(untilWords(NOW + 2 * DAY, NOW)).toBe('In 2 days');
    expect(untilWords(NOW + 3 * DAY + 23 * HOUR, NOW)).toBe('In 3 days');
    expect(untilWords(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });
});

describe('a timeline’s times', () => {
  it('is the time alone today, and the weekday before it on another day, in the household’s zone', () => {
    const london = 'Europe/London';
    expect(whenWords(Date.parse('2026-10-14T13:00:00Z'), NOW, london, false)).toBe('14:00');
    expect(whenWords(Date.parse('2026-10-15T06:00:00Z'), NOW, london, false)).toBe('Thu 07:00');
    // 23:30 UTC is tomorrow in London, and still today in New York.
    expect(whenWords(Date.parse('2026-10-14T23:30:00Z'), NOW, london, false)).toBe('Thu 00:30');
    expect(whenWords(Date.parse('2026-10-14T23:30:00Z'), NOW, 'America/New_York', false)).toBe('19:30');
    expect(whenWords(Date.parse('2026-10-14T13:00:00Z'), NOW, london, true)).toBe('02:00 pm');
  });

  it('names the first item not yet reached as next, and none once all have passed', () => {
    const items = [{ at: NOW - HOUR }, { at: NOW }, { at: NOW + HOUR }];
    expect(nextIndex(items, NOW)).toBe(2);
    expect(nextIndex(items, NOW - 1)).toBe(1);
    expect(nextIndex(items, NOW + 2 * HOUR)).toBe(-1);
  });
});

describe('the wall reading contract 2', () => {
  it('keeps a code’s text exactly, and refuses one past what a code holds', () => {
    const vcard = 'BEGIN:VCARD\nFN:Dr Smith\nEND:VCARD';
    expect(panelFrom({ kind: 'qr', text: vcard, label: '  Dentist ' })).toEqual({ kind: 'qr', text: vcard, label: 'Dentist' });
    expect(panelFrom({ kind: 'qr', text: 'a'.repeat(213) })).not.toBeNull();
    expect(panelFrom({ kind: 'qr', text: 'a'.repeat(214) })).toBeNull();
    expect(panelFrom({ kind: 'qr', text: '' })).toBeNull();
  });

  it('reads a countdown’s instant only with its zone', () => {
    expect(panelFrom({ kind: 'countdown', label: 'Bins', at: '2026-10-16T07:00:00+01:00' })).toEqual({
      kind: 'countdown',
      label: 'Bins',
      at: Date.parse('2026-10-16T06:00:00Z'),
    });
    expect(panelFrom({ kind: 'countdown', label: 'Bins', at: '2026-10-16T07:00:00' })).toBeNull();
  });

  it('drops a timeline item it cannot read, and keeps the rest', () => {
    expect(
      panelFrom({
        kind: 'timeline',
        items: [
          { at: '2026-10-16T07:00:00Z', label: 'Bins', tone: 'alert' },
          { at: 'tomorrow', label: 'Lost' },
          { at: '2026-10-16T09:00:00Z', label: 'Dentist', detail: 'Dr Smith', tone: 'purple' },
        ],
      }),
    ).toEqual({
      kind: 'timeline',
      items: [
        { at: Date.parse('2026-10-16T07:00:00Z'), label: 'Bins', tone: 'alert' },
        { at: Date.parse('2026-10-16T09:00:00Z'), label: 'Dentist', detail: 'Dr Smith' },
      ],
    });
  });

  it('draws a picture only by a handle, never an address', () => {
    const handle = `${'a'.repeat(64)}.jpg`;
    expect(panelFrom({ kind: 'image', image: handle, caption: 'Radar' })).toEqual({ kind: 'image', image: handle, caption: 'Radar' });
    expect(panelFrom({ kind: 'image', image: 'https://example.com/a.jpg' })).toBeNull();
    expect(panelFrom({ kind: 'image', url: 'https://example.com/a.jpg' })).toBeNull();
    expect(panelFrom({ kind: 'image', image: `../${'a'.repeat(61)}.jpg` })).toBeNull();
  });
});
