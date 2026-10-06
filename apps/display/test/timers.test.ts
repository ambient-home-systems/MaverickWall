import { describe, expect, it } from 'vitest';

import { TIMER_DONE_SHOWN_MS, messagesFrom, timerState, timersFrom } from '../src/viewmodel.js';

/**
 * Timers and messages on the wall (plan items M5.1–M5.2, MQ4): the words a
 * timer says from its end instant and the wall's own clock, and the two panels
 * read defensively — because a wall drawing from IndexedDB with the server gone
 * has nobody else to stop it saying "Done" for ever.
 */

const NOW = Date.UTC(2026, 9, 6, 9, 0, 0);

describe('timerState', () => {
  it.each([
    [10 * 60_000, 'running', '10 min left'],
    // Rounded up, so it never says a minute fewer than there is.
    [4 * 60_000 + 1, 'running', '5 min left'],
    [60_001, 'running', '2 min left'],
    [60 * 60_000, 'running', '1 h left'],
    [80 * 60_000, 'running', '1 h 20 min left'],
    [60_000, 'last-minute', 'Under a minute'],
    [1, 'last-minute', 'Under a minute'],
    [0, 'done', 'Done'],
    [-5 * 60_000, 'done', 'Done'],
  ])('with %i ms left is %s: %s', (left, phase, words) => {
    expect(timerState({ endsAt: NOW + left }, NOW)).toEqual({ phase, words });
  });
});

describe('timersFrom', () => {
  const timer = (key: string, endsAt: number, label?: string): Record<string, unknown> => ({
    key,
    startedAt: NOW - 60_000,
    endsAt,
    ...(label === undefined ? {} : { label }),
  });

  it('keeps a done timer for the window and not a moment longer, by the wall’s own clock', () => {
    const panel = {
      timers: [
        timer('tm-aaaaaaaaaaaa', NOW - TIMER_DONE_SHOWN_MS + 1, 'Kept'),
        timer('tm-bbbbbbbbbbbb', NOW - TIMER_DONE_SHOWN_MS, 'Gone'),
      ],
    };
    expect(timersFrom(panel, NOW).map((one) => one.label)).toEqual(['Kept']);
  });

  it('sorts soonest first, keeps four, refuses an id it did not mint, and cleans a label', () => {
    const panel = {
      timers: [
        timer('tm-000000000005', NOW + 5000),
        timer('tm-000000000001', NOW + 1000, 'Tea​‮'),
        timer('../etc/passwd', NOW + 500),
        timer('tm-000000000003', NOW + 3000),
        timer('tm-000000000002', NOW + 2000),
        timer('tm-000000000004', NOW + 4000),
        { key: 'tm-000000000006', startedAt: NOW, endsAt: 'soon' },
        'nonsense',
      ],
    };
    const timers = timersFrom(panel, NOW);
    expect(timers.map((one) => one.key)).toEqual([
      'tm-000000000001',
      'tm-000000000002',
      'tm-000000000003',
      'tm-000000000004',
    ]);
    expect(timers[0]!.label).toBe('Tea');
  });

  it('reads nothing from a panel that is not one', () => {
    expect(timersFrom(undefined, NOW)).toEqual([]);
    expect(timersFrom({ timers: 'no' }, NOW)).toEqual([]);
  });
});

describe('messagesFrom', () => {
  it('drops an expired message by the wall’s own clock, newest first, and keeps eight', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      key: `ms-${String(i).padStart(12, '0')}`,
      text: `Note ${i}`,
      postedAt: NOW - (10 - i) * 1000,
      expiresAt: i === 9 ? NOW : NOW + 60_000,
    }));
    const read = messagesFrom({ messages }, NOW);
    expect(read.map((one) => one.text)).toEqual(['Note 8', 'Note 7', 'Note 6', 'Note 5', 'Note 4', 'Note 3', 'Note 2', 'Note 1']);
  });

  it('cleans the text and refuses a message with none left, or an id it did not mint', () => {
    const read = messagesFrom(
      {
        messages: [
          { key: 'ms-aaaaaaaaaaaa', text: 'Back\nat 6\u0000', postedAt: NOW, expiresAt: NOW + 1 },
          { key: 'ms-bbbbbbbbbbbb', text: '​​', postedAt: NOW, expiresAt: NOW + 1 },
          { key: 'evil', text: 'Hi', postedAt: NOW, expiresAt: NOW + 1 },
        ],
      },
      NOW,
    );
    expect(read).toEqual([{ key: 'ms-aaaaaaaaaaaa', text: 'Back at 6', postedAt: NOW, expiresAt: NOW + 1 }]);
  });
});
