/**
 * What the inspector should show, as a decision rather than as a render.
 *
 * `renderConfigPanel` empties a panel and rebuilds it, and along the way it
 * answers seven questions no test could reach: whether there is anything to
 * show at all, what the widget is called, whether the lane switch appears,
 * which lane is actually in force, whether the ink lane is carrying overrides,
 * whether this box is one the wall leaves out (and the sentence that says so),
 * and which of the two tabs the body comes from.
 *
 * Two of those have a history. **The lane is forced** when no panel follows
 * this canvas — a widget rendered on the ink lane with no panel to override
 * would write overrides nothing reads. And **the note belongs to the wall lane
 * only**: the ink lane is about what a panel says differently, and "not on the
 * wall yet" over a panel's overrides is an answer to a question nobody asked
 * there.
 *
 * Returning a description rather than drawing means the questions can be asked
 * without a browser — this package's test suite has no DOM — and, more to the
 * point, asked all at once, where "the ink lane is showing while the lane bar
 * is hidden" is a contradiction a reader can see.
 */

import { inkOf } from './ink.js';
import { omittedReason, omissionNote, type NotDrawn, type Surface } from './omission.js';
import { tierNamed, type TierName } from './tiers.js';
import { labelFor } from './widget-labels.js';
import { calendarView } from './widget-views.js';

export type InspectorTab = 'content' | 'style';
export type InspectorLane = 'wall' | 'ink';

/** All the inspector needs of a widget. */
export interface InspectableWidget {
  readonly id: string;
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
}

export interface InspectorInput {
  readonly widgets: readonly InspectableWidget[];
  /** The selected widget's id, or nothing. */
  readonly selected: string | undefined;
  /** Which lane the person last chose. Ignored when no panel follows. */
  readonly lane: InspectorLane;
  /** Whether a panel follows this canvas, so an override would be read. */
  readonly inkAvailable: boolean;
  /** Which tab the person last chose. The wall lane only has tabs. */
  readonly tab: InspectorTab;
  readonly notDrawn: NotDrawn;
  readonly surface: Surface;
  /**
   * The density tier the *preview* resolved for the selected widget, read back
   * out of what `renderFreeform` actually drew.
   *
   * Read back rather than predicted, exactly as the ladder's strike-through
   * counts the rows that survived rather than working out which ones should
   * have: two opinions about what fits is the whole class of bug this project
   * keeps finding, and a household reading "M2" beside a box drawing one name
   * would be that bug with a label on it. Absent while the preview has not
   * loaded, on a widget that has no tier, and in this package's own tests —
   * where the honest answer is that nothing has been drawn to read.
   */
  readonly drawnTier?: TierName | undefined;
}

/**
 * Nothing selected — or a selection whose widget has gone, which is the same
 * thing. `restoreCanvas` already drops a selection an undo removed; this is the
 * second reading of that rule, so a stale id closes the panel rather than
 * describing a box that is not there.
 */
export interface EmptyInspector {
  readonly kind: 'empty';
}

export interface WidgetInspector {
  readonly kind: 'widget';
  readonly widgetId: string;
  readonly type: string;
  /** The heading: which widget this is, said outright. */
  readonly title: string;
  /** The destructive action, named after what it destroys. */
  readonly removeLabel: string;
  /** Whether the wall/ink switch is offered at all. */
  readonly laneBarVisible: boolean;
  /** The lane actually in force, which is `wall` whenever no panel follows. */
  readonly lane: InspectorLane;
  /** Whether this widget already says something different on a panel. */
  readonly hasInkOverrides: boolean;
  /** Why the wall leaves this box out, said in full. Wall lane only. */
  readonly note?: string | undefined;
  /**
   * What this box has room to say, in the household's words. Wall lane only,
   * and absent unless the preview drew a tier to read.
   */
  readonly density?: string | undefined;
  /**
   * Which tab supplies the body — and its absence is the ink lane, which has no
   * Content/Style split: a panel honours a handful of keys and they are one
   * short list, so two tabs over them would be two mostly-empty tabs.
   */
  readonly tab?: InspectorTab | undefined;
}

export type InspectorView = EmptyInspector | WidgetInspector;

export function inspectorView(input: InspectorInput): InspectorView {
  const widget = input.widgets.find((one) => one.id === input.selected);
  if (widget === undefined) return { kind: 'empty' };

  const name = labelFor(widget.type);
  // The lane the person chose only survives when there is a panel to override.
  const lane: InspectorLane = input.inkAvailable ? input.lane : 'wall';
  const base = {
    kind: 'widget' as const,
    widgetId: widget.id,
    type: widget.type,
    title: `${name} widget`,
    removeLabel: `Remove this ${name.toLowerCase()} widget`,
    laneBarVisible: input.inkAvailable,
    lane,
    hasInkOverrides: Object.keys(inkOf(widget.config)).length > 0,
  };
  if (lane === 'ink') return base;

  const why = omittedReason(widget, input.widgets, input.notDrawn);
  const density = densityNote(widget, input.drawnTier);
  return {
    ...base,
    ...(why === undefined ? {} : { note: omissionNote(why, input.surface) }),
    ...(density === undefined ? {} : { density }),
    tab: input.tab,
  };
}

/**
 * What each tier says a household will see, in their words rather than in the
 * table's.
 *
 * A rung's name is on the left because it is what a support answer and a bug
 * report can both point at, and because it is what the renderer stamps; the
 * sentence beside it is what the household actually reads. Neither is a
 * prediction — the tier comes from the drawn preview.
 */
const TIER_MEANING: Readonly<Record<TierName, string>> = {
  M0: 'too small for names \u2014 a mark shows how busy each day is',
  M1: 'showing one name per day',
  M2: 'showing 2\u20133 names per day',
  M3: 'showing 4\u20135 names per day',
  M4: 'showing 6 or more names per day, with times',
};

/** The same, for a list, where a "day" is a row and there are no cells. */
const LIST_MEANING: Readonly<Record<TierName, string>> = {
  M0: 'room for one event',
  M1: 'room for one event',
  M2: 'room for 2\u20133 events',
  M3: 'room for 4\u20135 events',
  M4: 'room for 6 or more events',
};

function densityNote(
  widget: InspectableWidget,
  drawn: TierName | undefined,
): string | undefined {
  if (drawn === undefined || widget.type !== 'calendar') return undefined;
  // Named from the tier the renderer stamped rather than looked up by string,
  // so a rung this build does not know reads as the quiet one instead of
  // throwing inside a panel the household is looking at.
  const tier = tierNamed(drawn).tier;
  const shape = calendarView(widget.config);
  if (shape.view === 'list') return `Upcoming list, ${tier}, ${LIST_MEANING[tier]}`;
  const what = shape.view === 'week' ? 'Week columns' : 'Month grid';
  return `${what}, ${tier}, ${TIER_MEANING[tier]}`;
}

