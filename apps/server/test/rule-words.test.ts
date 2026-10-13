import { describe, expect, it } from 'vitest';
import type { Interrupt, InterruptRule } from '@maverick-wall/core';

import { inHouseholdWords } from '../src/api/notifications.js';

/**
 * A Home Assistant rule's banner or takeover says the household's own sentence
 * — the form's "What to say" — with what it is about under it. Every other
 * source keeps the signal's words: a weather rule's name is a rung of the
 * ladder, and the warning's own name is what the wall should say.
 */

const rule = (over: Partial<InterruptRule> = {}): InterruptRule => ({
  id: 'r1',
  source: 'homeassistant',
  name: 'The freezer door is open',
  enabled: true,
  match: { entityId: 'binary_sensor.freezer_door', condition: { kind: 'equals', value: 'on', between: null } },
  action: 'banner',
  piercesNightMode: false,
  minDwellSec: 0,
  dismissible: true,
  priority: 40,
  ...over,
});

const interrupt = (over: Partial<Interrupt> = {}): Interrupt => ({
  ruleId: 'r1',
  key: 'binary_sensor.freezer_door',
  source: 'homeassistant',
  action: 'banner',
  title: 'Freezer door',
  headline: 'Open',
  severity: 'Unknown',
  urgency: 'Unknown',
  dismissible: true,
  wakeScreen: false,
  piercesNightMode: false,
  priority: 40,
  ...over,
});

describe('a Home Assistant alert in the household’s words', () => {
  it('leads with the rule’s sentence and says what it is about under it', () => {
    const [said] = inHouseholdWords([interrupt()], [rule()]);
    expect(said).toMatchObject({ title: 'The freezer door is open', headline: 'Freezer door · Open' });
  });

  it('names the thing alone where its state says nothing, as a doorbell’s does', () => {
    const { headline: _, ...bare } = interrupt({ title: 'Front door ring' });
    const [said] = inHouseholdWords([bare], [rule({ name: 'Somebody at the door' })]);
    expect(said).toMatchObject({ title: 'Somebody at the door', headline: 'Front door ring' });
  });

  it('leaves a weather warning in the warning’s own words', () => {
    const storm = interrupt({ source: 'nws', title: 'Tornado Warning', headline: 'Take shelter now' });
    const [said] = inHouseholdWords([storm], [rule({ source: 'nws', name: 'Extreme warnings' })]);
    expect(said).toEqual(storm);
  });

  it('changes nothing where there is no sentence to say, or it already says it', () => {
    for (const name of ['', '   ', 'Freezer door']) {
      expect(inHouseholdWords([interrupt()], [rule({ name })])).toEqual([interrupt()]);
    }
    expect(inHouseholdWords([interrupt()], [])).toEqual([interrupt()]);
  });
});
