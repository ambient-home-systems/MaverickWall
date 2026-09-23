import { createHash } from 'node:crypto';

import { isHhmm, isSlotName, type ScheduleRow } from './layout-slots.js';

import {
  addDays,
  eachDate,
  matchShiftTitle,
  resolveShifts,
  weekNumber,
  type CivilDate,
  type ResolvedShift,
  type ShiftOverride,
  type ShiftPlan,
  type ShiftType,
  type Interrupt,
  type WeekScheme,
} from '@maverick-wall/core';

import { canvasGutterStep } from '../gutter.js';
import { physicalWall } from '../wall-sizes.js';
import { builtinThemeTokens } from './builtin-themes.js';
import { resolveStyleTokens, storedStyleLayer, styleLayerOf, type WidgetStyle } from './widget-style.js';

/**
 * The manifest: everything a display needs, in one document.
 *
 * One round trip rather than several, because a display assembling its own view
 * from four endpoints can render half-updated state — today's events beside
 * yesterday's shift. Making the document the unit of consistency removes that
 * whole category of bug from the client, which is the component least able to
 * report what went wrong.
 *
 * Assembly is pure: it takes plain rows and returns a document. The database
 * queries live next door, so everything below can be tested without one.
 */

export const MANIFEST_VERSION = 1;

/**
 * What a document built for no wall wears.
 *
 * A stand-in, not a default (RFC 015 §3.2): a default is a value a household's
 * walls inherit, and nothing inherits this. It is the theme of the document a
 * wall gets when its database could not be read — there *is* no screen row to
 * ask — and of the admin's own previews, which name no wall. Every real wall
 * carries its own theme in its row, and the `CHECK` on `screens` refuses one
 * that does not. `panels`, because the display bundle's own unknown-key
 * fallback is Panels too, so the two floors agree.
 */
export const STAND_IN_THEME = 'panels';

/** Everything a wall can show. Order is the household's to choose. */
export type DisplayBlock = 'now' | 'weather' | 'home' | 'next' | 'horizon' | `ext:${string}`;

const ALL_BLOCKS: readonly DisplayBlock[] = ['now', 'weather', 'home', 'next', 'horizon'];

/**
 * The widgets a free-form canvas may hold — first-party modules only.
 *
 * Never a third-party embed: rule three forbids a web page, an iframe, or a
 * remote script on the wall, so there is no `website`, no `html`, no `video`
 * here however much a canvas builder invites them. A row of any other type is
 * dropped on the way to the display rather than handed to a renderer that does
 * not exist.
 */
