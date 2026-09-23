/**
 * Which boxes the wall will leave out, and what the editor says about them.
 *
 * The manifest omits a widget the household has nothing set up for — no
 * location means no forecast. The editor cannot: a box you cannot see is a box
 * you cannot move, and the preview here is the one place a household can find
 * out *why* something is missing from their wall. So the box stays and carries
 * the reason, while the preview beneath it draws what the wall will.
 *
 * That is two answers about one widget, and keeping them consistent is the
 * whole of this module. It was a pair of functions inside `boot()`, where the
 * display's test suite — which has no DOM — could not reach either, and where
 * the sentences a household reads were composed at three separate call sites.
 *
 * **Keyed by box, not by type**, since RFC 012 §6.2. A to-do widget is left
 * out or kept by the list its own settings name, so two boxes of one type can
 * get two answers — and the flag has to follow a household picking a list in
 * the inspector, without a reload. So the server's answer is a *seed*, and
 * `notDrawnFor` re-derives the same answer from the facts the server decided
 * from (`OmissionFacts`, the same `widgetIsSetUp` inputs) on every change. One
 * rule, stated here once for the editor and in `api/manifest.ts` once for the
 * wall; a second opinion here is how the wall and the page that describes it
 * come to disagree.
 */

/** All this module needs of a widget: which one it is, what kind, its settings. */
export interface OmissionTarget {
  readonly id: string;
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
}

/** Widget id → why the wall leaves it out. Empty when everything is set up. */
export type NotDrawn = ReadonlyMap<string, string>;

/**
 * What the server decided from, so the editor can decide the same way.
 *
 * `drawn` is `widgetIsSetUp` asked once per type with no settings — the whole
 * answer for every type but `todo`. `todoLists` is the config-dependent half:
 * the Home Assistant lists the household watches, by the id a widget stores.
 * `why` is the sentence per type, written on the server with the rest of the
 * admin's copy; a type with no sentence gets the generic one below.
 */
export interface OmissionFacts {
  readonly drawn: Readonly<Record<string, boolean>>;
  readonly todoLists: readonly string[];
  readonly why: Readonly<Record<string, string>>;
}

const GENERIC_WHY = 'Nothing is set up for this yet, so it is left out.';

/**
 * The list a to-do box names, or nothing for a typed checklist.
 *
 * Absent and empty are the same answer — the typed items — which is how the
 * wall (`todoListOf` in the manifest) and the panel read the same key.
 */
export function todoListOf(config: Record<string, unknown> | undefined): string | undefined {
  const list = config?.['list'];
  return typeof list === 'string' && list !== '' ? list : undefined;
}

/**
 * Would the wall leave this box out, given the facts?
 *
 * The one pure predicate, and the transcription of `widgetIsSetUp`: every type
 * answers from `drawn`, except a to-do box, which is never left out while it
 * draws typed items and is left out when the list it names is no longer one
 * the household watches.
 */
export function widgetOmitted(widget: OmissionTarget, facts: OmissionFacts): boolean {
  if (widget.type === 'todo') {
    const list = todoListOf(widget.config);
    return list !== undefined && !facts.todoLists.includes(list);
  }
  return facts.drawn[widget.type] === false;
}

/**
 * What a box draws instead when it has nothing to say (RFC 014 §5.3).
 *
 * `config.whenEmpty` names another widget, and the server substitutes it in
 * `keepWidgetsWithSomethingToSay` — the one place the wall and the panel both
 * go through. This is that reading transcribed, for the reason `widgetOmitted`
 * is: the preview here has to draw what the wall will, as the household edits,
 * without a round trip. Read defensively, since the canvas came out of a JSON
 * blob the editor did not write this session.
 */
export interface Fallback {
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
}

export function fallbackOf(config: Record<string, unknown> | undefined): Fallback | undefined {
  const raw = config?.['whenEmpty'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as Record<string, unknown>)['type'];
  if (typeof type !== 'string' || type === '') return undefined;
  const own = (raw as Record<string, unknown>)['config'];
  return typeof own === 'object' && own !== null
    ? { type, config: own as Record<string, unknown> }
    : { type };
}

