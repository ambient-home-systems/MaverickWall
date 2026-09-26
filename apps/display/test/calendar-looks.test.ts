import { describe, expect, it } from 'vitest';

import {
  EVENT_MARKS,
  GRID_LINES,
  MONTH_HEADINGS,
  TODAY_STYLES,
  monthLookClasses,
  monthLooks,
  treatmentLooks,
} from '../src/calendar-looks.js';
import { readableHue } from '../src/theme.js';

/*
 * The comfortable month's looks (plan item P5.4, part 4), resolved as data.
 * There is no DOM in this package's tests; what the stylesheet draws for each
 * class is measured in a real browser by `browser-calendar-looks.test.ts`.
 */

describe('the month looks', () => {
  it('reads an absence as each treatment’s own look, so no hanging wall moves', () => {
    expect(monthLooks({}, 'text')).toEqual({ today: 'ring', heading: 'hidden', mark: 'dot', rules: 'none' });
    expect(monthLooks({}, 'swiss')).toEqual({ today: 'numeral', heading: 'large', mark: 'dot', rules: 'week' });
    expect(monthLooks(undefined, 'pills')).toEqual(treatmentLooks('pills'));
    for (const treatment of ['text', 'swiss', 'pills', 'dots'] as const) {
      expect(monthLookClasses(monthLooks({}, treatment), treatment), treatment).toEqual([]);
    }
  });

  it('reads every stored value as itself, and a stranger’s as the treatment’s', () => {
    for (const today of TODAY_STYLES) expect(monthLooks({ todayStyle: today }, 'text').today).toBe(today);
    for (const heading of MONTH_HEADINGS) expect(monthLooks({ monthHeading: heading }, 'text').heading).toBe(heading);
    for (const mark of EVENT_MARKS) expect(monthLooks({ eventMark: mark }, 'swiss').mark).toBe(mark);
    for (const rules of GRID_LINES) expect(monthLooks({ gridLines: rules }, 'text').rules).toBe(rules);
    expect(monthLooks({ todayStyle: 'halo', monthHeading: 3, gridLines: 'grid' }, 'text')).toEqual(
      treatmentLooks('text'),
    );
  });

  it('never reads a mark or a rule on a treatment that draws no rows (Q1 keeps the grid off pills)', () => {
    const looks = monthLooks({ eventMark: 'text', gridLines: 'week', todayStyle: 'fill' }, 'pills');
    expect(looks.mark).toBe('dot');
    expect(looks.rules).toBe('none');
    expect(looks.today).toBe('fill');
    expect(monthLookClasses(looks, 'pills')).toEqual(['today-fill']);
  });

  it('rules a planner and a bold month by week unless the household said otherwise', () => {
    expect(monthLooks({ variant: 'planner' }, 'text').rules).toBe('week');
    expect(monthLooks({ variant: 'bold' }, 'text').rules).toBe('week');
    expect(monthLooks({ variant: 'bold', gridLines: 'none' }, 'text').rules).toBe('none');
    expect(monthLookClasses(monthLooks({ variant: 'planner' }, 'text'), 'text')).toEqual(['rules-week']);
    // The Swiss month is already ruled, so its planner carries no class for it.
    expect(monthLookClasses(monthLooks({ variant: 'planner' }, 'swiss'), 'swiss')).toEqual([]);
  });

  it('classes only what differs from the treatment', () => {
    expect(
      monthLookClasses(monthLooks({ todayStyle: 'numeral', eventMark: 'bar', gridLines: 'none' }, 'swiss'), 'swiss'),
    ).toEqual(['mark-bar', 'rules-none']);
  });
});

describe('a calendar colour as text', () => {
  const contrast = (a: string, b: string): number => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it('clears 4.5:1 on both grounds for every colour a household is given, on a dark and a light theme', () => {
    const palette = ['#4C7FD1', '#E8A33D', '#3FB0A8', '#D9534F', '#8E6BD1', '#FFFF00', '#101010'];
    for (const [bg, panel, ink] of [
      ['#14181E', '#1B2129', '#E8ECF1'],
      ['#FBF8F1', '#FFFFFF', '#241F19'],
    ] as const) {
      for (const hue of palette) {
        const drawn = readableHue(hue, bg, panel, ink);
        expect(contrast(drawn, bg), `${hue} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(drawn, panel), `${hue} on ${panel}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps a colour that already reads, and answers the ink for one it cannot parse', () => {
    expect(readableHue('#4C7FD1', '#FFFFFF', '#FFFFFF', '#000000')).not.toBe('#000000');
    expect(readableHue('#0B3D91', '#FFFFFF', '#FFFFFF', '#000000')).toBe('#0B3D91');
    expect(readableHue('var(--x)', '#FFFFFF', '#FFFFFF', '#000000')).toBe('#000000');
  });
});
