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
 * `notDrawn` comes from the server, derived from the same `widgetIsSetUp` the
 * manifest uses, because a second opinion here is how the wall and the screen
 * that describes it come to disagree.
 */

/** All this module needs of a widget: which one it is, and what kind. */
export interface OmissionTarget {
  readonly id: string;
  readonly type: string;
}

/** Widget type → why the wall leaves it out. Empty when everything is set up. */
export type NotDrawn = ReadonlyMap<string, string>;

/**
 * What the *preview* draws — the whole canvas, less the flagged types.
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
  const kept = widgets.filter((widget) => !notDrawn.has(widget.type));
  return kept.length === 0 ? widgets : kept;
}

/**
 * Why *this* box is not drawn, or nothing.
 *
 * The type is not enough. Omission is per canvas rather than per widget,
 * because of the rule above: on a canvas of only unconfigured widgets every one
 * of them *is* drawn, and flagging by type alone would label a box "not on the
 * wall" while the wall and the preview beside it both drew it — the same
 * contradiction the preview filter fixes in the other direction.
 *
 * The `has` test comes first because it short-circuits: the scan below only
 * runs for the handful of types that could be flagged at all.
 */
export function omittedReason<T extends OmissionTarget>(
  widget: T,
  widgets: readonly T[],
  notDrawn: NotDrawn,
): string | undefined {
  if (!notDrawn.has(widget.type)) return undefined;
  if (drawnWidgets(widgets, notDrawn).some((one) => one.id === widget.id)) return undefined;
  return notDrawn.get(widget.type);
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
