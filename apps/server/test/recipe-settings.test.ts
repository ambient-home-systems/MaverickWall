import { describe, expect, it } from 'vitest';
import {
  fieldValue,
  normaliseConfig,
  recipeSchema,
  requestKey,
  widgetConfig,
  withReadingValues,
  type Recipe,
} from '../src/modules/external/recipe.js';
import { readSettingsForm, settingsControls, invalidSetting } from '../src/http/module-settings.js';
import { moduleVariantKey, variantBlockKey, widgetSettings } from '../src/api/module-variant.js';

/**
 * A recipe's typed settings and a widget's own (plan item M7.6), as pure
 * functions: what a recipe may declare, what a value must be, how a widget's
 * settings fold over the install's, and when two widgets share a request.
 */

const base = {
  name: 'Typed',
  contract: 1,
  fetch: { url: 'https://example.com/w?city={city}&n={days}&u={units}&t={outside}' },
  panel: { kind: 'text', text: '{x}' },
};

/** A recipe whose address names no setting, so only the fields can refuse it. */
const parse = (config: unknown[]): ReturnType<typeof recipeSchema.safeParse> =>
  recipeSchema.safeParse({ ...base, fetch: { url: 'https://example.com/w' }, config });

const typed = (): Recipe => {
  const result = recipeSchema.safeParse({ ...base, config: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: [
        { value: 'london', label: 'London' },
        { value: 'york', label: 'York' },
      ],
      default: 'london',
    },
    { key: 'days', label: 'Days', type: 'number', min: 1, max: 7, default: '3' },
    { key: 'units', label: 'Units', type: 'boolean', default: 'true' },
    { key: 'outside', label: 'Outside', type: 'ha_reading' },
  ] });
  if (!result.success) throw new Error(result.error.message);
  return result.data;
};

describe('a recipe’s typed settings', () => {
  it('reads a field with no type as text, as every recipe before this did', () => {
    const result = recipeSchema.safeParse({
      ...base,
      fetch: { url: 'https://example.com/w?city={city}' },
      config: [{ key: 'city', label: 'City', default: 'x' }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.config[0]?.type).toBe('string');
  });

  it('refuses a field that contradicts itself', () => {
    // The control: the same shapes, consistent, are taken.
    expect(parse([{ key: 'n', label: 'N', type: 'number', min: 1, max: 5, default: '3' }]).success).toBe(true);
    expect(
      parse([{ key: 's', label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }], default: 'a' }]).success,
    ).toBe(true);
    expect(parse([{ key: 'r', label: 'R', type: 'ha_reading' }]).success).toBe(true);
    expect(parse([{ key: 'n', label: 'N', type: 'number', min: 5, max: 1 }]).success).toBe(false);
    expect(parse([{ key: 'n', label: 'N', type: 'number', max: 3, default: '9' }]).success).toBe(false);
    expect(parse([{ key: 'n', label: 'N', type: 'number', default: 'nine' }]).success).toBe(false);
    expect(parse([{ key: 'b', label: 'B', type: 'boolean', default: 'yes' }]).success).toBe(false);
    expect(
      parse([{ key: 's', label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }], default: 'b' }]).success,
    ).toBe(false);
    expect(
      parse([
        {
          key: 's',
          label: 'S',
          type: 'select',
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'Again' },
          ],
        },
      ]).success,
    ).toBe(false);
    expect(parse([{ key: 'r', label: 'R', type: 'ha_reading', default: 'sensor.x' }]).success).toBe(false);
    expect(parse([{ key: 'q', label: 'Q', type: 'colour' }]).success).toBe(false);
  });

  it('takes a value only in its field’s own shape, and never coerces one', () => {
    const [city, days, units, outside] = typed().config;
    if (city === undefined || days === undefined || units === undefined || outside === undefined) throw new Error();
    expect(fieldValue(city, 'york')).toBe('york');
    expect(fieldValue(city, 'York')).toBeUndefined();
    expect(fieldValue(days, '7')).toBe('7');
    expect(fieldValue(days, '8')).toBeUndefined();
    expect(fieldValue(days, '0')).toBeUndefined();
    expect(fieldValue(days, ' 3')).toBeUndefined();
    expect(fieldValue(days, '3e0')).toBeUndefined();
    expect(fieldValue(units, 'false')).toBe('false');
    expect(fieldValue(units, '1')).toBeUndefined();
    expect(fieldValue(outside, 'sensor.outside_temp')).toBe('sensor.outside_temp');
    expect(fieldValue(outside, 'not an entity')).toBeUndefined();
  });

  it('falls back to the default for an install value it would not take', () => {
    expect(normaliseConfig(typed(), { city: 'paris', days: '99', units: 'maybe', outside: 'x y' })).toEqual({
      city: 'london',
      days: '3',
      units: 'true',
      outside: '',
    });
  });
});