/**
 * The types a household may choose to stand in for an empty box, in the order
 * the picker offers them.
 *
 * Notes first because it is the answer RFC 014 §5.3 was written around — a
 * Weather box with no location showing the household's own words. A picture
 * and a module's panel are left out: each needs a picker of its own (an upload,
 * a registered module) that is more than the "minimal content controls" a
 * fallback carries, and a fallback that could only be finished on another
 * widget would be half a control.
 */
export const FALLBACK_TYPES: readonly string[] = [
  'notes', 'countdown', 'clock', 'calendar', 'todo', 'weather', 'homeassistant', 'shift', 'chores',
];

/**
 * What this box may fall back to: never itself, and never a type the wall
 * would leave out too — a Shift badge on a household with no rota is not an
 * answer to an empty Weather box, it is a second empty box.
 */
export function fallbackChoices(type: string, facts: OmissionFacts | undefined): readonly string[] {
  return FALLBACK_TYPES.filter(
    (one) => one !== type && (facts === undefined || !widgetOmitted({ id: '', type: one }, facts)),
  );
}

/**
 * The fallback this flagged box would actually draw, or nothing — the second
 * half of the server's rule, that a fallback with nothing to say is dropped
 * exactly as the widget would have been. Without the facts (an older server's
 * page) the fallback is believed, which is the side that shows the household
 * what they chose.
 */
export function drawnFallback(widget: OmissionTarget, facts: OmissionFacts | undefined): Fallback | undefined {
  const fallback = fallbackOf(widget.config);
  if (fallback === undefined) return undefined;
  if (facts !== undefined && widgetOmitted({ id: widget.id, ...fallback }, facts)) return undefined;
  return fallback;
}

/** A box as the preview draws it: itself, or its fallback wearing its rectangle. */
export type Drawn<T extends OmissionTarget> = T & { readonly substituted?: true };

/** Every box the wall would leave out, with its reason — the seed, re-derived. */
export function notDrawnFor(widgets: readonly OmissionTarget[], facts: OmissionFacts): NotDrawn {
  const flagged = new Map<string, string>();
  for (const widget of widgets) {
    if (widgetOmitted(widget, facts)) flagged.set(widget.id, facts.why[widget.type] ?? GENERIC_WHY);
  }
  return flagged;
}

/**
 * What the *preview* draws — the whole canvas, less the flagged boxes, with
 * each flagged box that names a fallback drawing that instead.
 *
 * A canvas that filtered away to nothing keeps everything, which is rule nine:
 * a preview that emptied itself would draw "Nothing on this wall yet" — a lie
 * about a canvas somebody is looking at while they arrange it, and two
 * contradictory sentences on one screen ("Not on the wall" on a box, over a
 * preview claiming the wall is empty).
 *
 * **Substitute, then guard** — `keepWidgetsWithSomethingToSay`'s order, for its
 * reason: a canvas of two empty boxes each naming a note draws two notes, not
 * two placeholders the guard put back.
 *
 * Used by every preview and by no save: the overlay boxes are always the whole
 * canvas, because one that vanished under the pointer would be unusable.
 */
export function drawnWidgets<T extends OmissionTarget>(
  widgets: readonly T[],
  notDrawn: NotDrawn,
  facts?: OmissionFacts,
): readonly Drawn<T>[] {
  if (notDrawn.size === 0) return widgets;
  const kept: Drawn<T>[] = [];
  for (const widget of widgets) {
    if (!notDrawn.has(widget.id)) {
      kept.push(widget);
      continue;
    }
    const fallback = drawnFallback(widget, facts);
    if (fallback !== undefined) {
      kept.push({ ...widget, type: fallback.type, config: fallback.config, substituted: true } as Drawn<T>);
    }
  }
  return kept.length === 0 ? widgets : kept;
}

/**
 * What the editor says about one box: why the wall leaves it out, and what it
 * shows in its place when it names a fallback — or nothing, for a box drawn as
 * itself.
 */
export interface Omission {
  readonly why: string;
  /** The fallback the wall draws in this box instead, when there is one. */
  readonly instead?: Fallback | undefined;
}

