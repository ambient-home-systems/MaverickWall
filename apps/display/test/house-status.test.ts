import { describe, expect, it } from 'vitest';
import { SERIES_POINTS, houseFrom } from '../src/viewmodel.js';
import { STATUS_RING_MS } from '../src/house-tiles.js';

/**
 * What the wall reads of a reading's day (plan item M6.10) and of a status
 * card's picture (plan item M6.8): the fixed shape and nothing else, so a
 * server one release ahead costs a line or a picture and never a reading.
 */
const reading = (extra: Record<string, unknown>) =>
  houseFrom({ readings: [{ key: 'abcdef12', label: 'Kitchen', value: '19.4', unit: '°C', ...extra }] }).readings[0];

describe('a reading’s day and picture, read defensively', () => {
  it('takes a series of the fixed length of numbers and gaps, and nothing else', () => {
    const day = Array.from({ length: SERIES_POINTS }, (_, i) => (i === 3 ? null : i));
    expect(reading({ series: day })?.series).toEqual(day);
    expect(reading({ series: day.slice(1) })?.series).toBeUndefined();
    expect(reading({ series: day.map((v) => (v === 0 ? '0' : v)) })?.series).toBeUndefined();
    expect(reading({ series: day.map((v) => (v === 1 ? Number.NaN : v)) })?.series).toBeUndefined();
    expect(reading({})?.series).toBeUndefined();
  });

  it('takes a picture only in the shape of a handle the server minted', () => {
    const handle = `${'ab'.repeat(32)}.jpg`;
    expect(reading({ picture: handle })?.picture).toBe(handle);
    expect(reading({ picture: '/api/image_proxy/light.x?token=t' })?.picture).toBeUndefined();
    expect(reading({ picture: `https://cdn.example/${handle}` })?.picture).toBeUndefined();
  });

  it('keeps the unit apart as well as joined, so a card can ask whether it is a percentage', () => {
    expect(reading({ value: '45', unit: '%' })).toMatchObject({ value: '45 %', unit: '%' });
    expect(reading({ value: 'Open', unit: null })?.unit).toBeUndefined();
  });

  it('breathes a finished card’s ring slowly', () => {
    // News, not an alarm: slower than a breath a second.
    expect(STATUS_RING_MS).toBeGreaterThanOrEqual(2000);
  });
});
