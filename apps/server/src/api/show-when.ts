/**
 * A widget shown only while something in the house says so (plan items M6.4,
 * M6.5 and M6.7).
 *
 * `showWhen` on a widget's config names one Home Assistant entity and one of
 * three rules:
 *
 * - **While it is a state** (`state`): the doorbell camera while the porch
 *   sensor is `on`, the washer card while the washer is `running`.
 * - **Except while it is a state** (`state` and `not`): the calendar's week
 *   view, except while somebody's `media_player` is `playing`.
 * - **For a while after it happens** (`pulse`, seconds): the box shows from
 *   the moment the entity entered the state, or from the instant an `event`,
 *   `button` or `input_button` entity reports (its state *is* that instant),
 *   and goes again when the time is up whether or not the state has moved.
 *   That is the auto-hide timer a momentary trigger needs, and it is what lets
 *   Home Assistant "press a button" that shows a group for a minute.
 *
 * **Hidden is a substitution, never a moved rectangle.** A hidden box is a box
 * the omission leaves out, so it draws its `whenEmpty` fallback when it has
 * one and nothing otherwise, in the rectangle the household dragged — the same
 * mechanism, and the same refresh contract, as a Weather box with no location.
 *
 * Pure. The caller reads the states (`ha_condition_states`) and the clock; this
 * answers whether the box is shown, and until when. The wall is told the
 * answer and never the entity (rule 12).
 */

/** Entities whose state is the instant something happened, not a condition. */
export const MOMENT_DOMAINS: readonly string[] = ['event', 'button', 'input_button'];

/** What a widget may be shown by: an entity id, in Home Assistant's own shape. */
export const CONDITION_ENTITY_PATTERN = /^[a-z_]{1,40}\.[a-z0-9_]{1,200}$/;

/** The shortest and longest a pulse may be, in seconds. */
export const PULSE_MIN_S = 5;
export const PULSE_MAX_S = 3600;

/**
 * A reading older than this is not the house's any more: Home Assistant has
 * not answered for five minutes, and the box is treated as not in the state.
 * Ten polls' worth, so a slow answer or two changes nothing on the glass.
 */
export const CONDITION_FRESH_MS = 5 * 60_000;

export interface ShowWhen {
  readonly entity: string;
  readonly state?: string;
  readonly not?: true;
  readonly pulse?: number;
}

export interface ConditionReading {
  readonly state: string;
  readonly changedAt: number;
  readonly readAt: number;
  /** Home Assistant's name for it, for a doorbell rule to say what rang (M6.3). */
  readonly name?: string;
}

/**
 * Everything the omission needs to decide a `showWhen`. `panel` is an e-paper
 * frame, which shows one picture for up to an hour: a pulse there could only
 * ever be a box that stays up long after it should have gone, so a panel never
 * draws one.
 */
export interface Conditions {
  readonly readings: Readonly<Record<string, ConditionReading>>;
  readonly now: number;
  readonly panel?: boolean;
}

export type Shown = { readonly shown: false } | { readonly shown: true; readonly until?: number };

export const isMomentEntity = (entity: string): boolean =>
  MOMENT_DOMAINS.includes(entity.slice(0, entity.indexOf('.')));

/**
 * The rule a stored config carries, or nothing. Read defensively although the
 * editor wrote it through `showWhenBody`: a row reaches the database by more
 * than one door, and a shape this build does not understand is no rule — the
 * box shows, as it did before the key existed — rather than a box hidden for
 * a reason nobody can see.
 */
export function showWhenOf(config: unknown): ShowWhen | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const raw = (config as Record<string, unknown>)['showWhen'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const entity = r['entity'];
  if (typeof entity !== 'string' || !CONDITION_ENTITY_PATTERN.test(entity)) return undefined;
  const state = typeof r['state'] === 'string' && r['state'] !== '' ? r['state'] : undefined;
  const pulse =
    typeof r['pulse'] === 'number' && Number.isInteger(r['pulse']) && r['pulse'] >= PULSE_MIN_S && r['pulse'] <= PULSE_MAX_S
      ? r['pulse']
      : undefined;
  if (isMomentEntity(entity)) return pulse === undefined ? undefined : { entity, pulse };
  if (state === undefined) return undefined;
  if (r['not'] === true) return pulse === undefined ? { entity, state, not: true } : undefined;
  return pulse === undefined ? { entity, state } : { entity, state, pulse };
}

/** Whether the box is shown now, and until when if it is a pulse. */
export function shownNow(rule: ShowWhen, conditions: Conditions): Shown {
  const reading = conditions.readings[rule.entity];
  const now = conditions.now;
  if (rule.pulse !== undefined) {
    if (conditions.panel === true) return { shown: false };
    let from: number | undefined;
    if (isMomentEntity(rule.entity)) {
      // The state is the instant; a stale poll does not unmake a press.
      const at = reading === undefined ? NaN : Date.parse(reading.state);
      from = Number.isFinite(at) ? at : undefined;
    } else if (reading !== undefined && fresh(reading, now) && reading.state === rule.state) {
      from = reading.changedAt;
    }
    if (from === undefined) return { shown: false };
    const until = from + rule.pulse * 1000;
    return now < until ? { shown: true, until } : { shown: false };
  }
  const match = reading !== undefined && fresh(reading, now) && reading.state === rule.state;
  return { shown: rule.not === true ? !match : match };
}

const fresh = (reading: ConditionReading, now: number): boolean => now - reading.readAt <= CONDITION_FRESH_MS;

/**
 * The entity id and state a Home Assistant `/api/states` row reports, with the
 * instant it last changed. A row of the wrong shape is no reading.
 */
export function conditionReadingFrom(
  row: { readonly state?: unknown; readonly last_changed?: unknown },
  readAt: number,
): ConditionReading | undefined {
  if (typeof row.state !== 'string' || row.state.length > 255) return undefined;
  const changed = typeof row.last_changed === 'string' ? Date.parse(row.last_changed) : NaN;
  return { state: row.state, changedAt: Number.isFinite(changed) ? changed : readAt, readAt };
}
