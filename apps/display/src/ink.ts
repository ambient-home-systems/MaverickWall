/**
 * The two lanes, as pure functions (RFC 005, direction B).
 *
 * A widget carries the household's wall settings and, optionally, an `ink`
 * object saying what it does differently on a black-and-white panel that
 * follows the same canvas. The editor writes into one or the other depending on
 * which lane is open, and everything about that is decided here rather than
 * inside a click handler — the same reason `widget-options.ts` exists: there is
 * no DOM in this package's test suite, so a rule resolved inside a
 * `createElement` call is a rule nothing can check.
 *
 * The property worth pinning, and the reason this is a module at all: **the
 * lanes are one-way.** Editing on ink must never change a single wall value.
 * A household who tunes a panel and then finds their kitchen wall has quietly
 * changed has lost trust in both screens, and the mistake is a one-character
 * one — writing into `config` instead of `config.ink`.
 *
 * The merge here mirrors `withInk` in `apps/server/src/epaper/honours.ts`, which
 * is what the panel actually draws with. This copy only decides what the
 * editor's controls *show*, and the editor's authoritative preview is the frame
 * the server renders — so a drift between the two would be visible in that
 * frame rather than silent. That is why this is not held to the ladder's
 * two-file parity test: nothing here is a second renderer.
 */

export type Lane = 'wall' | 'ink';

type Config = Readonly<Record<string, unknown>>;

/** A widget's stored ink overrides — an object, always, however odd the input. */
export function inkOf(config: Config | undefined): Record<string, unknown> {
  const raw = (config ?? {})['ink'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

/**
 * What a panel following this canvas will draw: the wall's settings with the
 * ink lane laid over the top, and `ink` itself dropped.
 */
export function mergeInk(config: Config | undefined): Record<string, unknown> {
  const { ink: _drop, ...wall } = { ...(config ?? {}) };
  return { ...wall, ...inkOf(config) };
}

/**
 * Set one option in one lane, and answer with the whole config.
 *
 * Empty means absent, exactly as the wall lane has always treated it — an
 * unticked box, a cleared number, an empty selection. Clearing the last
 * override removes `ink` altogether, so a widget that says nothing different on
 * a panel carries nothing at all rather than an empty object nobody can see.
 *
 * Answers with `undefined` when nothing is left, which is what the editor
 * stores as "this widget has no options" — a config of `{}` would round-trip
 * through the schema and back as noise on every save.
 */
export function setLaneValue(
  config: Config | undefined,
  lane: Lane,
  key: string,
  value: unknown,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (lane === 'ink') {
    const over = inkOf(config);
    if (empty) delete over[key];
    else over[key] = value;
    if (Object.keys(over).length > 0) next['ink'] = over;
    else delete next['ink'];
  } else if (empty) delete next[key];
  else next[key] = value;

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Drop keys from the open lane — what the ladder does when it replaces the
 * switches it supersedes, in whichever lane wrote it.
 */
export function clearLaneKeys(
  config: Config | undefined,
  lane: Lane,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  if (lane === 'ink') {
    const over = inkOf(config);
    for (const key of keys) delete over[key];
    if (Object.keys(over).length > 0) next['ink'] = over;
    else delete next['ink'];
  } else {
    for (const key of keys) delete next[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
