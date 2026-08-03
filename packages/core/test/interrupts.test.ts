import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_RULES,
  EDGE_WINDOW_MS,
  evaluateInterrupts,
  evaluateRules,
  resolveConflicts,
  withinWindow,
  type Interrupt,
  type InterruptRule,
  type Signal,
} from '../src/domain/interrupts/index.js';

/**
 * The interrupt model.
 *
 * The tests that matter most here are the last two blocks: three sources
 * matching through one evaluator, and the shipped ladder actually behaving the
 * way its comments claim. A model that only ever saw weather alerts would pass
 * everything above them and still be the wrong model.
 */

const NOW = Date.parse('2026-08-02T12:00:00Z');
const NOON = '13:00';

function rule(over: Partial<InterruptRule> = {}): InterruptRule {
  return {
    id: 'r1',
    source: 'nws',
    name: 'Test rule',
    enabled: true,
    match: { minSeverity: 'Severe' },
    action: 'banner',
    piercesNightMode: false,
    minDwellSec: 0,
    dismissible: true,
    priority: 10,
    ...over,
  };
}

function alert(over: Partial<Signal> = {}): Signal {
  return {
    source: 'nws',
    key: 'urn:oid:2.49.0.1.840.0.abc',
    title: 'Tornado Warning',
    headline: 'Take shelter now',
    area: 'Howard, MD',
    sender: 'NWS Baltimore/Washington',
    severity: 'Extreme',
    urgency: 'Immediate',
    since: NOW - 60_000,
    expiresAt: NOW + 30 * 60_000,
    ...over,
  };
}

const base = { now: NOW, localHhmm: NOON };

describe('matching', () => {
  it('compares severity as a ladder rather than an equality', () => {
    const severe = rule({ match: { minSeverity: 'Severe' } });
    expect(evaluateRules({ ...base, rules: [severe], signals: [alert({ severity: 'Extreme' })] })).toHaveLength(1);
    expect(evaluateRules({ ...base, rules: [severe], signals: [alert({ severity: 'Severe' })] })).toHaveLength(1);
    expect(evaluateRules({ ...base, rules: [severe], signals: [alert({ severity: 'Moderate' })] })).toHaveLength(0);
  });

  it('never lets a missing severity clear a bar by accident', () => {
    // A provider that omits the field must not be treated as the worst case.
    const severe = rule({ match: { minSeverity: 'Severe' } });
    const nothing = evaluateRules({
      ...base,
      rules: [severe],
      signals: [{ source: 'nws', key: 'x', title: 'Something' }],
    });
    expect(nothing).toHaveLength(0);
  });

  it('matches an event by name, case-insensitively', () => {
    const named = rule({ match: { eventTypes: ['tornado warning', 'Flash Flood Warning'] } });
    expect(evaluateRules({ ...base, rules: [named], signals: [alert()] })).toHaveLength(1);
    expect(
      evaluateRules({ ...base, rules: [named], signals: [alert({ title: 'Frost Advisory' })] }),
    ).toHaveLength(0);
  });

  it('refuses a rule whose match says nothing', () => {
    /*
     * An empty match reads as "everything", and one bad row would cover the
     * wall with every signal in the house. A half-written rule should do
     * nothing rather than everything.
     */
    expect(evaluateRules({ ...base, rules: [rule({ match: {} })], signals: [alert()] })).toEqual([]);
  });

  it('never matches a signal from another source', () => {
    // The rule is about a door; the signal is a tornado. Both have a `key`.
    const door = rule({ source: 'homeassistant', match: { entityId: 'urn:oid:2.49.0.1.840.0.abc' } });
    expect(evaluateRules({ ...base, rules: [door], signals: [alert()] })).toEqual([]);
  });

  it('does not fire on something that has already expired', () => {
    // Client-side expiry: an alert clears on its own `expires` even when the
    // poll that would have removed it never arrived.
    const expired = alert({ expiresAt: NOW - 1 });
    expect(evaluateRules({ ...base, rules: [rule()], signals: [expired] })).toEqual([]);
  });
});

