import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PULSE,
  defaultState,
  modeOfRule,
  parseConditionChoices,
  ruleFor,
  showRuleOf,
  showWhenHint,
} from '../src/show-when.js';

/**
 * The editor's "Show this widget" (plan items M6.4, M6.5, M6.7): a rule is
 * written only once the server would take it, so a mode chosen and not
 * finished saves nothing rather than a refusal.
 */
const porch = { id: 'binary_sensor.porch', name: 'Porch', states: ['off', 'on'], moment: false };
const bell = { id: 'event.doorbell', name: 'Doorbell', states: [], moment: true };

describe('ruleFor', () => {
  it('writes each mode as the server reads it', () => {
    expect(ruleFor('while', porch.id, 'on', undefined, porch)).toEqual({ entity: porch.id, state: 'on' });
    expect(ruleFor('except', porch.id, 'on', 30, porch)).toEqual({ entity: porch.id, state: 'on', not: true });
    expect(ruleFor('after', porch.id, 'on', undefined, porch)).toEqual({ entity: porch.id, state: 'on', pulse: DEFAULT_PULSE });
    expect(ruleFor('after', bell.id, undefined, 30, bell)).toEqual({ entity: bell.id, pulse: 30 });
    expect(ruleFor('always', porch.id, 'on', undefined, porch)).toBeUndefined();
  });

  it('writes nothing it cannot finish', () => {
    // A moment is only ever "for a while after".
    expect(ruleFor('while', bell.id, undefined, undefined, bell)).toBeUndefined();
    // An entity with no states to start on waits for the field.
    expect(ruleFor('while', 'sensor.x', undefined, undefined, { id: 'sensor.x', name: 'x', states: [], moment: false })).toBeUndefined();
  });

  it('starts a sensor on "on", whatever it says this minute', () => {
    expect(defaultState(porch)).toBe('on');
    expect(defaultState({ ...porch, id: 'person.amy', states: ['work', 'home', 'not_home'] })).toBe('home');
    expect(defaultState({ ...porch, states: ['washing', 'idle'] })).toBe('washing');
    expect(defaultState(bell)).toBeUndefined();
  });
});

describe('reading a stored rule', () => {
  it('reads the mode back off the rule', () => {
    expect(modeOfRule({ entity: porch.id, state: 'on' })).toBe('while');
    expect(modeOfRule({ entity: porch.id, state: 'on', not: true })).toBe('except');
    expect(modeOfRule({ entity: porch.id, state: 'on', pulse: 30 })).toBe('after');
    expect(modeOfRule({ entity: bell.id, pulse: 30 })).toBe('after');
    expect(showRuleOf({ showWhen: { entity: 'Not an id' } })).toBeUndefined();
    expect(showRuleOf({})).toBeUndefined();
  });

  it('says what happens when the house is quiet, per mode', () => {
    expect(showWhenHint('while', false)).toContain('hidden');
    expect(showWhenHint('except', false)).toContain('is shown');
    expect(showWhenHint('after', true)).toContain('e-paper panel never shows it');
  });

  it('reads the server’s list defensively', () => {
    expect(parseConditionChoices({ connected: true, entities: [porch, { id: 'Bad' }, 7] })).toEqual({
      connected: true,
      entities: [porch],
    });
    expect(parseConditionChoices('nope')).toEqual({ connected: false, entities: [] });
  });
});
