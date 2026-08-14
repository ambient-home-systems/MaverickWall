import { createHash } from 'node:crypto';

import {
  addDays,
  eachDate,
  matchShiftTitle,
  resolveShifts,
  type CivilDate,
  type ResolvedShift,
  type ShiftOverride,
  type ShiftPlan,
  type ShiftType,
  type Interrupt,
} from '@maverick-wall/core';

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
  'countdown',
  'image',
  // A panel from a registered third-party module (docs/rfc-001-module-framework.md).
  // Still first-party by the rule that matters: the wall draws sanitised strings
  // through renderGenericPanel, never anything the module ships.
  'external',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

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

/** Clamp and type-check one canvas's stored rows into the shape the wall draws. */
function placeCanvas(
  widgets: readonly PlacedWidgetRow[],
): Manifest['layout']['portrait']['widgets'] {
  return widgets
    .filter((widget) => (WIDGET_TYPES as readonly string[]).includes(widget.type))
    .map((widget) => ({
      id: widget.id,
      type: widget.type,
      x: unit(widget.x, 0),
      y: unit(widget.y, 0),
      // A zero-size widget is invisible; fall back to a readable default.
      w: unit(widget.w, 0.25) || 0.25,
      h: unit(widget.h, 0.15) || 0.15,
      z: Number.isFinite(widget.z) ? Math.trunc(widget.z) : 0,
      config: widget.config,
    }))
    .sort((a, b) => a.z - b.z);
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
 */
export function buildLayout(
  household: HouseholdRow,
  portraitWidgets: readonly PlacedWidgetRow[],
  landscapeWidgets: readonly PlacedWidgetRow[],
): Manifest['layout'] {
  const portrait = placeCanvas(portraitWidgets);
  const landscape = placeCanvas(landscapeWidgets);

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
      readonly widgets: readonly PlacedWidgetRow[];
      readonly background?: CanvasBackground;
    };
    readonly landscape: {
      readonly aspect: number;
      readonly widgets: readonly PlacedWidgetRow[];
      readonly background?: CanvasBackground;
    };
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
  readonly theme: string;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  readonly shiftEnabled: number;
  readonly displayTodayEvents: number;
  readonly displayNextDays: number;
  readonly displayHorizonWeeks: number;
  readonly displayBlocks: string;
  /** 1 for a 24-hour wall clock (the default), 0 for 12-hour (RFC 005). */
  readonly clock24: number;
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
    readonly theme?: string | null;
    readonly timezone?: string | null;
    readonly daytimeTheme?: string | null;
    readonly daytimeStartsAt?: string | null;
    readonly daytimeEndsAt?: string | null;
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

export function buildManifest(input: BuildManifestInput): Manifest {
  const from = addDays(input.today, -input.daysBefore);
  const to = addDays(input.today, input.daysAfter);
  const dates = eachDate(from, to);

  const visible = new Set(
    input.sources.filter((source) => source.visible === 1).map((source) => source.id),
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

      for (const resolved of resolveShifts({
        from,
        to,
        plans,
        overrides,
        shiftTypes: input.shiftTypes,
        titlesByDate,
      })) {
        const shift = shiftFor(resolved, input.shiftTypes);
        if (!shift) continue;
        const bucket = shiftsByDate.get(resolved.date) ?? [];
        bucket.push({
          ...shift,
          personId: person.id,
          personName: person.name,
          personColor: person.color,
          personAvatarUrl: avatarUrl(person.avatarPath),
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
        ...(ownerOf.get(row.sourceId) != null ? { personId: ownerOf.get(row.sourceId)! } : {}),
      });
      byDate.set(date, bucket);
    }
  }

  const days: ManifestDay[] = dates.map((date) => {
    const events = (byDate.get(date) ?? []).sort((a, b) => {
      // All-day first, then by start. A day's banner belongs above its agenda.
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
      return a.title.localeCompare(b.title);
    });
    return { date, shifts: shiftsByDate.get(date) ?? [], events };
  });

  /*
   * The screen's own look, falling back to the household's.
   *
   * Resolved here rather than on the display, because the display should not
   * have to know there are two places a theme can come from — and because a
   * screen that overrides the theme but not the schedule wants the household's
   * schedule applied to its own themes, which is fiddly to express twice.
   */
  const pick = (screenValue: string | null | undefined, householdValue: string | null): string | null =>
    screenValue === undefined || screenValue === null || screenValue === '' ? householdValue : screenValue;

  const activeTheme = pick(input.screen?.theme, input.household.theme) ?? input.household.theme;
  const daytimeTheme = pick(input.screen?.daytimeTheme, input.household.daytimeTheme);
  const daytimeStartsAt = pick(input.screen?.daytimeStartsAt, input.household.daytimeStartsAt);
  const daytimeEndsAt = pick(input.screen?.daytimeEndsAt, input.household.daytimeEndsAt);

  // Resolve the active (and any daytime) theme to what the display needs: a
  // built-in yields just its shape, a custom theme its token set too. Falls back
  // to bare keys when no resolver was injected.
  const active = input.resolveTheme?.(activeTheme) ?? { shape: activeTheme };
  const day = daytimeTheme !== null ? input.resolveTheme?.(daytimeTheme) : undefined;
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
    timezone: pick(input.screen?.timezone, input.household.timezone) ?? input.household.timezone,
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
    },
    display: {
      todayEvents: clamp(input.household.displayTodayEvents, 1, 20, 8),
      nextDays: clamp(input.household.displayNextDays, 0, 14, 6),
      horizonWeeks: clamp(input.household.displayHorizonWeeks, 1, 8, 5),
      blocks: parseBlocks(input.household.displayBlocks),
      // 24-hour unless the household explicitly turned it off (RFC 005).
      clock24: input.household.clock24 !== 0,
    },
    layout: buildLayout(
      input.household,
      input.layoutWidgetsPortrait ?? [],
      input.layoutWidgetsLandscape ?? [],
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