describe('dwell, edges and hours', () => {
  it('holds a rule until the signal has lasted long enough', () => {
    const held = rule({ source: 'homeassistant', match: { entityId: 'door' }, minDwellSec: 300 });
    const door = (sinceMs: number): Signal => ({
      source: 'homeassistant', key: 'door', title: 'Freezer door', state: 'on', since: NOW - sinceMs,
    });
    expect(evaluateRules({ ...base, rules: [held], signals: [door(60_000)] })).toHaveLength(0);
    expect(evaluateRules({ ...base, rules: [held], signals: [door(600_000)] })).toHaveLength(1);
  });

  it('reads changed_to as an edge, from a timestamp', () => {
    const edge = rule({
      source: 'homeassistant',
      match: { entityId: 'door', condition: { kind: 'changed_to', value: 'on', between: null } },
    });
    const door = (sinceMs: number): Signal => ({
      source: 'homeassistant', key: 'door', title: 'Door', state: 'on', since: NOW - sinceMs,
    });
    expect(evaluateRules({ ...base, rules: [edge], signals: [door(30_000)] })).toHaveLength(1);
    // Still `on`, but it became `on` hours ago. The edge is over.
    expect(evaluateRules({ ...base, rules: [edge], signals: [door(EDGE_WINDOW_MS + 1)] })).toHaveLength(0);
  });

  it('wraps a time window past midnight, because every overnight rule does', () => {
    const night = { from: '23:00', to: '06:00' };
    expect(withinWindow(night, '23:30')).toBe(true);
    expect(withinWindow(night, '02:00')).toBe(true);
    expect(withinWindow(night, '05:59')).toBe(true);
    expect(withinWindow(night, '06:00')).toBe(false);
    expect(withinWindow(night, '16:00')).toBe(false);
    expect(withinWindow({ from: '12:00', to: '17:00' }, '13:00')).toBe(true);
  });

  it('applies an hours window against the clock it is given', () => {
    const overnight = rule({
      source: 'homeassistant',
      match: {
        entityId: 'garage',
        condition: { kind: 'equals', value: 'on', between: { from: '23:00', to: '06:00' } },
      },
    });
    const garage: Signal = {
      source: 'homeassistant', key: 'garage', title: 'Garage', state: 'on', since: NOW - 3_600_000,
    };
    expect(evaluateRules({ ...base, rules: [overnight], signals: [garage] })).toHaveLength(0);
    expect(
      evaluateRules({ now: NOW, localHhmm: '23:45', rules: [overnight], signals: [garage] }),
    ).toHaveLength(1);
  });
});

describe('dismissal', () => {
  const dismissKey = 'urn:oid:2.49.0.1.840.0.abc';

  it('acknowledges the warning, not one rule about it', () => {
    /*
     * The bug this exists for. The shipped rules are a ladder, so one warning
     * matches several — keyed by rule, acknowledging the loudest promoted the
     * next one down and the wall carried on as if nobody had pressed anything.
     * A household acknowledges a *thing*.
     */
    const ladder = [
      rule({ id: 'immediate', action: 'takeover', priority: 80, reassertAfterSec: 600 }),
      rule({ id: 'severe', action: 'takeover', priority: 60, reassertAfterSec: 1800 }),
      rule({ id: 'moderate', match: { minSeverity: 'Moderate' }, action: 'banner', priority: 40 }),
    ];
    expect(evaluateRules({ ...base, rules: ladder, signals: [alert()] })).toHaveLength(3);

    const acknowledged = { [dismissKey]: NOW - 1000 };
    expect(
      evaluateRules({ ...base, rules: ladder, signals: [alert()], dismissedAt: acknowledged }),
    ).toEqual([]);
  });

  it('never lets an acknowledgement silence a rule that forbids one', () => {
    // The ladder means an Extreme rule and a Moderate rule match the same
    // warning. Clearing the advisory must not clear the warning.
    const both = [
      rule({ id: 'extreme', match: { minSeverity: 'Extreme' }, action: 'takeover_and_wake', dismissible: false }),
      rule({ id: 'moderate', match: { minSeverity: 'Moderate' }, action: 'banner' }),
    ];
    const firing = evaluateRules({
      ...base,
      rules: both,
      signals: [alert()],
      dismissedAt: { [dismissKey]: NOW - 1000 },
    });
    expect(firing.map((entry) => entry.ruleId)).toEqual(['extreme']);
  });

  it('stays quiet once cleared, and comes back when told to', () => {
    const clearable = rule({ reassertAfterSec: 600 });
    const justCleared = { [dismissKey]: NOW - 60_000 };
    expect(
      evaluateRules({ ...base, rules: [clearable], signals: [alert()], dismissedAt: justCleared }),
    ).toHaveLength(0);

    // "Yes, I know" should not mean "never mention it again" while the storm
    // is still overhead.
    const longAgo = { [dismissKey]: NOW - 20 * 60_000 };
    expect(
      evaluateRules({ ...base, rules: [clearable], signals: [alert()], dismissedAt: longAgo }),
    ).toHaveLength(1);
  });

  it('stays dismissed for the signal when no re-assertion was set', () => {
    const once = rule();
    expect(
      evaluateRules({ ...base, rules: [once], signals: [alert()], dismissedAt: { [dismissKey]: NOW - 1 } }),
    ).toHaveLength(0);
  });

  it('does not silence a different warning', () => {
    // Keyed on the rule *and* the signal, so clearing one county's warning
    // leaves the next one alone.
    const other = alert({ key: 'urn:oid:2.49.0.1.840.0.xyz' });
    expect(
      evaluateRules({ ...base, rules: [rule()], signals: [other], dismissedAt: { [dismissKey]: NOW - 1 } }),
    ).toHaveLength(1);
  });
});

