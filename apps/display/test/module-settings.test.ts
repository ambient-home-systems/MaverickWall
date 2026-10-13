import { describe, expect, it } from 'vitest';

import { effectiveSetting, moduleFields, nextSettings, storedSettings } from '../src/module-settings.js';

/**
 * What the Module widget's settings controls write (plan item M7.6). The rule
 * is that a widget stores only what it changes, so a setting left at the
 * install's value follows the install, and a widget whose every setting matches
 * draws the install's panel.
 */

const install = { city: 'london', units: 'true' };

describe('a Module widget’s settings', () => {
  it('stores a setting that differs from the install', () => {
    expect(nextSettings(undefined, install, 'city', 'york')).toEqual({ city: 'york' });
    expect(nextSettings({ city: 'york' }, install, 'units', 'false')).toEqual({ city: 'york', units: 'false' });
  });

  it('takes a setting off when it comes back to the install’s value, or is cleared', () => {
    expect(nextSettings({ city: 'york', units: 'false' }, install, 'city', 'london')).toEqual({ units: 'false' });
    expect(nextSettings({ city: 'york' }, install, 'city', '')).toBeUndefined();
    // A setting the install has no value for is cleared by blank alone.
    expect(nextSettings({ days: '5' }, install, 'days', '')).toBeUndefined();
  });

  it('never changes the settings it was handed', () => {
    const current = { city: 'york' };
    nextSettings(current, install, 'city', 'london');
    expect(current).toEqual({ city: 'york' });
  });

  it('shows the widget’s own value, else the install’s', () => {
    expect(effectiveSetting('city', install, { city: 'york' })).toBe('york');
    expect(effectiveSetting('city', install, undefined)).toBe('london');
    expect(effectiveSetting('days', install, undefined)).toBe('');
  });

  it('reads stored settings and a bootstrap defensively', () => {
    expect(storedSettings({ settings: { city: 'york', n: 3 } })).toEqual({ city: 'york' });
    expect(storedSettings({ settings: ['york'] })).toBeUndefined();
    expect(storedSettings({})).toBeUndefined();
    expect(
      moduleFields([
        { key: 'city', label: 'City', type: 'select', options: [] },
        { key: 'bad', label: 'Bad', type: 'select' },
        { key: 'x', label: 'X', type: 'colour' },
        { key: 'n', type: 'number' },
        null,
      ]).map((f) => f.key),
    ).toEqual(['city']);
    expect(moduleFields('nope')).toEqual([]);
  });
});
