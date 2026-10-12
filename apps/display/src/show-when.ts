/**
 * The editor's half of "Show this widget" (plan items M6.4, M6.5, M6.7):
 * reading a stored `showWhen`, and writing one the server will take.
 *
 * Pure, for the reason `inspector.ts` is: there is no DOM in this package's
 * tests, so a rule decided inside a click handler is a rule nothing can
 * check. The *resolution* — whether a box is shown now — is the server's
 * (`api/show-when.ts`), and the wall never sees the entity; this module only
 * ever runs in the admin.
 */

export type ShowMode = 'always' | 'while' | 'except' | 'after';

export interface ShowRule {
  readonly entity: string;
  readonly state?: string;
  readonly not?: true;
  readonly pulse?: number;
}

export interface ConditionChoice {
  readonly id: string;
  readonly name: string;
  readonly states: readonly string[];
  readonly moment: boolean;
}

export interface ConditionChoices {
  readonly connected: boolean;
  readonly entities: readonly ConditionChoice[];
}

export const NO_CONDITIONS: ConditionChoices = { connected: false, entities: [] };

/** The server's `MOMENT_DOMAINS`: a state that is the instant something happened. */
const MOMENT_DOMAINS = ['event', 'button', 'input_button'];
const ENTITY = /^[a-z_]{1,40}\.[a-z0-9_]{1,200}$/;

export const isMomentId = (entity: string): boolean => MOMENT_DOMAINS.includes(entity.slice(0, entity.indexOf('.')));

/** How long "After…" shows a box, in the words the picker says them. */
export const PULSE_CHOICES: readonly (readonly [number, string])[] = [
  [10, '10 seconds'],
  [30, '30 seconds'],
  [60, '1 minute'],
  [120, '2 minutes'],
  [300, '5 minutes'],
  [900, '15 minutes'],
  [3600, '1 hour'],
];
export const DEFAULT_PULSE = 60;

/** The stored rule, read as the server reads it — anything it would not take is no rule. */
export function showRuleOf(config: Record<string, unknown> | undefined): ShowRule | undefined {
  const raw = config?.['showWhen'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const entity = r['entity'];
  if (typeof entity !== 'string' || !ENTITY.test(entity)) return undefined;
  const state = typeof r['state'] === 'string' && r['state'] !== '' ? r['state'] : undefined;
  const pulse = typeof r['pulse'] === 'number' && Number.isInteger(r['pulse']) ? r['pulse'] : undefined;
  return {
    entity,
    ...(state === undefined ? {} : { state }),
    ...(r['not'] === true ? { not: true as const } : {}),
    ...(pulse === undefined ? {} : { pulse }),
  };
}

export function modeOfRule(rule: ShowRule): ShowMode {
  if (rule.pulse !== undefined || isMomentId(rule.entity)) return 'after';
  return rule.not === true ? 'except' : 'while';
}

/**
 * The state a newly chosen entity starts on: `on` where the entity has one —
 * "show while the porch sensor is on" is what choosing a sensor means far more
 * often than "while it is off", whatever it says this minute — else what it
 * says now.
 */
export function defaultState(choice: ConditionChoice | undefined): string | undefined {
  if (choice === undefined || choice.moment) return undefined;
  for (const preferred of ['on', 'home', 'playing', 'open']) if (choice.states.includes(preferred)) return preferred;
  return choice.states[0];
}

/**
 * The rule for a mode, an entity and what has been chosen so far — or
 * nothing, while it is not yet one the server takes (an entity with no state,
 * which the field below asks for). A mode moving to "After…" brings the
 * default pulse; moving away drops it, and "Except while…" carries none.
 */
export function ruleFor(
  mode: ShowMode,
  entity: string,
  state: string | undefined,
  pulse: number | undefined,
  choice: ConditionChoice | undefined,
): ShowRule | undefined {
  if (mode === 'always') return undefined;
  const moment = choice?.moment ?? isMomentId(entity);
  if (moment) return mode === 'after' ? { entity, pulse: pulse ?? DEFAULT_PULSE } : undefined;
  const chosen = state ?? defaultState(choice);
  if (chosen === undefined) return undefined;
  if (mode === 'after') return { entity, state: chosen, pulse: pulse ?? DEFAULT_PULSE };
  if (mode === 'except') return { entity, state: chosen, not: true };
  return { entity, state: chosen };
}

/** What the household reads under the fields: how soon, and what happens when the house is quiet. */
export function showWhenHint(mode: ShowMode, moment: boolean): string {
  const soon = 'The wall follows Home Assistant within about a minute.';
  if (mode === 'except') return `${soon} If Home Assistant cannot be reached, the widget is shown.`;
  if (mode === 'after') {
    const what = moment
      ? 'Shows from the moment it happens.'
      : 'Shows from the moment it changes to this, and goes when the time is up even if it has not changed back.';
    return `${what} ${soon} An e-paper panel never shows it, because its picture stays up too long.`;
  }
  return `${soon} If Home Assistant cannot be reached, the widget is hidden.`;
}

/** The server's answer, read defensively: a shape this bundle does not know is no entities. */
export function parseConditionChoices(raw: unknown): ConditionChoices {
  if (typeof raw !== 'object' || raw === null) return NO_CONDITIONS;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r['entities']) ? (r['entities'] as unknown[]) : [];
  const entities: ConditionChoice[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e['id'] !== 'string' || !ENTITY.test(e['id'])) continue;
    entities.push({
      id: e['id'],
      name: typeof e['name'] === 'string' ? e['name'] : e['id'],
      states: Array.isArray(e['states']) ? (e['states'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      moment: e['moment'] === true,
    });
  }
  return { connected: r['connected'] === true, entities };
}
