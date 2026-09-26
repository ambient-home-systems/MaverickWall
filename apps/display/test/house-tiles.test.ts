import { describe, expect, it } from 'vitest';
import {
  TILE_KEEP,
  barKeepsEveryTile,
  barPercent,
  changedWords,
  tileOptions,
  tileTone,
  tileWords,
} from '../src/house-tiles.js';
import {
  HOUSE_TILE_TIERS,
  TILE_COLUMN_CH,
  rungsByPriority,
  tileColumnsAt,
  widgetTierFor,
} from '../src/widget-tiers.js';
import type { HouseReadingModel } from '../src/viewmodel.js';

/**
 * Home Assistant's `tile` look, as decisions (plan item P5.3). The drawing is
 * `browser-ha-tile.test.ts`'s; this is every rule a draw is built from, where
 * each can be asked without a browser.
 */

const reading = (extra: Partial<HouseReadingModel> = {}): HouseReadingModel => ({
  label: 'Front door',
  value: 'Open',
  glyph: 'door',
  mode: 'label_value',
  stale: false,
  ...extra,
});

describe('a tile’s options', () => {
  it('reads every absence as the documented default, and nothing else as a choice', () => {
    expect(tileOptions(undefined)).toEqual({ layout: 'horizontal', hideState: false, showChanged: false, showBar: false });
    expect(tileOptions({ tileLayout: 'vertical', hideState: true, showChanged: true, showBar: true })).toEqual({
      layout: 'vertical', hideState: true, showChanged: true, showBar: true,
    });
    // A newer server's word, a string for a boolean: the default, never a guess.
    expect(tileOptions({ tileLayout: 'diagonal', hideState: 'yes', showBar: 1 })).toEqual(tileOptions({}));
  });

  it('says the name over the state, and when it changed only on the state’s line', () => {
    expect(tileWords(tileOptions({}))).toEqual(['name', 'state']);
    expect(tileWords(tileOptions({ showChanged: true }))).toEqual(['name', 'state', 'changed']);
    // "5 min ago" under a name is five minutes since what?
    expect(tileWords(tileOptions({ hideState: true, showChanged: true }))).toEqual(['name']);
  });
});

describe('what a narrow tile keeps', () => {
  it('keeps the state before the name, and the name before the time, in drawing order', () => {
    expect(TILE_KEEP).toEqual(['state', 'name', 'changed']);
    const all = tileWords(tileOptions({ showChanged: true }));
    const [t0, t1, t2] = HOUSE_TILE_TIERS.horizontal;
    expect(rungsByPriority(t0!, all, TILE_KEEP)).toEqual(['state']);
    expect(rungsByPriority(t1!, all, TILE_KEEP)).toEqual(['name', 'state']);
    expect(rungsByPriority(t2!, all, TILE_KEEP)).toEqual(['name', 'state', 'changed']);
    // A tile whose household hid the state still says its name at the floor.
    expect(rungsByPriority(t0!, ['name'], TILE_KEEP)).toEqual(['name']);
  });

  it('climbs in width and never shrinks a rung on either axis', () => {
    for (const table of Object.values(HOUSE_TILE_TIERS)) {
      for (let i = 1; i < table.length; i++) {
        expect(table[i]!.minCh).toBeGreaterThan(table[i - 1]!.minCh);
        expect(table[i]!.minEm).toBeGreaterThanOrEqual(table[i - 1]!.minEm);
        expect(table[i]!.rungs).toBe(table[i - 1]!.rungs + 1);
      }
    }
  });

  it('opens a column exactly where a tile can say its name and its state', () => {
    // `TILE_COLUMN_CH` is T1's width: narrower than that a box draws fewer
    // tiles, each saying more, rather than more tiles saying one word each.
    for (const layout of ['horizontal', 'vertical'] as const) {
      expect(TILE_COLUMN_CH[layout]).toBe(HOUSE_TILE_TIERS[layout][1]!.minCh);
      const ch = 10;
      const tier = widgetTierFor(HOUSE_TILE_TIERS[layout], TILE_COLUMN_CH[layout] * ch, 1000, ch, 25);
      expect(tier.tier).toBe('T1');
    }
  });
});

describe('how many tiles sit across', () => {
  it('charges the gaps between them', () => {
    // Three 200px tiles need two 10px gaps: 620px holds three, 619 two.
    expect(tileColumnsAt(620, 10, 10, 20)).toBe(3);
    expect(tileColumnsAt(619, 10, 10, 20)).toBe(2);
    // With the gaps left out the same 600px would promise three.
    expect(tileColumnsAt(600, 10, 10, 20)).toBe(2);
    expect(tileColumnsAt(600, 0, 10, 20)).toBe(3);
  });

  it('never answers fewer than one', () => {
    expect(tileColumnsAt(0, 10, 10, 20)).toBe(1);
    expect(tileColumnsAt(50, 10, 10, 20)).toBe(1);
    expect(tileColumnsAt(600, 10, 0, 20)).toBe(1);
  });
});

describe('when it changed', () => {
  const now = Date.UTC(2026, 8, 26, 11, 0, 0);
  it('is floored, so thirty seconds is not a minute', () => {
    expect(changedWords(now - 30_000, now)).toBe('just now');
    expect(changedWords(now - 59_999, now)).toBe('just now');
    expect(changedWords(now - 60_000, now)).toBe('1 min ago');
    expect(changedWords(now - 5 * 60_000 - 59_000, now)).toBe('5 min ago');
    expect(changedWords(now - 59 * 60_000, now)).toBe('59 min ago');
    expect(changedWords(now - 60 * 60_000, now)).toBe('1 h ago');
    expect(changedWords(now - 47 * 3_600_000, now)).toBe('47 h ago');
    expect(changedWords(now - 48 * 3_600_000, now)).toBe('2 days ago');
  });

  it('says "just now" for a house clock a little ahead of the wall’s, and nothing for no time', () => {
    expect(changedWords(now + 20_000, now)).toBe('just now');
    expect(changedWords(undefined, now)).toBeUndefined();
    expect(changedWords(Number.NaN, now)).toBeUndefined();
  });
});

describe('the circle and the bar', () => {
  it('colours by the server’s two tones, and everything else idle', () => {
    expect(tileTone(reading({ tone: 'active' }))).toBe('active');
    expect(tileTone(reading({ tone: 'alert' }))).toBe('alert');
    expect(tileTone(reading())).toBe('idle');
  });

  it('fills the bar with the level the words say, and draws none without one', () => {
    expect(barPercent(reading({ level: 60 }))).toBe(60);
    expect(barPercent(reading({ level: 0 }))).toBe(0);
    expect(barPercent(reading())).toBeUndefined();
  });

  it('keeps the bar only where the box shows every tile it would without it', () => {
    expect(barKeepsEveryTile(4, 4)).toBe(true);
    expect(barKeepsEveryTile(2, 4)).toBe(false);
    expect(barKeepsEveryTile(1, 3)).toBe(false);
  });
});
