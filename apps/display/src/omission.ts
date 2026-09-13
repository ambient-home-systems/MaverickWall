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

/** Every box the wall would leave out, with its reason — the seed, re-derived. */
export function notDrawnFor(widgets: readonly OmissionTarget[], facts: OmissionFacts): NotDrawn {
  const flagged = new Map<string, string>();
  for (const widget of widgets) {
    if (widgetOmitted(widget, facts)) flagged.set(widget.id, facts.why[widget.type] ?? GENERIC_WHY);
  }
  return flagged;
}

/**
 * What the *preview* draws — the whole canvas, less the flagged boxes.
 *
 * A canvas that filtered away to nothing keeps everything, which is rule nine:
 * a preview that emptied itself would draw "Nothing on this wall yet" — a lie
 * about a canvas somebody is looking at while they arrange it, and two
 * contradictory sentences on one screen ("Not on the wall" on a box, over a
 * preview claiming the wall is empty).
 *
 * Used by every preview and by no save: the overlay boxes are always the whole
 * canvas, because one that vanished under the pointer would be unusable.
 */
export function drawnWidgets<T extends OmissionTarget>(
  widgets: readonly T[],
  notDrawn: NotDrawn,
): readonly T[] {
  if (notDrawn.size === 0) return widgets;
  const kept = widgets.filter((widget) => !notDrawn.has(widget.id));
  return kept.length === 0 ? widgets : kept;
}

/**
 * Why *this* box is not drawn, or nothing.
 *
 * The flag is not enough. Omission is per canvas rather than per widget,
 * because of the rule above: on a canvas of only unconfigured widgets every one
 * of them *is* drawn, and flagging by the map alone would label a box "not on
 * the wall" while the wall and the preview beside it both drew it — the same
 * contradiction the preview filter fixes in the other direction.
 *
 * The `has` test comes first because it short-circuits: the scan below only
 * runs for the handful of boxes that could be flagged at all.
 */
export function omittedReason<T extends OmissionTarget>(
  widget: T,
  widgets: readonly T[],
  notDrawn: NotDrawn,
): string | undefined {
  if (!notDrawn.has(widget.id)) return undefined;
  if (drawnWidgets(widgets, notDrawn).some((one) => one.id === widget.id)) return undefined;
  return notDrawn.get(widget.id);
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

/** The flag drawn on the box itself. Short: the reason is in the inspector. */
export function omissionFlag(surface: Surface): string {
  return `Not on the ${surface}`;
}

/** The inspector's note, above everything else in the panel. */
export function omissionNote(why: string, surface: Surface): string {
  return `Not on the ${surface} yet. ${why}`;
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
 */
export function boxAriaLabel(name: string, why: string | undefined, surface: Surface): string {
  return why === undefined
    ? `${name} widget`
    : `${name} widget — not on the ${surface}. ${why}`;
}