/**
 * Why *this* box is not drawn as itself, and what stands in for it.
 *
 * The flag is not enough. Omission is per canvas rather than per widget,
 * because of the rule above: on a canvas of only unconfigured widgets every one
 * of them *is* drawn, and flagging by the map alone would label a box "not on
 * the wall" while the wall and the preview beside it both drew it — the same
 * contradiction the preview filter fixes in the other direction. A box drawing
 * its fallback is still flagged: the wall does not draw *it*, and saying so is
 * what lets a household find out why their forecast is a note.
 *
 * The `has` test comes first because it short-circuits: the scan below only
 * runs for the handful of boxes that could be flagged at all.
 */
export function omissionOf<T extends OmissionTarget>(
  widget: T,
  widgets: readonly T[],
  notDrawn: NotDrawn,
  facts?: OmissionFacts,
): Omission | undefined {
  const why = notDrawn.get(widget.id);
  if (why === undefined) return undefined;
  const drawn = drawnWidgets(widgets, notDrawn, facts).find((one) => one.id === widget.id);
  if (drawn === undefined) return { why };
  if (drawn.substituted !== true) return undefined;
  return { why, instead: { type: drawn.type, config: drawn.config } };
}

/** The reason alone — `omissionOf` for the callers that only need the sentence. */
export function omittedReason<T extends OmissionTarget>(
  widget: T,
  widgets: readonly T[],
  notDrawn: NotDrawn,
  facts?: OmissionFacts,
): string | undefined {
  return omissionOf(widget, widgets, notDrawn, facts)?.why;
}

/**
 * The noun for what is being arranged.
 *
 * The same editor draws a wall's canvas and an e-paper panel's, and the two are
 * different objects on two different pages. One noun for both would be wrong on
 * one of them every time, and "not on the wall" beside a 1-bit frame is the
 * wrong object on a page that says "panel" everywhere else.
 */
export type Surface = 'wall' | 'panel';

/**
 * The flag drawn on the box itself. Short: the reason is in the inspector.
 *
 * `instead` is the fallback's own name (RFC 014 §5.3): a box standing in for
 * itself says what is standing in, because "Not on the wall" over a preview
 * that plainly draws a note in that box reads as the two disagreeing.
 */
export function omissionFlag(surface: Surface, instead?: string): string {
  return instead === undefined ? `Not on the ${surface}` : `Shows ${instead} instead`;
}

/** The inspector's note, above everything else in the panel. */
export function omissionNote(why: string, surface: Surface, instead?: string): string {
  return instead === undefined
    ? `Not on the ${surface} yet. ${why}`
    : `Not on the ${surface} yet, so this box shows ${instead} instead. ${why}`;
}

/**
 * A box's accessible name, flagged or not.
 *
 * One function for both, because the flag used to be composed where the box is
 * *built* and nowhere else — so `refreshLabels`, which re-reads every name in
 * place when a widget's view changes, skipped the flagged boxes rather than
 * compose the longer sentence a second time. A flagged Calendar switched from
 * a month to an agenda then showed the new name on its chip and went on
 * announcing the old one, which is the only half of it nobody can see.
 *
 * And the fallback (RFC 014 §5.3) is in the same sentence for the same reason:
 * choosing a different widget to stand in changes what the box *is* on the
 * wall, and the one place that must be re-read in place is the one place
 * nobody can see go stale.
 */
export function boxAriaLabel(
  name: string,
  why: string | undefined,
  surface: Surface,
  instead?: string,
  kind: 'widget' | 'group' = 'widget',
): string {
  // A group's name already says what it is — "Group of 3: clock, weather,
  // shift" (RFC 014 §5.1) — so it carries no noun after it; a widget's is
  // its type, and "widget" is what tells "Clock" from the clock it draws.
  const subject = kind === 'group' ? name : `${name} widget`;
  if (why === undefined) return subject;
  return instead === undefined
    ? `${subject} — not on the ${surface}. ${why}`
    : `${subject} — not on the ${surface}, shows ${instead} instead. ${why}`;
}