export const WIDGET_TYPES = [
  'clock',
  'calendar',
  'weather',
  'homeassistant',
  'shift',
  'notes',
  'todo',
  // The household's chore board (RFC 008). Read-only in phase 2: it says what
  // is due and what is done, and offers no way to tick one off.
  'chores',
  'countdown',
  'image',
  // A panel from a registered third-party module (docs/rfc-001-module-framework.md).
  // Still first-party by the rule that matters: the wall draws sanitised strings
  // through renderGenericPanel, never anything the module ships.
  'external',
  // A container that lays its children out in a row, a column or a grid
  // (RFC 014 §5.1). It draws nothing of its own: a child is a row of
  // `layout_widgets` naming it as `parent_id`, and both renderers place the
  // group's box and then the children inside it, each read as a box of its own.
  'group',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/**
 * Which module backs each widget type, by the block key its data arrives under.
 *
 * Transcribed rather than imported. `manifest.ts` is the pure assembly layer and
 * the module registry is the database-reading one, so pulling in the three
 * `*_BLOCK` constants would drag the whole module tree into the file whose one
 * property is that it has none. `test/widget-omission.test.ts` compares this
 * table against the registry's own keys in both directions, the way
 * `epaper-ladder-parity.test.ts` compares the two ladder tables.
 *
 * A type that is absent here is backed by no module — see `widgetIsSetUp` for
 * what that means and which types are deliberately not in the list.
 */
export const WIDGET_MODULE: Readonly<Record<string, string>> = {
  weather: 'weather',
  homeassistant: 'home',
  chores: 'chores',
  /*
   * Conditional on the widget's own config, and the one entry here that is.
   *
   * A `todo` widget with no `list` is typed text and always has something to
   * say; one naming a Home Assistant list has a prerequisite on another screen
   * exactly as Weather does. Keying it here alone would have omitted every
   * typed checklist on every wall whose household has no list — at one image
   * pull, silently — which is why `widgetIsSetUp` takes the widget rather than
   * the type, and why `widget-omission.test.ts` was written red against a bare
   * `todo: 'todo'` before it was made to pass (RFC 012 §6.2).
   */
  todo: 'todo',
};

/**
 * What a widget's `list` becomes on the wall.
 *
 * A widget stores the Home Assistant entity id it draws (`widget-schema.ts`),
 * and rule 12 says the display never receives one — so the manifest rewrites
 * the key on the way out and the to-do panel keys its lists the same way. A
 * short hash rather than a random token, because it has to be *stable* across
 * polls with no registry: the same list resolves to the same key for ever, on
 * every wall, and the wall still holds nothing it could ask Home Assistant a
 * question with. Pure, and here rather than in the module, because both the
 * assembly layer and the e-paper renderer need it and neither may import the
 * module tree.
 */
export function todoListHandle(entityId: string): string {
  return createHash('sha256').update(`todo-list|${entityId}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * A widget's config as the wall receives it.
 *
 * Carried through untouched for every type but one: a `todo` widget's `list`
 * is an entity id and leaves as its handle. Nothing else is rewritten, so a
 * config saved before the key existed is byte-identical on the way out.
 *
 * **Except that `whenEmpty` never leaves** (RFC 014 §5.3). It is resolved
 * before this — a box that needed its fallback is already wearing it — so the
 * wall has no use for it, and carrying it would carry a to-do fallback's
 * *entity id* to the wall inside a box that is not a to-do widget, which is
 * rule 12 broken one level down where `list`'s rewrite cannot see. A config
 * that never named one is untouched, so no stored ETag moves.
 */
export function displayConfig(type: string, config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config;
  let out = config as Record<string, unknown>;
  if ('whenEmpty' in out) {
    const { whenEmpty: _resolved, ...rest } = out;
    out = rest;
  }
  if (type !== 'todo') return out;
  const list = out['list'];
  if (typeof list !== 'string' || list === '') return out;
  return { ...out, list: todoListHandle(list) };
}

/**
 * What the household has actually set up (RFC 009 Phase 2).
 *
 * `modules` is the block key of every panel module that answered `ready` —
 * which is already the seam meaning "the household has configured this":
 * weather with a location, Home Assistant with at least one watched entity, a
 * chore board with an active chore. It is collected outside assembly and passed
 * in, exactly as `panels` is, because `ready` reads the database and nothing in
 * this file does any I/O.
 *
 * Note what this is *not*: it is not whether a module has data right now. A
 * module that is ready and whose cache is empty contributes no panel, and that
 * widget keeps its "Nothing to show yet." — "the feed is empty today" is
 * information. This answers the other question.
 */
export interface HouseholdSetUp {
  readonly modules: readonly string[];
  /** A shift rotation exists at all — `household_settings.shift_enabled`. */
  readonly shift: boolean;
  /**
   * The Home Assistant to-do lists the household watches, by entity id
   * (RFC 012). Required rather than defaulted, for the reason `addCalendarSource`
   * takes its clock: a caller that forgot it would silently omit every list
   * widget on every wall, and a default is how that omission would come back.
   */
  readonly todoLists: readonly string[];
}

/**
 * All `widgetIsSetUp` needs of a widget: its type, and its own settings — and,
 * for the group rule in `keepWidgetsWithSomethingToSay`, which box it is and
 * which group it sits inside (RFC 014 §5.1). Both optional, because most
 * callers ask about a type alone.
 */
export interface SetUpTarget {
  readonly type: string;
  readonly config?: unknown;
  readonly id?: string;
  readonly parentId?: string;
}

/**
 * The Home Assistant list a `todo` widget names, or nothing for typed text.
 * Read here and in the e-paper renderer and the wall the same way: absent, or
 * empty, means the typed items — one stored value, one reading.
 */
export function todoListOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const list = (config as Record<string, unknown>)['list'];
  return typeof list === 'string' && list !== '' ? list : undefined;
}

/**
 * Can this widget ever have anything to say, given what the household has set
 * up? (RFC 009 Phase 2.)
 *
 * A fresh install seeds the Classic canvas, whose Weather and Shift boxes are
 * 24% of the portrait wall and say "Nothing to show yet." for ever — because
 * nothing asked for a location or a rota, and nothing on the wall can. That is
 * a sentence about the household's admin printed on their kitchen calendar, and
 * absence is the honest answer to it.
 *
 * The line drawn here, and it is the whole design:
 *
 *  - **A widget whose prerequisite lives on another screen** — weather (a
 *    location), Home Assistant (a watched entity), chores (an active chore),
 *    shift (a rotation) — is omitted when that prerequisite does not exist.
 *    Its placeholder can only ever say "nothing", it points at a control that
 *    is not on the wall, and no amount of looking at the wall will change it.
 *  - **A widget whose content is typed into the widget itself** — notes, to-do,
 *    a picture, a countdown, and the external panel's choice of module — keeps
 *    its own prompt ("Add a note in this widget's options"). That prompt names
 *    a control one click away, and omitting the box would make it vanish out
 *    from under somebody who dragged it on ten seconds ago and is filling it in.
 *  - **Clock and calendar are never omitted.** A clock needs nothing, and a
 *    month grid with no feeds still draws the dates — the calendar is the
 *    product, and its grid is information before a single event arrives.
 *
 * "Configured but empty today" is deliberately on the *keep* side throughout:
 * a rota that says nothing about a Tuesday, a forecast that has not been
 * fetched yet, an entity whose reading is stale. Getting that backwards makes a
 * working wall look broken, which is a worse fault than the one this fixes.
 *
 * The widget's own config is an input for exactly one type, and that is the
 * change RFC 012 §6.2 asked for. "Configuration" here still means the
 * household-level prerequisite, not the box's settings — a Weather widget with
 * five days and a reordered ladder chosen is still a Weather widget with
 * nowhere to be. But a `todo` widget's prerequisite *depends on its settings*:
 * with no `list` it is typed text and always has something to say; naming a
 * list, it needs that list to still be watched, which is a prerequisite on the
 * Home Assistant screen exactly like a location is on Weather. The function
 * takes the widget rather than the type because the type cannot answer that,
 * and the alternative — a bare `todo: 'todo'` in the table above — omitted
 * every typed checklist on every wall with no list behind it.
 */
export function widgetIsSetUp(widget: SetUpTarget, setUp: HouseholdSetUp): boolean {
  if (widget.type === 'shift') return setUp.shift;
  if (widget.type === 'todo') {
    const list = todoListOf(widget.config);
    if (list === undefined) return true;
    // A list still watched implies the module is ready, since `ready` is
    // "at least one watched list" — so one membership test answers both.
    return setUp.todoLists.includes(list);
  }
  const block = WIDGET_MODULE[widget.type];
  return block === undefined || setUp.modules.includes(block);
}

/**
 * What a box draws instead when it has nothing to say (RFC 014 §5.3), or
 * nothing when it names no fallback.
 *
 * Read defensively although the editor wrote it through `whenEmptyBody`: a
 * type this build does not draw, or a config that is not an object, is no
 * fallback rather than a box the wall cannot draw — the same rule
 * `placeCanvas` applies to a stored row's own type.
 */
export function fallbackOf(config: unknown): { readonly type: string; readonly config: unknown } | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const raw = (config as Record<string, unknown>)['whenEmpty'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as Record<string, unknown>)['type'];
  if (typeof type !== 'string' || !(WIDGET_TYPES as readonly string[]).includes(type)) return undefined;
  const own = (raw as Record<string, unknown>)['config'];
  return { type, config: typeof own === 'object' && own !== null ? own : {} };
}

/** A widget as it leaves the omission — itself, or its fallback wearing its box. */
export type Resolved<T extends SetUpTarget> = T & { readonly substituted?: true };

/**
 * Drop the widgets with nothing to say — unless that would leave nothing at all.
 *
 * The guard is rule nine and it is not theoretical: a canvas holding only a
 * Weather box would otherwise draw "Nothing on this display yet.", which is a
 * lie about a display somebody arranged, and worse than the per-widget note it
 * replaced. A wall that has been arranged always draws something it was given.
 *
 * Shared by the wall's canvas and the e-paper panel's, so a panel following a
 * wall cannot draw "No weather yet" where the wall draws nothing — one stored
 * value read two ways is the fault this repository keeps paying for.
 *
 * **And it is where a box's fallback is resolved, for the same reason**
 * (RFC 014 §5.3). A widget with nothing to say that names a `whenEmpty` becomes
 * that widget — same id, same box, same `z`, `substituted: true` — provided the
 * fallback has something to say itself; one that has not is dropped exactly as
 * the widget would have been. Only the omitted are substituted, so a fallback
 * never replaces a real widget: a Weather box with a location draws weather
 * whatever it names.
 *
 * **The order is the whole of it: substitute, *then* guard.** The guard keeps
 * every original when nothing survives, which is right when nothing *could*
 * — and wrong when the canvas is a Weather box and a Shift badge, neither set
 * up, each naming a note. Guarding first sees "nothing to say", keeps both
 * originals, and draws two placeholders the household had already written the
 * answer to. Substituting first draws the two notes. When even the fallbacks
 * have nothing, the guard hands back the *originals* rather than their
 * fallbacks — the canvas somebody arranged, unedited, which is what it always
 * drew.
 */
export function keepWidgetsWithSomethingToSay<T extends SetUpTarget>(
  widgets: readonly T[],
  setUp: HouseholdSetUp,
): readonly Resolved<T>[] {
  /*
   * The tree first (RFC 014 §5.1), so a group refused here cannot be kept by
   * the guard below: a group inside a group and a child whose parent is not a
   * group on this canvas are dropped before anything is asked about them.
   */
  const tree = pruneWidgetTree(widgets);
  const resolve = (widget: T): Resolved<T> | undefined => {
    if (widgetIsSetUp(widget, setUp)) return widget;
    const fallback = fallbackOf(widget.config);
    if (fallback !== undefined && widgetIsSetUp(fallback, setUp)) {
      return { ...widget, type: fallback.type, config: fallback.config, substituted: true } as Resolved<T>;
    }
    return undefined;
  };
  /*
   * A group has something to say exactly when one of its children does. It
   * draws nothing of its own, so asking `widgetIsSetUp` about it would keep an
   * empty box on every wall; and it carries no fallback of its own, because
   * its children are boxes and each resolves its own — a Weather child naming
   * a note draws that note inside the group. When none of them has anything to
   * say, fallbacks included, the group goes whole, children with it.
   */
  const resolved = new Map<T, Resolved<T> | undefined>();
  for (const widget of tree) {
    if (widget.type !== 'group') resolved.set(widget, resolve(widget));
  }
  const groupKept = new Set<string>();
  for (const widget of tree) {
    if (widget.parentId !== undefined && resolved.get(widget) !== undefined) groupKept.add(widget.parentId);
  }
  const kept: Resolved<T>[] = [];
  for (const widget of tree) {
    if (widget.type === 'group') {
      if (widget.id !== undefined && groupKept.has(widget.id)) kept.push(widget);
      continue;
    }
    if (widget.parentId !== undefined && !groupKept.has(widget.parentId)) continue;
    const answer = resolved.get(widget);
    if (answer !== undefined) kept.push(answer);
  }
  return kept.length === 0 ? tree : kept;
}

/**
 * The widgets whose group links hold, and nothing else (RFC 014 §5.1).
 *
 * The boundary refuses these shapes with a 400 (`placedWidgetsBody`), and this
 * refuses them a second time on the way to a renderer, because a row reaches
 * the database by more than one door and a wall cannot handle a child whose
 * parent is not there. Dropped, never orphaned: a child's fractions are of its
 * group's box, and drawn on the canvas they would land somewhere nobody put
 * them. Nesting is one level, so a group naming a parent goes too — with its
 * children, since their parent is then gone.
 *
 * Both renderers' paths go through `keepWidgetsWithSomethingToSay`, which
 * calls this first; exported so a caller that wants only the pruning can ask.
 */
export function pruneWidgetTree<T extends SetUpTarget>(widgets: readonly T[]): readonly T[] {
  const groups = new Set<string>();
  for (const widget of widgets) {
    if (widget.type === 'group' && widget.parentId === undefined && widget.id !== undefined) groups.add(widget.id);
  }
  return widgets.filter((widget) => {
    if (widget.type === 'group') return widget.parentId === undefined;
    return widget.parentId === undefined || groups.has(widget.parentId);
  });
}

/**
 * Read the stored order, and never return nothing.
 *
 * Duplicates are dropped and unknown names ignored, so a hand-edited row
 * cannot make a block render twice or make the display defend against a name
 * it has no renderer for. An empty result falls back to all three: a wall that
 * draws nothing is the one outcome rule nine forbids, and an empty list is far
 * more likely to be a mistake than a household asking for a blank screen.
 */
export function parseBlocks(stored: string | undefined): DisplayBlock[] {
  const seen: DisplayBlock[] = [];
  for (const raw of (stored ?? '').split(',')) {
    const name = raw.trim().toLowerCase();
    // A built-in block, or a registered third-party one (`ext:<id>`). A
    // third-party key that no longer has a module is simply drawn as nothing by
    // the display, the same as a built-in a module has switched off.
    if (!ALL_BLOCKS.includes(name as DisplayBlock) && !name.startsWith('ext:')) continue;
    if (seen.includes(name as DisplayBlock)) continue;
    seen.push(name as DisplayBlock);
  }
  return seen.length === 0 ? [...ALL_BLOCKS] : seen;
}

const unit = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * Clamp and type-check one canvas's stored rows into the shape the wall draws,
 * and drop the ones the household has nothing set up for (RFC 009 Phase 2).
 *
 * The type check comes first, so a row of an unknown type cannot make it as far
 * as the "would this leave nothing?" guard and keep a canvas the wall could not
 * draw anyway.
 */
/**
 * What a style lane is resolved against (RFC 014 §4.1).
 *
 * `active` is the wall's theme as colour tokens — a custom theme's own, or
 * the built-in's transcription — and `daytime` the same for a scheduled
 * daylight theme, absent when there is none. `canvas` is the wall's default
 * lane, applied on the canvas and the layer beneath every widget's own.
 */
export interface StyleContext {
  readonly active: Readonly<Record<string, string>>;
  readonly daytime?: Readonly<Record<string, string>>;
  readonly canvas?: WidgetStyle;
}

/** No lanes at all — what every caller that predates the lane gets. */
const NO_STYLE: StyleContext = { active: builtinThemeTokens(STAND_IN_THEME) };

/**
 * A widget's own lane, resolved for the active theme and, when the wall
 * switches at daylight, for that theme too — spread rather than emitted, so
 * an unstyled widget's row is byte-identical to the one it sent before.
 *
 * Two records rather than one because the *derived* half depends on the
 * ground: a widget that sets `--ink` alone gets a scaffold measured against
 * the theme's `--bg`, and the daytime theme's `--bg` is a different colour.
 * The display applies whichever theme it is showing, which only it knows.
 */
function widgetStyleFields(
  config: unknown,
  styling: StyleContext,
): { readonly styleTokens?: Record<string, string>; readonly daytimeStyleTokens?: Record<string, string> } {
  const own = styleLayerOf(typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['style'] : undefined);
  if (own === undefined) return {};
  const context = styling.canvas === undefined ? [] : [styling.canvas];
  const active = resolveStyleTokens(styling.active, context, own);
  const day = styling.daytime === undefined ? undefined : resolveStyleTokens(styling.daytime, context, own);
  return {
    ...(active === undefined ? {} : { styleTokens: active }),
    ...(day === undefined ? {} : { daytimeStyleTokens: day }),
  };
}

function placeCanvas(
  widgets: readonly PlacedWidgetRow[],
  setUp: HouseholdSetUp,
  styling: StyleContext,
): Manifest['layout']['portrait']['widgets'] {
  const drawable = widgets.filter((widget) =>
    (WIDGET_TYPES as readonly string[]).includes(widget.type),
  );
  // The tree is pruned inside `keepWidgetsWithSomethingToSay` — a group in a
  // group and a child with no group on this canvas are refused here a second
  // time after the boundary (RFC 014 §5.1).
  return keepWidgetsWithSomethingToSay(drawable, setUp)
    .map((widget) => ({
      id: widget.id,
      // A fallback drawing in this box (RFC 014 §5.3): the wall labels nothing
      // and draws `type` as it draws any widget — the mark is for the editor
      // and for anybody reading the manifest. Spread, so a box that is itself
      // carries no key and no ETag churns.
      ...(widget.substituted === true ? { substituted: true as const } : {}),
      type: widget.type,
      x: unit(widget.x, 0),
      y: unit(widget.y, 0),
      // A zero-size widget is invisible; fall back to a readable default.
      w: unit(widget.w, 0.25) || 0.25,
      h: unit(widget.h, 0.15) || 0.15,
      z: Number.isFinite(widget.z) ? Math.trunc(widget.z) : 0,
      // Untouched, except that a to-do widget's entity id leaves as a handle.
      config: displayConfig(widget.type, widget.config),
      // The style lane, resolved (RFC 014 §4.1) — absent for a widget that
      // carries none, which is every widget until a household opens the tab.
      ...widgetStyleFields(widget.config, styling),
      // The group this box sits inside (RFC 014 §5.1). Spread, so a canvas
      // with no group serialises byte for byte as it did before the key.
      ...(widget.parentId !== undefined ? { parentId: widget.parentId } : {}),
      // The widget's own CSS, scoped (RFC 014 §7): spread on the same argument.
      ...(widget.customCss !== undefined && widget.customCss !== '' ? { customCss: widget.customCss } : {}),
    }))
    // Parents before children, then by z — a child's z is relative to its
    // group, so the two scales are not sorted against each other.
    .sort((a, b) => Number(a.parentId !== undefined) - Number(b.parentId !== undefined) || a.z - b.z);
}

const aspectOf = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * A canvas background (RFC 005 Phase 3): a solid colour or a two-stop gradient.
 * A first-party image background is Phase 3b and adds a variant here.
 */
export type CanvasBackground =
  | { readonly type: 'solid'; readonly color: string }
  | { readonly type: 'gradient'; readonly from: string; readonly to: string; readonly angle: number }
  | { readonly type: 'image'; readonly image: string };

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const STORED_IMAGE = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

/**
 * Parse the stored background JSON into a background the wall can draw.
 *
 * This process wrote the string (the editor validated its shape with Zod), but
 * it is read back defensively all the same — a colour that is not a hex or a
 * type the renderer has no arm for is dropped to "no background" rather than
 * handed to the wall, so a bad row costs a background, never the canvas.
 */
export function parseBackground(raw: string | null | undefined): CanvasBackground | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const bg = value as Record<string, unknown>;
  if (bg['type'] === 'solid' && typeof bg['color'] === 'string' && HEX6.test(bg['color'])) {
    return { type: 'solid', color: bg['color'] };
  }
  if (
    bg['type'] === 'gradient' &&
    typeof bg['from'] === 'string' && HEX6.test(bg['from']) &&
    typeof bg['to'] === 'string' && HEX6.test(bg['to'])
  ) {
    const angle = typeof bg['angle'] === 'number' && Number.isFinite(bg['angle'])
      ? ((Math.round(bg['angle']) % 360) + 360) % 360
      : 180;
    return { type: 'gradient', from: bg['from'], to: bg['to'], angle };
  }
  if (bg['type'] === 'image' && typeof bg['image'] === 'string' && STORED_IMAGE.test(bg['image'])) {
    return { type: 'image', image: bg['image'] };
  }
  return undefined;
}

/**
 * The free-form layout the display switches on.
 *
 * A display authors two canvases — portrait and landscape — and the wall draws
 * the one matching how it is hung (RFC 005); both travel in the manifest because
 * only the wall knows its live orientation. `mode` is `freeform` only when the
 * household chose it *and* at least one canvas has something to draw — both
 * empty would be a blank wall, which rule nine forbids, so it falls back to
 * `auto`. A canvas with nothing on it letterboxes the other on that orientation;
 * that choice lives in the display, which is the only place the live orientation
 * is known. Every widget is clamped and its type checked here, the one place
 * between a stored row and the wall. `config` is carried through untouched: it
 * is the widget's own, validated where the editor writes it.
 *
 * `readyModules` is what the household has set up (see `HouseholdSetUp`), and
 * a widget with nothing behind it is dropped rather than drawn as a permanent
 * note. Absent means "nothing is set up" rather than "keep everything": a
 * caller that forgets it would otherwise re-ship the fault silently, which is
 * the `options.json` bug in a different coat. The editor does not come through
 * here — it renders the rows it holds — so the widget is still visible, with
 * its placeholder, on the screen where the household can act on it.
 */
export function buildLayout(
  household: HouseholdRow,
  portraitWidgets: readonly PlacedWidgetRow[],
  landscapeWidgets: readonly PlacedWidgetRow[],
  readyModules: readonly string[] = [],
  watchedTodoLists: readonly string[] = [],
  /*
   * What each widget's style lane is resolved against (RFC 014 §4.1).
   * Defaulted, unlike `readyModules`, because the default is *safe*: a caller
   * that forgets it resolves any lane against Panels rather than against
   * nothing, and a widget with no lane — every widget the tests build — is
   * untouched either way.
   */
  styling: StyleContext = NO_STYLE,
  /*
   * The named canvases and the schedule (RFC 014 §5.2). Defaulted to none
   * because none is the safe answer — a caller that forgets them sends the
   * one-canvas document, which is what every caller sent before they existed.
   */
  slotRows: readonly LayoutSlotRows[] = [],
  schedule: readonly ScheduleRow[] = [],
): Manifest['layout'] {
  const setUp: HouseholdSetUp = {
    modules: readyModules,
    shift: household.shiftEnabled === 1,
    todoLists: watchedTodoLists,
  };
  const portrait = placeCanvas(portraitWidgets, setUp, styling);
  const landscape = placeCanvas(landscapeWidgets, setUp, styling);
  /*
   * Every slot goes through the same `placeCanvas` as the default — the same
   * omission, the same fallback, the same style resolution — so a schedule
   * cannot draw a box the default would have left out. A slot with nothing
   * drawable on either orientation is dropped from the document rather than
   * carried empty: the wall would fall back to the default for it anyway, and
   * the schedule row naming it still travels, so nothing on the glass differs.
   */
  const slots: ManifestLayoutSlot[] = [];
  for (const row of slotRows) {
    if (!isSlotName(row.slot)) continue;
    const p = placeCanvas(row.portrait, setUp, styling);
    const l = placeCanvas(row.landscape, setUp, styling);
    if (p.length === 0 && l.length === 0) continue;
    slots.push({ slot: row.slot, portrait: { widgets: p }, landscape: { widgets: l } });
  }
  const rows = schedule.filter(
    (row) => isSlotName(row.slot) && isHhmm(row.from) && isHhmm(row.to) && row.from !== row.to,
  );

  // Always free-form: the responsive "auto" layout was retired in favour of a
  // single rendering path. Every wall carries the Classic template's widgets (a
  // new display is seeded with them, and every existing wall was migrated onto
  // them by `backfillClassic`), so "auto" no longer exists as a mode. An empty
  // canvas — a display started blank, or a stale pre-migration cache — draws the
  // free-form "nothing yet" note rather than falling back to a second renderer.
  const mode = 'freeform' as const;

  const portraitBg = parseBackground(household.layoutBackground);
  const landscapeBg = parseBackground(household.layoutLandscapeBackground);

  return {
    mode,
    portrait: {
      aspect: aspectOf(household.layoutAspect, 0.5625),
      widgets: portrait,
      ...(portraitBg !== undefined ? { background: portraitBg } : {}),
    },
    landscape: {
      aspect: aspectOf(household.layoutLandscapeAspect, 1.7778),
      widgets: landscape,
      ...(landscapeBg !== undefined ? { background: landscapeBg } : {}),
    },
    // Spread, never emitted empty: a `"slots": []` on every wall in the world
    // would churn every stored ETag at one image pull (RFC 014 §5.2).
    ...(slots.length > 0 ? { slots } : {}),
    ...(rows.length > 0 ? { schedule: rows } : {}),
  };
}

export interface ManifestEvent {
  readonly id: string;
  readonly uid: string;
  readonly title: string;
  readonly location?: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: boolean;
  readonly sourceId: string;
  readonly color: string;
  readonly status: string;
  /** True when the event covers more than the day it is listed under. */
  readonly continues: boolean;
  /**
   * `false` when this event's calendar is kept off the grid — the month squares
   * and the week columns — and drawn only in the upcoming list.
   *
   * **Absent means shown**, which is the whole reason it is optional rather
   * than a plain boolean. Every household that has never touched the switch
   * sends a manifest byte-identical to the one they got before it existed, and
   * a display bundle older than this field ignores it and draws what it always
   * drew. The renderers read `!== false`, never `=== true`.
   */
  readonly showInGrid?: false;
  /**
   * Whose event this is, when its calendar has an owner. The display looks the
   * id up in `people` for the avatar and name — the per-event owner cue. Absent
   * for an "Everyone" calendar, which belongs to nobody in particular.
   */
  readonly personId?: string;
}

export interface ManifestShift {
  readonly key: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  /** An explicit per-type colour; the display derives its tints. Absent = token. */
  readonly color?: string;
  /** Optional `HH:MM` window, drawn on the wall. Absent = an untimed shift. */
  readonly startTime?: string;
  readonly endTime?: string;
  readonly isWorking: boolean;
  /** Where the answer came from, for the diagnostics overlay. */
  readonly source: string;
}

/**
 * A shift belonging to somebody.
 *
 * Households have more than one shift worker. Resolving a single timeline —
 * which an earlier version did — cannot say whose shift it is, and a wall
 * showing one person's rota while the other's is invisible is worse than showing
 * neither.
 */
export interface ManifestPersonShift extends ManifestShift {
  readonly personId: string;
  readonly personName: string;
  readonly personColor: string;
  readonly personAvatarUrl: string | null;
  /**
   * How far through an unbroken run of this same shift today is — `{ position:
   * 13, total: 14 }`.
   *
   * **Present only on today's entries**, because "how far through" is a
   * question about now; a run position on next Tuesday answers nothing anyone
   * asked. Absent when the run cannot be established (see `RUN_WINDOW_DAYS`).
   *
   * Computed here rather than on the wall, and that is the whole point of the
   * field. The display used to count backwards through the days *in the
   * manifest*, and the manifest carries one single day of history — so the
   * walk hit the window edge, could not tell "the run started here" from "I
   * ran out of data", and every run longer than a day read "Day 2 of N". The
   * server has the rota itself and can resolve any date mathematically.
   */
  readonly run?: { readonly position: number; readonly total: number };
}

export interface ManifestPerson {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly hasShiftRotation: boolean;
  /**
   * Where the display can fetch their picture, or null.
   *
   * A path on this server, never an external address — rule three, and the
   * wall has to work with no internet beyond the calendar feeds.
   */
  readonly avatarUrl: string | null;
}

export interface ManifestDay {
  readonly date: CivilDate;
  /**
   * One entry per person who has a shift that day, in the order people are
   * sorted. Empty when nobody does — which is different from the feature being
   * off, and the display should render those differently.
   */
  readonly shifts: readonly ManifestPersonShift[];
  readonly events: readonly ManifestEvent[];
  /**
   * Which week of the year this day is in (RFC 010 phase 4).
   *
   * Computed here rather than on the wall for two reasons: `packages/core` owns
   * the definition and the display deliberately depends on nothing, and the
   * *scheme* follows `weekStart`, which is a household setting the server
   * already holds. ISO for a Monday household, the 1-January scheme for a
   * Sunday one — so the number always labels a row it actually spans, which an
   * ISO number on a Sunday-start grid does not.
   *
   * Optional on the type so a fixture need not invent a number it does not
   * exercise. `buildManifest` always sets it, and the manifest tests assert
   * real values under both schemes — a test being the guarantee here rather
   * than the type, which is the right way round for this project.
   */
  readonly weekNumber?: number;
}

export interface ManifestSourceHealth {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
}

export interface ManifestNotice {
  readonly level: 'info' | 'warn' | 'error';
  readonly code: string;
  /** Written for someone standing in a kitchen, not for a log reader. */
  readonly message: string;
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly appVersion: string;
  /**
   * Authoritative server time.
   *
   * A wall tablet's clock drifts, and some never get NTP at all. The display
   * tracks the offset from this and never trusts its own clock for anything
   * that decides what to show.
   */
  readonly generatedAt: number;
  readonly timezone: string;
  readonly theme: {
    readonly active: string;
    readonly daytime?: string;
    readonly daytimeStartsAt?: string;
    readonly daytimeEndsAt?: string;
    /**
     * The `data-theme` shape for the active/daytime theme, and — for a *custom*
     * theme the display bundle has never heard of — its fully-resolved token
     * set. A built-in carries no tokens (the bundle owns them) and a shape equal
     * to its key; a custom theme carries the tokens and `board` as its shape, so
     * it inherits the default shape CSS. Absent on an older server, which is why
     * the display falls back to resolving the key itself.
     */
    readonly activeShape?: string;
    readonly activeTokens?: Readonly<Record<string, string>>;
    readonly daytimeShape?: string;
    readonly daytimeTokens?: Readonly<Record<string, string>>;
  };
  readonly window: { readonly from: CivilDate; readonly to: CivilDate };
  /**
   * How much to show, chosen by the household.
   *
   * In the manifest rather than the bundle so it can be changed from the admin
   * screen by somebody standing in the room, which is the only place the right
   * answer is knowable.
   */
  readonly display: {
    readonly todayEvents: number;
    readonly nextDays: number;
    readonly horizonWeeks: number;
    /** In drawing order. A block missing from this list is not drawn at all. */
    readonly blocks: readonly DisplayBlock[];
    /** 24-hour wall clock (the default) or 12-hour (RFC 005). */
    readonly clock24: boolean;
    /** Which day the month grid and week columns start on. */
    readonly weekStart: 'sunday' | 'monday';
  };
  /**
   * The free-form layout, when the household has chosen one.
   *
   * `mode` is what the display switches on: `auto` draws the responsive
   * zoom-pyramid from `display.blocks` above, and `freeform` draws a canvas. A
   * display authors two — `portrait` and `landscape` — and the wall draws the
   * one matching how it is hung, scaled to fit and letterboxed on a screen of a
   * different shape; the *display* selects, because only it knows its live
   * orientation. A canvas with no widgets letterboxes the other on that
   * orientation. Always present so an older display still finds `mode: 'auto'`.
   */
  readonly layout: {
    readonly mode: 'auto' | 'freeform';
    readonly portrait: {
      readonly aspect: number;
      readonly widgets: readonly ManifestPlacedWidget[];
      readonly background?: CanvasBackground;
    };
    readonly landscape: {
      readonly aspect: number;
      readonly widgets: readonly ManifestPlacedWidget[];
      readonly background?: CanvasBackground;
    };
    /**
     * The wall's *named* canvases, every one of them (RFC 014 §5.2), and the
     * schedule that picks between them — so the wall can swap at the boundary
     * offline, from its stored copy, for the reason both orientations travel.
     * A slot carries widgets only: its aspect and background are the
     * orientation's, above. **Both absent** on a wall with one canvas and no
     * schedule, which is every wall until a household makes a second one:
     * spread, never `[]`, because `manifestEtag` hashes the serialisation.
     */
    readonly slots?: readonly ManifestLayoutSlot[];
    readonly schedule?: readonly ManifestScheduleRow[];
  };
  /**
   * How this particular screen is hung.
   *
   * Per screen rather than per household: a tablet in the kitchen and a
   * television in the hall are mounted differently, and one of them is
   * probably on its side.
   */
  readonly screen: {
    readonly orientation: 'auto' | 'portrait' | 'landscape';
    readonly rotation: number;
    /**
     * Whether this screen may offer a way to acknowledge an interrupt.
     *
     * A property of the hardware, not the household — a hall television has a
     * remote and a panel screwed to a wall has nothing. The *effect* of
     * acknowledging stays household-wide.
     */
    readonly allowDismiss: boolean;
    /** Whether this screen may tick a chore off (RFC 008 phase 3). */
    readonly allowChores: boolean;
    /**
     * Whether this screen may tick an item off a Home Assistant to-do list
     * (RFC 012 phase 2).
     *
     * A property of the hardware like the two above it, and a *separate* one:
     * a household can want a kitchen tablet to cross the shopping off and want
     * the hall television to do neither. The wall hides the control when this
     * is false; the endpoint checks it again, because the display token is on
     * the wall.
     *
     * **Optional, and absent when it is off** — unlike its two neighbours,
     * which are always emitted. That is the `panelWidthMm` argument rather than
     * an inconsistency: this flag is false on every wall in the world until a
     * household opens a setting, and `manifestEtag` hashes the serialisation,
     * so emitting `"allowTodo": false` everywhere would churn every stored ETag
     * at one image pull — and every e-paper frame with them, which is a full
     * re-download on a battery panel for a control it cannot offer. Absent and
     * false are one state and the display reads them as one (`=== true`), so
     * there is nothing here to get wrong. `allowDismiss` and `allowChores`
     * shipped before that lesson was written down; this one has it.
     */
    readonly allowTodo?: boolean;
    /**
     * How large this screen is, and how far away it is read from.
     *
     * Millimetres — **facts, never a derived size in pixels**. The server does
     * not know what the browser calls a pixel: a wall reports a viewport, a
     * kiosk frame reports something else again, and the household's claim here
     * is about a physical picture. Only the page knows its own frame, so only
     * the page can turn these into an angle (`pxPerArcminute`, in the display's
     * `orientation.ts`).
     *
     * All three or none of them, and absent is the common case — a household
     * that never opens the setting sends the document it sent before this
     * field existed, byte for byte, so no stored ETag churns and an older
     * bundle on a wall reads a manifest it fully understands.
     */
    readonly panelWidthMm?: number;
    readonly panelHeightMm?: number;
    readonly readDistanceMm?: number;
    /**
     * How much room this wall leaves between the widgets on it, as a step on
     * the spacing scale — `0` (touching) to `4` (what every wall drew before
     * this field existed). RFC 014 §4.4.
     *
     * **Optional, and absent when the household has not chosen**, which is the
     * `panelWidthMm` argument above rather than a second convention:
     * `manifestEtag` hashes the serialisation, so a `"layoutGutter": null` on
     * every wall in the world would churn every stored ETag at one image pull
     * for a setting nobody opened. Absent and `4` draw the identical wall —
     * `.fw`'s padding is `calc(var(--s4) / 2)` either way — so a household who
     * saves the setting at its default moves their ETag once and nothing on
     * the glass.
     *
     * The display reads it through `gutterValue`, which answers `undefined`
     * for anything outside the ladder and so removes the property rather than
     * writing a value it cannot mean.
     */
    readonly layoutGutter?: number;
    /**
     * The wall's default style lane, resolved (RFC 014 §4.1 / §4.4): the
     * colours, faces, weight, tracking and inset every widget starts from,
     * applied on the canvas so every box inherits it. `layoutDaytimeStyleTokens`
     * is the same lane resolved against the daylight theme, present only when
     * the wall has one — the display applies whichever theme it is showing.
     *
     * **Optional, and absent when the household has not chosen**, on the
     * `layoutGutter` argument above: spread, never emitted empty, so a wall
     * nobody has restyled sends the document it sent before.
     */
    readonly layoutStyleTokens?: Readonly<Record<string, string>>;
    readonly layoutDaytimeStyleTokens?: Readonly<Record<string, string>>;
    /**
     * The wall's own CSS, scoped under its canvas at save time (RFC 014 §7):
     * the text the wall inserts after its own stylesheet, and never what the
     * household typed. **Optional, and absent until a household writes one**,
     * on the `layoutGutter` argument above — spread, never emitted empty.
     */
    readonly customCss?: string;
  };
  readonly days: readonly ManifestDay[];
  /** Everyone the wall knows about, so a legend can be drawn. */
  readonly people: readonly ManifestPerson[];
  readonly sources: readonly ManifestSourceHealth[];
  /** Empty in the healthy case. Anything here gets a banner on screen. */
  readonly notices: readonly ManifestNotice[];
  /**
   * What each panel module had to say, keyed by its block key.
   *
   * A module contributes data and never code — rule three forbids the display
   * from executing or fetching anything a module supplies, so the wall draws
   * these with first-party renderers keyed off the same block list the
   * household orders.
   */
  readonly panels: Readonly<Record<string, unknown>>;
  /**
   * Anything the wall should say over the top of the calendar.
   *
   * Highest priority first, already evaluated — the display decides how loudly
   * to draw one and nothing else. Empty in the healthy case, which is almost
   * always.
   */
  readonly interrupts: readonly Interrupt[];
}

/** Row shapes as they come out of the database, before assembly. */
export interface EventCacheRow {
  readonly id: string;
  readonly sourceId: string;
  readonly uid: string;
  readonly title: string;
  readonly location: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: number;
  readonly startLocalDate: string;
  readonly endLocalDate: string;
  readonly status: string;
}

export interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly visible: number;
  /**
   * 1 when this calendar draws on the calendar grid — the month squares and the
   * week columns — as well as in the upcoming list. 0 keeps it in the list and
   * out of the grid; see `calendar_sources.show_in_grid` for why that is a
   * different request from `visible`.
   */
  readonly showInGrid: number;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
  /**
   * Whose calendar this is, when it is one person's. When set, the person's
   * colour wins over `color` above, so a household's "Mum is blue everywhere"
   * holds across every event of hers — the whole point of assigning an owner.
   */
  readonly personId: string | null;
}

export interface HouseholdRow {
  readonly timezone: string;
  // No theme and no daylight schedule: a wall names its own (RFC 015 phase 2).
  readonly shiftEnabled: number;
  readonly displayTodayEvents: number;
  readonly displayNextDays: number;
  readonly displayHorizonWeeks: number;
  readonly displayBlocks: string;
  /** 1 for a 24-hour wall clock (the default), 0 for 12-hour (RFC 005). */
  readonly clock24: number;
  /** Which day the month grid starts on: `sunday` (default) or `monday`. */
  readonly weekStart: string;
  readonly layoutMode: string;
  readonly layoutAspect: number;
  /** The landscape canvas's aspect (RFC 005); the portrait one is layoutAspect. */
  readonly layoutLandscapeAspect: number;
  /** Per-orientation canvas background JSON, or null (RFC 005 Phase 3). */
  readonly layoutBackground: string | null;
  readonly layoutLandscapeBackground: string | null;
}

/**
 * One placed widget, already shaped for the wall.
 *
 * Coordinates are fractions of the authored canvas, clamped on the way in so a
 * hand-edited row cannot push a widget off the wall or size it past it — rule
 * nine, the display must draw something sane against any row it is handed.
 */
export interface PlacedWidgetRow {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  /** The widget's own settings, validated where it is written, not here. */
  readonly config: unknown;
  /**
   * The group this widget sits inside (RFC 014 §5.1). When set, the four
   * fractions above are of that group's box and `z` is relative to it. Absent
   * — never null — for a widget on the canvas itself, which is every row that
   * existed before the column did.
   */
  readonly parentId?: string;
  /**
   * The widget's own CSS, scoped to its box at save time (RFC 014 §7) — the
   * text the wall inserts, never what the household typed. Absent on every
   * widget until a household writes one, which keeps the row byte-identical
   * to what it sent before the column existed.
   */
  readonly customCss?: string;
}

/**
 * A placed widget as the manifest carries it: the row, plus its style lane
 * resolved (RFC 014 §4.1). Both records are absent on a widget with no lane,
 * which keeps its row byte-identical to what it sent before the lane existed.
 * `config` still carries the household's `style` object as written — the
 * display reads `styleTokens` and never `style`, exactly as the panel reads a
 * merged `ink` and the wall never looks at it.
 */
/** A named canvas's stored rows, as `readLayoutWidgets` hands them over. */
export interface LayoutSlotRows {
  readonly slot: string;
  readonly portrait: readonly PlacedWidgetRow[];
  readonly landscape: readonly PlacedWidgetRow[];
}

/** One named canvas, on both orientations (RFC 014 §5.2). */
export interface ManifestLayoutSlot {
  readonly slot: string;
  readonly portrait: { readonly widgets: readonly ManifestPlacedWidget[] };
  readonly landscape: { readonly widgets: readonly ManifestPlacedWidget[] };
}

/** Between `from` and `to` in the wall's zone, draw `slot` (RFC 014 §5.2). */
export interface ManifestScheduleRow {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
}

export interface ManifestPlacedWidget extends PlacedWidgetRow {
  /** This box is drawing its `whenEmpty` fallback rather than itself (RFC 014 §5.3). */
  readonly substituted?: true;
  readonly styleTokens?: Readonly<Record<string, string>>;
  readonly daytimeStyleTokens?: Readonly<Record<string, string>>;
}

export interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly hasShiftRotation: number;
  readonly sortOrder: number;
  readonly avatarPath: string | null;
}

export interface BuildManifestInput {
  readonly household: HouseholdRow;
  /**
   * The placed widgets for each canvas, read from the database and passed in —
   * assembly is pure and does no I/O, the same reason panels and interrupts
   * arrive already-collected. Empty when the household has never arranged that
   * orientation's canvas.
   */
  readonly layoutWidgetsPortrait?: readonly PlacedWidgetRow[];
  readonly layoutWidgetsLandscape?: readonly PlacedWidgetRow[];
  /**
   * The wall's named canvases and its schedule (RFC 014 §5.2). Absent or
   * empty is a wall with one canvas, which sends the document it always sent.
   */
  readonly layoutSlots?: readonly LayoutSlotRows[];
  readonly layoutSchedule?: readonly ScheduleRow[];
  readonly events: readonly EventCacheRow[];
  readonly sources: readonly SourceRow[];
  readonly people: readonly PersonRow[];
  readonly shiftTypes: readonly ShiftType[];
  readonly shiftPlans: readonly ShiftPlan[];
  readonly shiftOverrides: readonly ShiftOverride[];
  readonly today: CivilDate;
  readonly daysBefore: number;
  readonly daysAfter: number;
  readonly now: number;
  readonly appVersion: string;
  /**
   * What each panel module had to say, already collected.
   *
   * Passed in rather than gathered here, because assembly is pure and does no
   * I/O — every module reads its own cache, which its own job fills.
   */
  readonly panels?: Readonly<Record<string, unknown>>;
  /**
   * The block key of every module that answered `ready` — what the household
   * has actually set up (RFC 009 Phase 2).
   *
   * Collected by the caller for the same reason `panels` is: `ready` reads the
   * database and assembly does no I/O. Distinct from `panels`, and that
   * distinction is the whole point — a ready module whose cache is empty is in
   * here and not in there, which is what keeps "the feed is empty today"
   * showing its placeholder while "you never set this up" yields its space.
   */
  readonly readyModules?: readonly string[];
  /**
   * The Home Assistant to-do lists the household watches, by entity id, for
   * the one widget whose omission depends on its own config (RFC 012 §6.2).
   * Collected by the caller beside `readyModules`, from the same
   * `householdSetUp`, so the two cannot disagree.
   */
  readonly watchedTodoLists?: readonly string[];
  /**
   * Interrupts already evaluated, for the same reason panels are already
   * collected: assembly is pure and reads no cache of its own.
   */
  readonly interrupts?: readonly Interrupt[];
  /**
   * The screen this document is for, when it is being served to one.
   *
   * Its overrides win over the household's. Null on any of them means "follow
   * the household", which is the common case and the one that must stay easy.
   */
  readonly screen?: {
    readonly orientation: string;
    readonly rotation: number;
    readonly allowDismiss?: boolean;
    readonly allowChores?: boolean;
    readonly allowTodo?: boolean;
    /**
     * The wall's own theme, and nothing behind it (RFC 015 phase 2). Required
     * rather than nullable, so a caller that builds a document for a wall has
     * to say what it wears — the household row it used to fall back to has no
     * theme any more.
     */
    readonly theme: string;
    readonly timezone?: string | null;
    /** Null is the same theme all day; the hours are the wall's own too. */
    readonly daytimeTheme?: string | null;
    readonly daytimeStartsAt?: string | null;
    readonly daytimeEndsAt?: string | null;
    /** The physical facts, straight off the row; null until measured. */
    readonly panelWidthMm?: number | null;
    readonly panelHeightMm?: number | null;
    readonly readDistanceMm?: number | null;
    /** The gutter step off the row; null until the household chooses one. */
    readonly layoutGutter?: number | null;
    /** The wall's default style lane, as stored JSON; null until chosen. */
    readonly layoutStyle?: string | null;
    /** The wall's own CSS, already scoped; null until written (RFC 014 §7). */
    readonly customCss?: string | null;
  };
  /**
   * Resolve a theme reference to its shape and (for a custom theme) its tokens.
   * Injected so assembly stays free of a database read — the caller closes over
   * the db, exactly as the module panels are collected outside `buildManifest`.
   * Absent leaves the theme as bare keys, which is the built-in-only behaviour.
   */
  readonly resolveTheme?: (
    ref: string,
  ) => { readonly tokens?: Readonly<Record<string, string>>; readonly shape: string };
  /** Anything the caller already knows is wrong: a failed migration, say. */
  readonly notices?: readonly ManifestNotice[];
}

/**
 * A rest day the rotation resolved deliberately.
 *
 * Not a shift type — there is no row for it and there should not be, because a
 * household defines the shifts they work rather than the ones they do not. It
 * exists so the display can tell "the rota says he is off" from "the rota says
 * nothing about this day", which are different facts and look different: the
 * design gives the first its own hue and leaves the second plain.
 */
/**
 * The display's path to a stored picture.
 *
 * Under `/d/`, so it is behind the same display token as the manifest itself.
 * A family's photographs must not be readable by anything on the network that
 * happens to know a filename.
 */
function avatarUrl(path: string | null | undefined): string | null {
  // `undefined` as well as null: a row read by an older query, or a caller
  // that predates the column, would otherwise produce `/d/media/undefined`
  // and a broken image on the wall.
  return path === null || path === undefined || path === '' ? null : `/d/media/${path}`;
}

/** A whole number inside a range, or the default when it is not one at all. */
function clamp(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

const BREAK_SHIFT = {
  key: 'break',
  label: 'Off',
  shortCode: 'B',
  colorToken: '--s-break',
  isWorking: false,
} as const;

function shiftFor(
  resolved: ResolvedShift | undefined,
  types: readonly ShiftType[],
): ManifestShift | undefined {
  if (!resolved) return undefined;

  if (resolved.shiftTypeKey === null) {
    // `none` means the rotation had nothing to say — no plan covers the day,
    // or the cycle is empty. Anything else is an explicit "not working", which
    // the wall should show.
    return resolved.source === 'none' ? undefined : { ...BREAK_SHIFT, source: resolved.source };
  }

  const type = types.find((candidate) => candidate.key === resolved.shiftTypeKey);
  if (!type) return undefined;
  return {
    key: type.key,
    label: type.label,
    shortCode: type.shortCode,
    colorToken: type.colorToken,
    // Only present when the type set them, so the manifest stays lean and the
    // display's "absent = token / untimed" fallbacks are the common path.
    ...(type.color !== undefined && type.color !== null ? { color: type.color } : {}),
    ...(type.startTime !== undefined && type.startTime !== null ? { startTime: type.startTime } : {}),
    ...(type.endTime !== undefined && type.endTime !== null ? { endTime: type.endTime } : {}),
    isWorking: type.isWorking,
    source: resolved.source,
  };
}

/**
 * Notices describing anything a household should be told about.
 *
 * A feed that has failed once is not worth mentioning — networks blip, and the
 * next sync is minutes away. Three consecutive failures means something is
 * actually wrong, and by then the events on screen are getting stale.
 */
function healthNotices(sources: readonly SourceRow[], now: number): ManifestNotice[] {
  const notices: ManifestNotice[] = [];
  const dayMs = 86_400_000;

  for (const source of sources) {
    if (source.consecutiveFailures >= 3) {
      const staleFor = source.lastSuccessAt === null ? null : now - source.lastSuccessAt;
      const age =
        staleFor === null
          ? 'has never synced'
          : `last updated ${Math.floor(staleFor / 3_600_000)} hours ago`;
      notices.push({
        level: source.lastSuccessAt === null ? 'error' : 'warn',
        code: 'source-failing',
        message: `"${source.name}" ${age}.`,
      });
    } else if (source.lastSuccessAt !== null && now - source.lastSuccessAt > 2 * dayMs) {
      // Not failing, but not succeeding either — a job that stopped being
      // scheduled looks exactly like this and would otherwise be invisible.
      notices.push({
        level: 'warn',
        code: 'source-stale',
        message: `"${source.name}" has not updated in over two days.`,
      });
    }
  }

  return notices;
}

/**
 * How far either side of today a run is followed before it is given up on.
 *
 * A rota cycle longer than this cannot be reported in full, so the number is
 * generous: at 90 days it covers every rotation anyone actually works.
 *
 * **The caller must supply events and overrides over this same range**, not
 * just the manifest window. A pattern plan resolves mathematically and needs
 * nothing, but a *calendar-derived* plan matches on event titles — so with only
 * the window's events it goes blind one day behind today and the walk stops
 * there. That is not a hypothetical: 0.40.0 moved this calculation to the
 * server and still reported "Day 2 of 3" for a fortnight of straights, because
 * the range was widened and the data feeding it was not. The guard below only
 * catches a run longer than we looked; it cannot catch data that was never
 * read.
 */
export const RUN_WINDOW_DAYS = 90;

/**
 * How far through an unbroken run of today's shift today is.
 *
 * Walks out from today in both directions while the resolved shift key is the
 * same one. `undefined` when today has no shift, and — deliberately — when the
 * run reaches either edge of the resolved range: at that point we do not know
 * where it starts or ends, and "Day 2 of 3" for a fortnight of nights is worse
 * than saying nothing, because a household believes it.
 */
function runFor(
  keyByDate: ReadonlyMap<CivilDate, string>,
  today: CivilDate,
): { position: number; total: number } | undefined {
  const key = keyByDate.get(today);
  if (key === undefined) return undefined;

  let before = 0;
  while (before < RUN_WINDOW_DAYS && keyByDate.get(addDays(today, -(before + 1))) === key) {
    before++;
  }
  let after = 0;
  while (after < RUN_WINDOW_DAYS && keyByDate.get(addDays(today, after + 1)) === key) after++;

  // Ran to the edge: the run is longer than we looked, so its ends are unknown.
  if (before >= RUN_WINDOW_DAYS || after >= RUN_WINDOW_DAYS) return undefined;
  return { position: before + 1, total: before + after + 1 };
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const from = addDays(input.today, -input.daysBefore);
  const to = addDays(input.today, input.daysAfter);
  const dates = eachDate(from, to);

  const visible = new Set(
    input.sources.filter((source) => source.visible === 1).map((source) => source.id),
  );
  /*
   * The calendars kept out of the grid — one filter, decided here.
   *
   * Stamped per event rather than shipped as a list of source ids the display
   * would have to apply, because then the rule lives in one place and every
   * renderer only has to honour a flag. Two renderers reading one stored value
   * and reaching different answers is this project's most repeated bug
   * (`shifts[0]`, `display_mode`, `cellEvents`), and the cure each time was to
   * resolve it once and hand over the answer.
   */
  const gridHidden = new Set(
    input.sources.filter((source) => source.showInGrid === 0).map((source) => source.id),
  );
  // Owner colour wins. A calendar that belongs to a person draws in that
  // person's colour, not its own, so their events read the same everywhere —
  // the wall's version of Skylight's colour-per-person. An owner whose colour
  // cannot be resolved (a dangling id) falls back to the calendar's own colour
  // rather than a grey nothing.
  const personColour = new Map(input.people.map((person) => [person.id, person.color]));
  // The owner of each source, but only when that owner still exists — a person
  // removed after the calendar was assigned to them leaves a dangling id, and a
  // dangling owner is no owner: the calendar keeps its own colour and attributes
  // to nobody rather than shipping a stale id the wall cannot resolve.
  const ownerOf = new Map(
    input.sources.map((source) => [
      source.id,
      source.personId !== null && personColour.has(source.personId) ? source.personId : null,
    ]),
  );
  const colours = new Map(
    input.sources.map((source) => {
      const owner = ownerOf.get(source.id);
      return [source.id, owner != null ? personColour.get(owner)! : source.color];
    }),
  );

  const shiftEnabled = input.household.shiftEnabled === 1;

  /**
   * Event titles per date, so calendar-derived shift plans can see them.
   *
   * Without this a `calendar` plan can never fire: it matches on titles, and
   * the resolver has no other way to learn them.
   */
  const titlesByDate = new Map<string, string[]>();
  if (shiftEnabled) {
    for (const row of input.events) {
      for (const date of eachDate(row.startLocalDate, row.endLocalDate)) {
        const bucket = titlesByDate.get(date) ?? [];
        bucket.push(row.title);
        titlesByDate.set(date, bucket);
      }
    }
  }

  /**
   * Resolved per person, by filtering the plans and overrides that name them.
   *
   * Reusing the single-timeline resolver rather than teaching it about people
   * keeps all the layering logic — override beats calendar beats pattern — in
   * one tested place, and means a household with one shift worker costs exactly
   * what it did before.
   */
  const people = [...input.people].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const shiftsByDate = new Map<string, ManifestPersonShift[]>();

  if (shiftEnabled) {
    for (const person of people) {
      const plans = input.shiftPlans.filter((plan) => {
        const owner = (plan as unknown as { personId?: string | null }).personId;
        // A plan with no owner predates people existing. Attribute it to the
        // first person rather than dropping it silently.
        return owner === person.id || (owner == null && person.id === people[0]?.id);
      });
      if (plans.length === 0) continue;

      const overrides = input.shiftOverrides.filter((override) => {
        const owner = (override as unknown as { personId?: string | null }).personId;
        return owner === person.id || (owner == null && person.id === people[0]?.id);
      });

      /*
       * Resolved wider than the manifest window, so today's run can be
       * followed to its real ends.
       *
       * The window portion is identical either way — same plans, same
       * overrides, same titles — so this is one pass, not two, and the extra
       * days cost arithmetic over a pattern and nothing else. Days outside the
       * window are used *only* for the run: they carry no events, so a
       * calendar-derived plan resolves to nothing out there, which is honest
       * (we genuinely do not know) and handled by `runFor` giving up.
       */
      const wide = resolveShifts({
        from: addDays(input.today, -RUN_WINDOW_DAYS),
        to: addDays(input.today, RUN_WINDOW_DAYS),
        plans,
        overrides,
        shiftTypes: input.shiftTypes,
        titlesByDate,
      });

      const keyByDate = new Map<CivilDate, string>();
      for (const resolved of wide) {
        const shift = shiftFor(resolved, input.shiftTypes);
        if (shift) keyByDate.set(resolved.date, shift.key);
      }
      const run = runFor(keyByDate, input.today);

      for (const resolved of wide) {
        if (resolved.date < from || resolved.date > to) continue;
        const shift = shiftFor(resolved, input.shiftTypes);
        if (!shift) continue;
        const bucket = shiftsByDate.get(resolved.date) ?? [];
        bucket.push({
          ...shift,
          personId: person.id,
          personName: person.name,
          personColor: person.color,
          personAvatarUrl: avatarUrl(person.avatarPath),
          // Only today's, because only today has a "how far through".
          ...(resolved.date === input.today && run !== undefined ? { run } : {}),
        });
        shiftsByDate.set(resolved.date, bucket);
      }
    }
  }

  /**
   * Plans that absorb the events they read.
   *
   * A feed marking every single day with "Working Day Shift" or "Break Day"
   * would otherwise fill the agenda with the same fact the day's colour already
   * carries, and bury the dentist appointment underneath it.
   */
  const consuming = shiftEnabled
    ? input.shiftPlans.filter((plan): plan is Extract<typeof plan, { kind: 'calendar' }> => {
        const record = plan as unknown as { kind: string; consumesEvents?: boolean };
        return record.kind === 'calendar' && record.consumesEvents !== false;
      })
    : [];

  const isConsumed = (sourceId: string, title: string): boolean =>
    consuming.some((plan) => {
      const record = plan as unknown as {
        calendarSourceId?: string;
        matchers?: readonly { shiftTypeKey: string | null; pattern: string; isRegex: boolean }[];
      };
      if (record.calendarSourceId !== undefined && record.calendarSourceId !== sourceId) {
        return false;
      }
      return matchShiftTitle(record.matchers ?? [], title) !== undefined;
    });

  // Events are bucketed by every local date they touch, so a multi-day trip
  // appears on each of its days rather than only the first. `continues` lets
  // the display draw it as a bar rather than repeating the title.
  const byDate = new Map<string, ManifestEvent[]>();
  for (const row of input.events) {
    if (!visible.has(row.sourceId)) continue;
    // Read as a shift, so it is not also listed as an appointment.
    if (isConsumed(row.sourceId, row.title)) continue;
    const span = eachDate(row.startLocalDate, row.endLocalDate);
    const multiDay = span.length > 1;
    for (const date of span) {
      const bucket = byDate.get(date) ?? [];
      bucket.push({
        id: row.id,
        uid: row.uid,
        title: row.title,
        ...(row.location !== null ? { location: row.location } : {}),
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: row.allDay === 1,
        sourceId: row.sourceId,
        color: colours.get(row.sourceId) ?? '#888888',
        status: row.status,
        continues: multiDay,
        // Only when it is off: absence is the default, so an untouched
        // household's manifest is unchanged and an older display is unaffected.
        ...(gridHidden.has(row.sourceId) ? { showInGrid: false as const } : {}),
        ...(ownerOf.get(row.sourceId) != null ? { personId: ownerOf.get(row.sourceId)! } : {}),
      });
      byDate.set(date, bucket);
    }
  }

  // The scheme follows the grid: an ISO week starts Monday, so numbering a
  // Sunday-start row with one would label a row spanning two of them.
  const mondayStart = input.household.weekStart === 'monday';
  const weekScheme: WeekScheme = mondayStart ? 'iso' : 'simple';
  const weekStartIndex = mondayStart ? 1 : 0;

  const days: ManifestDay[] = dates.map((date) => {
    const events = (byDate.get(date) ?? []).sort((a, b) => {
      // All-day first, then by start. A day's banner belongs above its agenda.
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
      return a.title.localeCompare(b.title);
    });
    return {
      date,
      shifts: shiftsByDate.get(date) ?? [],
      events,
      weekNumber: weekNumber(date, weekScheme, weekStartIndex).week,
    };
  });

  /*
   * The screen's own look, and nothing behind it (RFC 015 phase 2).
   *
   * This used to fall back to the household's theme and schedule, field by
   * field, and that fallback was the thing that let five other mechanisms
   * decide a wall's colour without anybody seeing it (RFC 015 §2.8). The
   * household row has no theme now; a wall names its own, and the `CHECK` on
   * `screens` is what makes `input.screen.theme` a string rather than a
   * hope. A document built for *no* wall at all — the stand-in a wall gets
   * when its database could not be read, the admin's previews — wears
   * `STAND_IN_THEME`, which is not a default: nobody inherits it.
   */
  const pick = (screenValue: string | null | undefined): string | null =>
    screenValue === undefined || screenValue === null || screenValue === '' ? null : screenValue;

  // Refused rather than clamped, and resolved once — see the spread below.
  const gutterStep = canvasGutterStep(input.screen?.layoutGutter);

  const activeTheme = pick(input.screen?.theme) ?? STAND_IN_THEME;
  const daytimeTheme = pick(input.screen?.daytimeTheme);
  const daytimeStartsAt = pick(input.screen?.daytimeStartsAt);
  const daytimeEndsAt = pick(input.screen?.daytimeEndsAt);

  // Resolve the active (and any daytime) theme to what the display needs: a
  // built-in yields just its shape, a custom theme its token set too. Falls back
  // to bare keys when no resolver was injected.
  const active = input.resolveTheme?.(activeTheme) ?? { shape: activeTheme };
  const day = daytimeTheme !== null ? input.resolveTheme?.(daytimeTheme) : undefined;
  /*
   * What the style lanes are resolved against (RFC 014 §4.1): a custom
   * theme's own tokens, or the built-in's transcription — and the wall's
   * default lane, read off the row the way the gutter step is and refused
   * rather than repaired when it is not one.
   */
  const canvasStyle = storedStyleLayer(input.screen?.layoutStyle);
  const styling: StyleContext = {
    active: active.tokens ?? builtinThemeTokens(activeTheme),
    ...(daytimeTheme === null
      ? {}
      : { daytime: day?.tokens ?? builtinThemeTokens(daytimeTheme) }),
    ...(canvasStyle === undefined ? {} : { canvas: canvasStyle }),
  };
  const canvasStyleTokens = resolveStyleTokens(styling.active, [], canvasStyle);
  const wallCss = pick(input.screen?.customCss) ?? undefined;
  const canvasDaytimeStyleTokens =
    styling.daytime === undefined ? undefined : resolveStyleTokens(styling.daytime, [], canvasStyle);

  const theme = {
    active: activeTheme,
    activeShape: active.shape,
    ...(active.tokens !== undefined ? { activeTokens: active.tokens } : {}),
    ...(daytimeTheme !== null ? { daytime: daytimeTheme } : {}),
    ...(day?.shape !== undefined ? { daytimeShape: day.shape } : {}),
    ...(day?.tokens !== undefined ? { daytimeTokens: day.tokens } : {}),
    ...(daytimeStartsAt !== null ? { daytimeStartsAt } : {}),
    ...(daytimeEndsAt !== null ? { daytimeEndsAt } : {}),
  };

  return {
    manifestVersion: MANIFEST_VERSION,
    appVersion: input.appVersion,
    generatedAt: input.now,
    // A holiday home on another clock is a real case, and the whole grid is
    // anchored on this.
    timezone: pick(input.screen?.timezone) ?? input.household.timezone,
    theme,
    window: { from, to },
    /*
     * Clamped on the way out, not trusted from the row.
     *
     * These reach the database through a form, and a display asked for two
     * hundred weeks of horizon would render nothing usable. The bounds are the
     * range the layout is known to hold, so a bad value degrades to the
     * nearest sane one rather than to a broken wall.
     */
    screen: {
      orientation:
        input.screen?.orientation === 'portrait' || input.screen?.orientation === 'landscape'
          ? input.screen.orientation
          : 'auto',
      // Quarter turns only, and normalised here so a hand-edited row cannot
      // hand the display something it has to defend against.
      rotation: ((Math.round((input.screen?.rotation ?? 0) / 90) % 4) + 4) % 4 * 90,
      allowDismiss: input.screen?.allowDismiss === true,
      allowChores: input.screen?.allowChores === true,
      // Spread, never emitted as `false` — see the field's own note.
      ...(input.screen?.allowTodo === true ? { allowTodo: true } : {}),
      /*
       * Spread rather than emitted as nulls, and refused rather than clamped.
       *
       * Spread because absence has to be *identical* to how this document
       * looked before the field existed — `manifestEtag` hashes the
       * serialisation, so a `"panelWidthMm": null` on every wall in the world
       * would churn every stored ETag at one image pull for a household who
       * never opened the setting.
       *
       * Refused because the two answers are not equally cheap. A wall with no
       * measurement draws exactly what it drew yesterday; a wall carrying a
       * hand-edited 999999 draws type sized for a stadium. Clamping a value
       * that cannot be a wall to the nearest one that could be is a confident
       * wrong answer where dropping it is the household's own last-known-good.
       */
      ...(physicalWall(
        input.screen?.panelWidthMm,
        input.screen?.panelHeightMm,
        input.screen?.readDistanceMm,
      ) ?? {}),
      /*
       * Spread and refused on the same argument as the three above it, one
       * setting along: absent has to be *identical* to the document this was
       * before the column existed, and a step outside the ladder draws the
       * spacing the household had yesterday rather than a confident guess at
       * which end of it they meant.
       */
      ...(gutterStep === undefined ? {} : { layoutGutter: gutterStep }),
      // The wall's default lane, on the same argument again (RFC 014 §4.1).
      ...(canvasStyleTokens === undefined ? {} : { layoutStyleTokens: canvasStyleTokens }),
      ...(canvasDaytimeStyleTokens === undefined
        ? {}
        : { layoutDaytimeStyleTokens: canvasDaytimeStyleTokens }),
      // The wall's own CSS (RFC 014 §7), on the same argument once more: the
      // scoped text as stored, and nothing at all until a household wrote one.
      ...(wallCss === undefined ? {} : { customCss: wallCss }),
    },
    display: {
      todayEvents: clamp(input.household.displayTodayEvents, 1, 20, 8),
      nextDays: clamp(input.household.displayNextDays, 0, 14, 6),
      horizonWeeks: clamp(input.household.displayHorizonWeeks, 1, 8, 5),
      blocks: parseBlocks(input.household.displayBlocks),
      // 24-hour unless the household explicitly turned it off (RFC 005).
      clock24: input.household.clock24 !== 0,
      // Monday only when the household picked it; Sunday for every other value,
      // including a database from before the column existed.
      weekStart: input.household.weekStart === 'monday' ? 'monday' : 'sunday',
    },
    layout: buildLayout(
      input.household,
      input.layoutWidgetsPortrait ?? [],
      input.layoutWidgetsLandscape ?? [],
      input.readyModules ?? [],
      input.watchedTodoLists ?? [],
      styling,
      input.layoutSlots ?? [],
      input.layoutSchedule ?? [],
    ),
    days,
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      color: person.color,
      hasShiftRotation: person.hasShiftRotation === 1,
      avatarUrl: avatarUrl(person.avatarPath),
    })),
    sources: input.sources.map((source) => ({
      id: source.id,
      name: source.name,
      color: source.color,
      lastSuccessAt: source.lastSuccessAt,
      lastError: source.lastError,
      consecutiveFailures: source.consecutiveFailures,
      eventCount: source.eventCount,
    })),
    notices: [...(input.notices ?? []), ...healthNotices(input.sources, input.now)],
    panels: input.panels ?? {},
    interrupts: input.interrupts ?? [],
  };
}

/**
 * An ETag over the parts of the manifest that affect what is drawn.
 *
 * `generatedAt` is deliberately excluded: it changes every poll, and including
 * it would mean every request transferred the whole document even when nothing
 * had changed. The display gets fresh server time from the response headers
 * regardless, so clock sync does not depend on the body being sent.
 */
export function manifestEtag(manifest: Manifest): string {
  const { generatedAt: _ignored, ...stable } = manifest;
  return `"${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex').slice(0, 32)}"`;
}
