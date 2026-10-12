import { describe, expect, it } from 'vitest';
import { houseFrom, notificationsFrom } from '../src/viewmodel.js';
import { trackTime } from '../src/render.js';

/**
 * What the wall reads of a player's track (plan item M6.9) and of the
 * Notifications widget's panel (plan item M6.11): words through the sanitiser,
 * numbers refused rather than clamped, handles only in the shape the server
 * mints — so a server one release ahead costs a line and never the widget.
 */
const reading = (extra: Record<string, unknown>) =>
  houseFrom({ readings: [{ key: 'abcdef12', label: 'Kitchen speaker', value: 'Playing', ...extra }] }).readings[0];

describe('a player’s track, read defensively (M6.9)', () => {
  it('keeps what plays, cleans its words and refuses numbers that are not times', () => {
    const media = reading({
      media: { title: 'Here‮ Comes', artist: 'Band', duration: 185, startedAt: 1_000, position: -4, album: 7 },
    })?.media;
    expect(media).toEqual({ title: 'Here Comes', artist: 'Band', duration: 185, startedAt: 1_000 });
    expect(reading({ media: { duration: 7 * 86_400 + 1 } })?.media).toEqual({});
  });

  it('marks a player by an object and nothing else', () => {
    expect(reading({ media: {} })?.media).toEqual({});
    expect(reading({ media: 'x' })?.media).toBeUndefined();
    expect(reading({})?.media).toBeUndefined();
  });

  it('writes a track’s time as a player does', () => {
    expect(trackTime(0)).toBe('0:00');
    expect(trackTime(65.9)).toBe('1:05');
    expect(trackTime(3725)).toBe('1:02:05');
  });
});

describe('the Notifications panel, read defensively (M6.11)', () => {
  it('takes tiles and Home Assistant’s by their own handles, and drops the rest', () => {
    const model = notificationsFrom({
      tiles: [
        { key: 'tile:aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Freezer\u0007 left open', detail: 'Freezer door · Open', tone: 'alert', dismissible: true },
        { key: 'han:aaaaaaaaaaaaaaaaaaaaaaaa', title: 'A notification is no tile' },
        { key: 'binary_sensor.freezer_door', title: 'An entity id is no handle' },
        { key: 'tile:bbbbbbbbbbbbbbbbbbbbbbbb', title: '' },
      ],
      ha: [
        { key: 'han:cccccccccccccccccccccccc', message: 'Backup failed', createdAt: 5 },
        { key: 'han:dddddddddddddddddddddddd', title: 'No words' },
        { key: 'tile:eeeeeeeeeeeeeeeeeeeeeeee', message: 'A tile is no notification' },
      ],
    });
    expect(model.tiles).toEqual([
      { key: 'tile:aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Freezer left open', detail: 'Freezer door · Open', alert: true, dismissible: true },
    ]);
    expect(model.ha).toEqual([{ key: 'han:cccccccccccccccccccccccc', message: 'Backup failed', createdAt: 5 }]);
    expect(notificationsFrom(undefined)).toEqual({ tiles: [], ha: [] });
  });
});
