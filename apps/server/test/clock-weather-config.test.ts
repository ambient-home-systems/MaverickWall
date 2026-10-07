import { describe, expect, it } from 'vitest';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { PANEL_HONOURS, PANEL_IGNORES } from '../src/epaper/honours.js';

/**
 * The clock's weather line (plan item M5.10), at the boundary and on a panel.
 */

describe('the readings a clock may ask for', () => {
  it('are humidity, wind and the UV index, and nothing else', () => {
    expect(widgetConfigBody.safeParse({ showWeather: true, weatherReadings: ['humidity', 'wind', 'uv'] }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ weatherReadings: [] }).success).toBe(true);
    for (const weatherReadings of [['pressure'], ['Wind'], 'wind', ['wind', 'wind', 'uv', 'humidity']]) {
      expect(widgetConfigBody.safeParse({ weatherReadings }).success, JSON.stringify(weatherReadings)).toBe(false);
    }
  });
});

describe('on a panel', () => {
  it('says the clock’s line is the wall’s, and keeps the agenda’s own sentence for the agenda', () => {
    const notes = (key: string, type: string) =>
      PANEL_IGNORES.filter((entry) => entry.key === key && (entry.types === undefined || entry.types.includes(type)));
    for (const key of ['showWeather', 'weatherReadings', 'icons']) {
      expect(notes(key, 'clock'), key).toHaveLength(1);
      expect(PANEL_HONOURS.clock, key).not.toContain(key);
    }
    expect(notes('showWeather', 'clock')[0]?.why).toContain('the forecast widget draws the weather');
    expect(notes('showWeather', 'calendar')).toHaveLength(1);
    expect(notes('showWeather', 'calendar')[0]?.why).toBe('the panel draws the date and the titles only.');
  });
});
