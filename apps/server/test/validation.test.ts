import { describe, expect, it } from 'vitest';
import {
  blankIsAbsent,
  bounded,
  checkbox,
  colour,
  coordinate,
  hhmm,
  oneOf,
  optionalText,
  parse,
  parseJson,
  parseJsonOr,
  text,
  z,
} from '../src/validation.js';

/**
 * The boundary helpers.
 *
 * Two of these exist because of a specific Zod 4 behaviour that is easy to
 * write past and impossible to see: a `.transform()` on `z.unknown()` makes the
 * key **required**. An unticked checkbox is not sent by a browser at all, and
 * `"location": ""` is what Home Assistant sends on most calendar events — so
 * the naive spelling refused most form submissions and dropped most events,
 * while reading as obviously correct.
 */

describe('a checkbox', () => {
  const form = z.object({ wanted: checkbox() });

  it('is false when the browser sends nothing, which is what unticked means', () => {
    // The bug this exists for. `z.unknown().transform(...)` makes the key
    // required, so an unticked box failed the *whole form*.
    const shaped = parse(form, {});
    expect(shaped).toEqual({ ok: true, value: { wanted: false } });
  });

  it('is true for the value a ticked box sends', () => {
    expect(parse(form, { wanted: '1' })).toEqual({ ok: true, value: { wanted: true } });
    expect(parse(form, { wanted: 'on' })).toEqual({ ok: true, value: { wanted: true } });
  });

  it('is false for an empty string, which is not a tick', () => {
    expect(parse(form, { wanted: '' })).toEqual({ ok: true, value: { wanted: false } });
  });
});

describe('a field somebody else populates', () => {
  const shape = z.object({ id: z.string(), note: blankIsAbsent() });

  it('treats absent, empty and whitespace as the same answer', () => {
    /*
     * Home Assistant sends `"location": ""` on most calendar events.
     * `z.string().min(1).optional()` looks like this and refuses it, taking
     * the surrounding event with it.
     */
    for (const note of [undefined, '', '   ']) {
      const shaped = parse(shape, note === undefined ? { id: 'x' } : { id: 'x', note });
      expect(shaped.ok).toBe(true);
      if (shaped.ok) expect(shaped.value.note).toBeUndefined();
    }
  });

  it('keeps a real value, trimmed', () => {
    const shaped = parse(shape, { id: 'x', note: '  The pool  ' });
    expect(shaped.ok && shaped.value.note).toBe('The pool');
  });
});

describe('the wording', () => {
  it('says what to type, not what a type is', () => {
    // Zod's own would be "Invalid input: expected string, received undefined",
    // which tells somebody standing at a screen nothing at all.
    expect(parse(text('Your name'), undefined)).toMatchObject({
      ok: false,
      message: 'Your name is required.',
    });
    expect(parse(bounded('Events listed for today', 1, 20), '40')).toMatchObject({
      message: 'Events listed for today has to be between 1 and 20.',
    });
    expect(parse(hhmm('The daylight start'), '25:00')).toMatchObject({
      message: 'The daylight start has to be a time like 07:00.',
    });
    expect(parse(colour(), 'red')).toMatchObject({ message: 'Pick a colour from the swatch.' });
    expect(parse(coordinate('Latitude', 90), '400')).toMatchObject({
      message: 'Latitude has to be between -90 and 90.',
    });
    expect(parse(oneOf('a theme', ['board', 'slate']), 'neon')).toMatchObject({
      message: 'Choose a theme from the list.',
    });
  });

  it('reports the first problem rather than all of them', () => {
    // Somebody fixes one thing and presses the button again. A list is noise.
    const form = z.object({ name: text('A name'), url: text('An address') });
    const shaped = parse(form, {});
    expect(shaped.ok).toBe(false);
    if (!shaped.ok) expect(shaped.message).toBe('A name is required.');
  });
});

describe('never throwing', () => {
  it('turns bad JSON into a value, not an exception', () => {
    expect(parseJson(z.object({ a: z.string() }), 'not json')).toMatchObject({ ok: false });
    // `JSON.parse('null')` is valid JSON and is not an object — the case that
    // used to be a hand-written guard in the update check.
    expect(parseJson(z.object({ a: z.string() }), 'null')).toMatchObject({ ok: false });
  });

  it('falls back where there is nobody to tell', () => {
    // A forecast that will not parse is a missing panel, not an error page.
    expect(parseJsonOr(z.array(z.string()), 'not json', [])).toEqual([]);
    expect(parseJsonOr(z.array(z.string()), null, [])).toEqual([]);
    expect(parseJsonOr(z.array(z.string()), '["a"]', [])).toEqual(['a']);
  });
});

describe('rejecting rather than coercing', () => {
  it('does not accept a number where a form sends text', () => {
    // Rule five says reject, do not coerce. A latitude of `true` is not 1.
    expect(parse(coordinate('Latitude', 90), true)).toMatchObject({ ok: false });
    expect(parse(bounded('Weeks', 1, 8), 3)).toMatchObject({ ok: false });
  });

  it('trims but does not invent', () => {
    expect(parse(text('A name'), '   ')).toMatchObject({ ok: false });
    expect(parse(optionalText(), '   ')).toEqual({ ok: true, value: undefined });
  });
});