describe('resolving conflicts', () => {
  function fired(over: Partial<Interrupt>): Interrupt {
    return {
      ruleId: 'r', key: 'k', source: 'nws', action: 'banner', title: 'T',
      severity: 'Moderate', urgency: 'Expected', dismissible: true, wakeScreen: false,
      piercesNightMode: false, priority: 0, ...over,
    };
  }

  it('puts severity ahead of anybody priority', () => {
    /*
     * The one ordering that must not be configurable away. A Moderate banner
     * with a high priority must never outrank an Extreme takeover.
     */
    const { active } = resolveConflicts([
      fired({ key: 'a', title: 'Advisory', severity: 'Moderate', priority: 1000 }),
      fired({ key: 'b', title: 'Tornado', severity: 'Extreme', action: 'takeover_and_wake', priority: 0 }),
    ]);
    expect(active[0]?.title).toBe('Tornado');
  });

  it('shows one takeover and queues the rest', () => {
    // Two things covering the whole wall is one thing covering the whole wall
    // and one thing nobody sees.
    const { active, queued } = resolveConflicts([
      fired({ key: 'a', title: 'Flood', severity: 'Severe', action: 'takeover' }),
      fired({ key: 'b', title: 'Tornado', severity: 'Extreme', action: 'takeover' }),
      fired({ key: 'c', title: 'Advisory', severity: 'Moderate', action: 'banner' }),
    ]);
    expect(active.map((entry) => entry.title)).toEqual(['Tornado', 'Advisory']);
    // Queued, not dropped. It is still true.
    expect(queued.map((entry) => entry.title)).toEqual(['Flood']);
  });

  it('says one thing once, however many rules match it', () => {
    /*
     * The shipped rules are a ladder of `minSeverity` bars, so an Extreme
     * warning clears every one of them. Without collapsing per signal, one
     * tornado warning came out as a takeover with a banner underneath
     * repeating the same sentence — which is how a wall teaches somebody that
     * its banners are noise.
     */
    const { active, queued } = resolveConflicts([
      fired({ ruleId: 'extreme', key: 'same', title: 'Tornado', severity: 'Extreme', action: 'takeover_and_wake' }),
      fired({ ruleId: 'moderate', key: 'same', title: 'Tornado', severity: 'Extreme', action: 'banner' }),
    ]);
    expect(active).toHaveLength(1);
    expect(active[0]?.action).toBe('takeover_and_wake');
    // Queued rather than dropped: it is still a rule that matched.
    expect(queued).toHaveLength(1);
  });

  it('still shows two different things at once', () => {
    const { active } = resolveConflicts([
      fired({ key: 'storm', title: 'Storm', severity: 'Moderate', action: 'banner' }),
      fired({ key: 'door', title: 'Freezer door', severity: 'Unknown', action: 'banner' }),
    ]);
    expect(active).toHaveLength(2);
  });

  it('orders the same way every time', () => {
    // An order that shuffled between polls would make the wall flicker.
    const input = [
      fired({ key: 'a', title: 'Beta', severity: 'Moderate' }),
      fired({ key: 'b', title: 'Alpha', severity: 'Moderate' }),
    ];
    expect(resolveConflicts(input).active.map((e) => e.title)).toEqual(['Alpha', 'Beta']);
    expect(resolveConflicts([...input].reverse()).active.map((e) => e.title)).toEqual(['Alpha', 'Beta']);
  });

  it('carries wakeScreen only for the action that means it', () => {
    // Present on the payload from the start, so adding wake support to the
    // Android app later needs no server change. A web client ignores it.
    const wake = evaluateRules({ ...base, rules: [rule({ action: 'takeover_and_wake' })], signals: [alert()] });
    expect(wake[0]?.wakeScreen).toBe(true);
    const quiet = evaluateRules({ ...base, rules: [rule({ action: 'takeover' })], signals: [alert()] });
    expect(quiet[0]?.wakeScreen).toBe(false);
  });
});

