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

import { groupIsOrdered, parentIdOf } from './group-cells.js';
import { inkOf } from './ink.js';
import {
  fallbackChoices,
  fallbackOf,
  omissionNote,
  omissionOf,
  type NotDrawn,
  type OmissionFacts,
  type Surface,
} from './omission.js';
import { tierNamed, type TierName } from './tiers.js';
import { describeWidget, labelFor } from './widget-labels.js';
import { calendarView } from './widget-views.js';

export type InspectorTab = 'content' | 'style';
export type InspectorLane = 'wall' | 'ink';

/** All the inspector needs of a widget. */
export interface InspectableWidget {
  readonly id: string;
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
  /** The group this box sits inside (RFC 014 §5.1), read defensively. */
  readonly parentId?: unknown;
}

export interface InspectorInput {
  readonly widgets: readonly InspectableWidget[];
  /** The selected widget's id, or nothing — the *primary* selection. */
  readonly selected: string | undefined;
  /**
   * Every selected id, in selection order, when more than one is chosen
   * (RFC 014 §5.1). The first is `selected`. Absent or a single id is the
   * ordinary one-widget inspector.
   */
  readonly selection?: readonly string[] | undefined;
  /** Which lane the person last chose. Ignored when no panel follows. */
  readonly lane: InspectorLane;
  /** Whether a panel follows this canvas, so an override would be read. */
  readonly inkAvailable: boolean;
  /** Which tab the person last chose. The wall lane only has tabs. */
  readonly tab: InspectorTab;
  readonly notDrawn: NotDrawn;
  /**
   * What the server decided the flags from, so a box's fallback can be asked
   * whether it has anything to say itself (RFC 014 §5.3). Absent on an older
   * server's page, where a chosen fallback is believed.
   */
  readonly facts?: OmissionFacts | undefined;
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

/**
 * Two or more boxes selected (RFC 014 §5.1): the shared Style controls and
 * nothing else. The Content tab is each widget's own and means nothing across
 * a clock and a calendar; Duplicate and Remove are one box's; the ink lane is
 * one box's. What every widget shares is its style lane, and that is what a
 * multi-selection is for — one colour onto three boxes at once.
 */
export interface MultiInspector {
  readonly kind: 'multi';
  readonly widgetIds: readonly string[];
  readonly title: string;
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
   * "When this has nothing to show" (RFC 014 §5.3): offered on a box the wall
   * would leave out, and on one that already names a fallback so it can be
   * taken back. Wall lane only — a panel substitutes where its wall does, so
   * there is nothing for the ink lane to say differently.
   *
   * `current` is the chosen fallback's type, or nothing for "leave the box
   * empty"; `choices` is what may stand in, never including a type the wall
   * would leave out too.
   */
  readonly fallback?:
    | { readonly current: string | undefined; readonly choices: readonly string[] }
    | undefined;
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
  /**
   * A child of a row, a column or a grid takes its place from the group's
   * order (RFC 014 §5.1), so the position fields would be two controls that do
   * nothing and a drag is a reorder. Said in the panel, above the box fields'
   * place, and the fields are not drawn. Absent for every other box.
   */
  readonly placement?: string | undefined;
}

export type InspectorView = EmptyInspector | WidgetInspector | MultiInspector;

/** The sentence a child of an ordered group reads in place of its position fields. */
export const ORDERED_CHILD_NOTE =
  'This box takes its place from the group’s order. Drag it past a neighbour, or use the arrow keys, to reorder.';

export function inspectorView(input: InspectorInput): InspectorView {
  const several = (input.selection ?? []).filter((id) => input.widgets.some((one) => one.id === id));
  if (several.length > 1) {
    return { kind: 'multi', widgetIds: several, title: `${several.length} widgets selected` };
  }
  const widget = input.widgets.find((one) => one.id === input.selected);
  if (widget === undefined) return { kind: 'empty' };

  const name = labelFor(widget.type);
  const parentId = parentIdOf(widget);
  const parent = parentId === undefined ? undefined : input.widgets.find((one) => one.id === parentId);
  const ordered = parent !== undefined && groupIsOrdered(parent.config);
  // The lane the person chose only survives when there is a panel to override.
  const lane: InspectorLane = input.inkAvailable ? input.lane : 'wall';
  const base = {
    kind: 'widget' as const,
    widgetId: widget.id,
    type: widget.type,
    title: `${name} widget`,
    // A group goes with what it holds, and the button says so before it is
    // pressed: three widgets is more than "this widget" promises to destroy.
    removeLabel:
      widget.type === 'group'
        ? 'Remove this group and the widgets in it'
        : `Remove this ${name.toLowerCase()} widget`,
    laneBarVisible: input.inkAvailable,
    lane,
    hasInkOverrides: Object.keys(inkOf(widget.config)).length > 0,
  };
  if (lane === 'ink') return base;

  const omission = omissionOf(widget, input.widgets, input.notDrawn, input.facts);
  const density = densityNote(widget, input.drawnTier);
  const chosen = fallbackOf(widget.config);
  const offersFallback = input.notDrawn.has(widget.id) || chosen !== undefined;
  return {
    ...base,
    ...(omission === undefined
      ? {}
      : {
          note: omissionNote(
            omission.why,
            input.surface,
            omission.instead === undefined ? undefined : describeWidget(omission.instead),
          ),
        }),
    ...(offersFallback
      ? {
          fallback: {
            current: chosen?.type,
            choices: withCurrent(fallbackChoices(widget.type, input.facts), chosen?.type),
          },
        }
      : {}),
    ...(density === undefined ? {} : { density }),
    ...(ordered ? { placement: ORDERED_CHILD_NOTE } : {}),
    tab: input.tab,
  };
}

/**
 * The picker's choices, keeping a stored fallback the facts would not offer
 * today — a Shift badge chosen before the rota was deleted — so the control
 * says what is stored rather than quietly showing the first option, which is
 * `buildTodoConfig`'s rule for a list no longer watched.
 */
function withCurrent(choices: readonly string[], current: string | undefined): readonly string[] {
  return current === undefined || choices.includes(current) ? choices : [...choices, current];
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