describe('a widget’s settings over the install’s', () => {
  const recipe = typed();
  const install = { city: 'london', days: '3', units: 'true', outside: '' };

  it('takes each valid setting and leaves the rest to the install', () => {
    expect(widgetConfig(recipe, install, { city: 'york', days: '9', units: 'nope' })).toEqual({
      city: 'york',
      days: '3',
      units: 'true',
      outside: '',
    });
  });

  it('shares a request between widgets that differ only where no request reads', () => {
    const a = requestKey(recipe, widgetConfig(recipe, install, { city: 'york' }));
    const b = requestKey(recipe, widgetConfig(recipe, install, { city: 'york', units: 'true' }));
    const c = requestKey(recipe, widgetConfig(recipe, install, { city: 'york', units: 'false' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps a secret as its placeholder in the request it is told apart by', () => {
    const secret = recipeSchema.parse({
      ...base,
      config: [],
      fetch: { url: 'https://example.com/w', headers: { authorization: 'Bearer {secret:token}' } },
      secrets: [{ key: 'token', label: 'Token' }],
    });
    expect(requestKey(secret, {})).toContain('{secret:token}');
  });

  it('sends a watched reading’s value in place of its id, and nothing for the rest', () => {
    const values = new Map([['sensor.outside_temp', '12.5']]);
    expect(
      withReadingValues(recipe, { ...install, outside: 'sensor.outside_temp' }, (id) => values.get(id)).outside,
    ).toBe('12.5');
    expect(withReadingValues(recipe, { ...install, outside: 'sensor.gone' }, (id) => values.get(id)).outside).toBe('');
  });
});

describe('the variant key', () => {
  it('is the same for the same settings however they were written', () => {
    expect(moduleVariantKey('m', { a: '1', b: '2' })).toBe(moduleVariantKey('m', { b: '2', a: '1' }));
    expect(moduleVariantKey('m', { a: '1' })).not.toBe(moduleVariantKey('n', { a: '1' }));
    expect(moduleVariantKey('m', { a: '1' })).toMatch(/^[0-9a-f]{16}$/);
    expect(variantBlockKey('m', 'k')).toBe('ext:m~k');
  });

  it('reads a widget’s settings only when they are strings', () => {
    expect(widgetSettings({ settings: { a: '1', b: 2 } })).toEqual({ a: '1' });
    expect(widgetSettings({ settings: [] })).toBeNull();
    expect(widgetSettings({})).toBeNull();
  });
});

describe('the install page’s controls', () => {
  const recipe = typed();

  it('draws each setting as its own control', () => {
    const html = settingsControls(recipe.config, undefined, [{ id: 'sensor.outside_temp', name: 'Outside' }], 'example.com');
    expect(html).toContain('name="cfg_city"');
    expect(html).toContain('<option value="london" selected>London</option>');
    expect(html).toMatch(/type="number"[^>]*name="cfg_days"|name="cfg_days"[^>]*type="number"/);
    expect(html).toContain('min="1"');
    expect(html).toContain('max="7"');
    expect(html).toMatch(/type="checkbox"[^>]*name="cfg_units"|name="cfg_units"[^>]*type="checkbox"/);
    expect(html).toContain('<option value="sensor.outside_temp">Outside</option>');
    expect(html).toContain('to example.com');
  });

  it('says how to offer a reading when none is watched', () => {
    expect(settingsControls(recipe.config, undefined, [], 'example.com')).toContain(
      'Watch a reading under Home Assistant › Readings',
    );
  });

  it('reads an unsent switch as off, and refuses a value in the wrong shape by name', () => {
    expect(readSettingsForm(recipe.config, { cfg_city: 'york', cfg_days: '5' })).toEqual({
      values: { city: 'york', days: '5', units: 'false', outside: '' },
    });
    expect(readSettingsForm(recipe.config, { cfg_days: '12' }).error).toBe('“Days” needs a number from 1 to 7.');
    expect(readSettingsForm(recipe.config, { cfg_city: 'paris' }).error).toBe('“City” needs one of its choices.');
    expect(invalidSetting(recipe.config, { units: 'yes' })).toBe('“Units” is on or off.');
    expect(invalidSetting(recipe.config, { days: '' })).toBeUndefined();
  });
});