describe('the shipped ladder', () => {
  const shipped = DEFAULT_ALERT_RULES.filter((entry) => entry.enabled);

  function loudestFor(signal: Signal): string {
    const { active } = evaluateInterrupts({ ...base, rules: shipped, signals: [signal] });
    return active[0]?.action ?? 'none';
  }

  it('reserves the loudest thing the wall can do for the rarest', () => {
    expect(loudestFor(alert({ severity: 'Extreme' }))).toBe('takeover_and_wake');
    expect(loudestFor(alert({ severity: 'Severe', urgency: 'Immediate' }))).toBe('takeover');
    expect(loudestFor(alert({ severity: 'Moderate', urgency: 'Expected' }))).toBe('banner');
    // Minor is shipped switched off. A frost advisory does not get to
    // interrupt a family's calendar.
    expect(loudestFor(alert({ severity: 'Minor', urgency: 'Expected' }))).toBe('none');
  });

  it('wakes a dark screen only for Extreme, or Severe happening now', () => {
    const wakes = (signal: Signal): boolean => {
      const { active } = evaluateInterrupts({ ...base, rules: shipped, signals: [signal] });
      return active.some((entry) => entry.piercesNightMode);
    };
    expect(wakes(alert({ severity: 'Extreme' }))).toBe(true);
    expect(wakes(alert({ severity: 'Severe', urgency: 'Immediate' }))).toBe(true);
    // A severe thunderstorm watch for tomorrow afternoon is not a reason to
    // light a bedroom.
    expect(wakes(alert({ severity: 'Severe', urgency: 'Future' }))).toBe(false);
    expect(wakes(alert({ severity: 'Moderate', urgency: 'Immediate' }))).toBe(false);
  });

  it('will not let an Extreme warning be cleared', () => {
    const { active } = evaluateInterrupts({ ...base, rules: shipped, signals: [alert()] });
    expect(active[0]?.dismissible).toBe(false);
  });
});

describe('three sources, one model', () => {
  /**
   * The claim this whole package makes.
   *
   * A weather alert, a door sensor and an appointment have nothing in common:
   * one has severity and no state, one has state and no severity, and one has
   * neither and matches on a time that has not happened yet. If the model had
   * been quietly shaped around the first, adding the third would have needed a
   * third code path — so this asserts that it did not.
   */
  const rules: InterruptRule[] = [
    rule({ id: 'weather', source: 'nws', match: { minSeverity: 'Severe' }, action: 'takeover', priority: 80 }),
    rule({
      id: 'door',
      source: 'homeassistant',
      name: 'Freezer door open',
      match: { entityId: 'binary_sensor.freezer', condition: { kind: 'equals', value: 'on', between: null } },
      minDwellSec: 300,
      action: 'banner',
      priority: 40,
    }),
    rule({
      id: 'soon',
      source: 'calendar',
      name: 'Starting in ten minutes',
      match: { startsWithinSec: 600 },
      action: 'banner',
      priority: 30,
    }),
  ];

  const signals: Signal[] = [
    alert({ severity: 'Severe', urgency: 'Immediate' }),
    {
      source: 'homeassistant',
      key: 'binary_sensor.freezer',
      title: 'Freezer door',
      state: 'on',
      since: NOW - 9 * 60_000,
    },
    {
      source: 'calendar',
      key: 'evt-1',
      title: 'Dentist',
      startsAt: NOW + 5 * 60_000,
      since: NOW - 60_000,
      expiresAt: NOW + 5 * 60_000,
    },
  ];

  it('fires all three through one evaluator', () => {
    const { active } = evaluateInterrupts({ ...base, rules, signals });
    expect(active.map((entry) => entry.title)).toEqual(['Tornado Warning', 'Freezer door', 'Dentist']);
    expect(active.map((entry) => entry.source)).toEqual(['nws', 'homeassistant', 'calendar']);
  });

  it('does not fire the calendar rule for something further out', () => {
    const later = signals.map((signal) =>
      signal.source === 'calendar'
        ? { ...signal, startsAt: NOW + 45 * 60_000, expiresAt: NOW + 45 * 60_000 }
        : signal,
    );
    const { active } = evaluateInterrupts({ ...base, rules, signals: later });
    expect(active.map((entry) => entry.title)).not.toContain('Dentist');
  });

  it('does not fire the calendar rule for something already begun', () => {
    // "Starting soon" stops being true the moment it starts. A reminder that
    // stays up through the appointment is one nobody reads the second time.
    const started = signals.map((signal) =>
      signal.source === 'calendar' ? { ...signal, startsAt: NOW - 60_000 } : signal,
    );
    const { active } = evaluateInterrupts({ ...base, rules, signals: started });
    expect(active.map((entry) => entry.title)).not.toContain('Dentist');
  });

  it('lets the weather rule outrank both without either being dropped', () => {
    const { active } = evaluateInterrupts({ ...base, rules, signals });
    expect(active[0]?.action).toBe('takeover');
    // The banners still travel: a takeover replaces the calendar, not the
    // knowledge that the freezer is open.
    expect(active).toHaveLength(3);
  });
});
