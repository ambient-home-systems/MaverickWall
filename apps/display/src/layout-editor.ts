/**
 * The free-form layout editor — the admin's one client-side app.
 *
 * Vanilla TS, no framework, ES2019, same-origin: it ships in the image and
 * loads only on the admin Layout page, never on a wall. The server rendered the
 * shell and the current layout as JSON; this makes it a canvas you drag on and
 * a Save that posts the result back.
 *
 * The preview is the wall. Rather than draw a mock, it renders the household's
 * real manifest through the same `renderFreeform` a screen uses, inside a shadow
 * root that carries the display's own stylesheet — so the CSS never touches the
 * admin page, and what you arrange is exactly what the wall will draw. The
 * draggable boxes are a transparent overlay on top of that live preview.
 *
 * Coordinates are fractions of the canvas throughout, the same as the manifest,
 * so what is dragged here is what the wall draws.
 */

import { renderFreeform } from './render.js';
import { buildModel, type DisplayModel } from './viewmodel.js';
import { applyTheme, themeTokens } from './theme.js';
import {
  resolveStyleTokens,
  setStyleValue,
  styleLayerOf,
  STYLE_INSET_MAX,
  STYLE_LANE_TOKENS,
  STYLE_TRACKINGS,
  STYLE_WEIGHTS,
  type StyleLayer,
} from './widget-style.js';
import { renderContrast } from './contrast-guidance.js';
import { PREVIEW_ROOT_CLASS, layoutPreviewRoot, previewStylesheet } from './preview-css.js';
import { createCustomCssSheet, customCssBlocks, type CustomCssSheet } from './custom-css.js';
import type { Manifest } from './manifest.js';
import {
  CALENDAR_DENSITIES,
  WIDGET_VIEWS,
  calendarView,
  type CalendarDensity,
  type CalendarView,
} from './widget-views.js';
import { clearLaneKeys, inkOf, mergeInk, setLaneValue } from './ink.js';
import { clockVariant } from './clock-face.js';
import { createHistory, type History } from './history.js';
import {
  SNAP,
  inParent,
  moveTo,
  nextZ,
  nudge,
  resolveDrag,
  setDimension,
  type Box,
} from './placement.js';
import {
  canGroup,
  canUngroup,
  canvasBoxOf,
  cellIndexAt,
  groupWidgets,
  moveChildTo,
  ungroupWidget,
} from './grouping.js';
import { MARQUEE_MIN, enclosedBy, marqueeBetween, toggleSelected } from './selection.js';
import { GROUP_LAYOUTS, groupChildren, groupIsOrdered, parentIdOf, topLevelWidgets } from './group-cells.js';
import { markTabs, wireTabs } from './tabs.js';
import {
  canvasKey,
  canvasSnapshot,
  isCanvasDirty,
  parseCanvasKey,
  postedBackground,
  widgetsForSave,
  type CanvasBackground,
  type EditorWidget,
} from './canvas-state.js';
import {
  boxAriaLabel,
  drawnWidgets as drawnOf,
  fallbackOf,
  notDrawnFor,
  todoListOf,
  omissionFlag,
  omissionOf as omissionOfBox,
  type Fallback,
  type Omission,
  type Surface,
  type NotDrawn,
  type OmissionFacts,
} from './omission.js';
import { inspectorView } from './inspector.js';
import { TIER_NAMES, type TierName } from './tiers.js';
import { PALETTE, SWATCH, describeWidget, describeWidgetIn, labelFor } from './widget-labels.js';
import {
  HOUSE_FIELDS,
  SHIFT_FIELDS,
  WEATHER_FIELDS,
  houseLadder,
  shiftLadder,
  weatherLadder,
} from './ladder.js';

/*
 * The widget, the background and the canvas as one shape, defined in
 * `canvas-state.ts` — which is also where they are serialised for the save and
 * for the string dirtiness is measured against. One definition, because two
 * readings of one stored value is the shape of half the faults in this
 * project's own list.
 */
type Widget = EditorWidget;
type Background = CanvasBackground;

interface Canvas {
  aspect: number;
  widgets: Widget[];
  background?: Background | undefined;
}

interface LayoutState {
  /** The wall this canvas is for: a screen id, or null for the shared default. */
  screen: string | null;
  mode: 'auto' | 'freeform';
  /** Which of the two canvases is being edited (RFC 005). */
  orientation: 'portrait' | 'landscape';
  /**
   * Which named canvas is being edited (RFC 014 §5.2); null is the default,
   * the one the wall draws outside every schedule window.
   */
  slot: string | null;
  // The active canvas is held flat as `aspect`/`widgets` so the whole editor
  // reads and mutates it directly; every other canvas — the other orientation,
  // and each named slot on both orientations — waits in `stash`, keyed by
  // `canvasKey`, and one swaps in on the orientation toggle or the slot tabs.
  // Each is saved under its own orientation and slot.
  aspect: number;
  widgets: Widget[];
  background?: Background | undefined;
  stash: Record<string, Canvas>;
  /** The named canvases this wall holds, in the order the tabs draw them. */
  slots: string[];
  /** How many named canvases a wall may hold — the server's bound, echoed. */
  maxSlots: number;
  /** The calendars that exist, for the Calendar widget's "which calendars". */
  calendars: readonly { readonly id: string; readonly name: string }[];
  /** The Home Assistant reading labels resolving now, for the HA widget picker. */
  readings: readonly string[];
  /** The registered modules, for the External widget's "which module". */
  modules: readonly { readonly id: string; readonly name: string }[];
  /** The household, for the Shift and Chores widgets' "whose" pickers. */
  people: readonly { readonly id: string; readonly name: string }[];
  /**
   * The watched Home Assistant to-do lists, for the To-do widget's picker
   * (RFC 012). `id` is what the widget stores; `key` is what the manifest turns
   * it into, so the preview can find the list the box names.
   */
  todoLists: readonly { readonly id: string; readonly name: string; readonly key: string }[];
}

/** The editor is on the admin page, so its preview reads media behind the session. */
const EDITOR_MEDIA_BASE = 'admin/media/';

/**
 * The editor lives on the admin page beside a settings form and one sticky save
 * bar. It publishes this on `window` so that page chrome (`display-editor.js`)
 * can drive a single save — the bar saves the layout through here, then submits
 * the settings form — and can reflect the editor's dirty state in the bar.
 */
interface EditorBridge {
  saveCurrent(): Promise<{ ok: boolean; message?: string }>;
  isDirty(): boolean;
}
type EditorWindow = typeof window & {
  mwEditor?: EditorBridge;
  mwEditorState?: (state: { dirty: boolean }) => void;
};

const ASPECTS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 0.5625, label: 'Portrait 9:16' },
  { value: 0.75, label: 'Portrait 3:4' },
  { value: 1, label: 'Square 1:1' },
  { value: 1.3333, label: 'Landscape 4:3' },
  { value: 1.7778, label: 'Landscape 16:9' },
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * What the canvas must leave clear above an open widget sheet: the sticky app
 * bar it must not slide under, the save bar the sheet sits on, and a little
 * air. Only the sheet's own height is measured — these three are chrome the
 * canvas never overlaps at any viewport.
 */
const SHEET_CLEARANCE = 96 + 64 + 16;

function randomId(): string {
  // Enough not to collide across a household's handful of widgets. Not a secret.
  return 'w' + Math.random().toString(36).slice(2, 10);
}

/**
 * A slot's name, as the server's `layout-slots.ts` states it. Transcribed
 * rather than imported — this bundle has no bundler and cannot reach the
 * server — and held to it by `layout-slots-parity.test.ts`.
 */
const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

function boot(): void {
  // Confirm any destructive form on the page (the Reset button), whether or not
  // the editor mount is present.
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>('form[data-confirm]'))) {
    form.addEventListener('submit', (event) => {
      const message = form.dataset['confirm'];
      if (message !== undefined && message !== '' && !window.confirm(message)) event.preventDefault();
    });
  }

  const mount = document.getElementById('layout-editor');
  if (mount === null) return;

  interface RawCanvas {
    readonly aspect?: unknown;
    readonly widgets?: unknown;
    readonly background?: unknown;
  }
  const bgFrom = (raw: unknown): Background | undefined => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const b = raw as Record<string, unknown>;
    if (b['type'] === 'solid' && typeof b['color'] === 'string') return { type: 'solid', color: b['color'] };
    if (b['type'] === 'gradient' && typeof b['from'] === 'string' && typeof b['to'] === 'string') {
      return { type: 'gradient', from: b['from'], to: b['to'], angle: typeof b['angle'] === 'number' ? b['angle'] : 180 };
    }
    if (b['type'] === 'image' && typeof b['image'] === 'string') return { type: 'image', image: b['image'] };
    return undefined;
  };
  const canvasFrom = (raw: RawCanvas | undefined, fallbackAspect: number): Canvas => {
    const bg = bgFrom(raw?.background);
    return {
      aspect: typeof raw?.aspect === 'number' && raw.aspect > 0 ? raw.aspect : fallbackAspect,
      widgets: Array.isArray(raw?.widgets) ? (raw.widgets as Widget[]) : [],
      ...(bg !== undefined ? { background: bg } : {}),
    };
  };

  // The viewport this wall last reported, for the "match this wall" button.
  // Editor-only, so it lives beside the state rather than in it.
  let report: { readonly w: number; readonly h: number } | undefined;

  // Whether the host page is an e-paper panel's designer. On a panel the words
  // change (reset means "back to the built-in layout"), the preview behind the
  // boxes is the panel's own 1-bit frame, and the canvas is the hardware's —
  // one orientation, one ratio, neither of them the household's to choose.
  let epaperHost = false;
  // The orientation the host draws, when it has only one. A panel is screwed to
  // a wall the way it is screwed to a wall.
  let hostOrientation: 'portrait' | 'landscape' | undefined;
  // The panel's pixels, for the toolbar's static geometry chip.
  let panelSize: { readonly w: number; readonly h: number } | undefined;

  /**
   * The ink lane (RFC 005, direction B), when a panel is looking at this canvas.
   *
   * The server sends this block only when an e-paper panel actually follows the
   * canvas being edited, so its presence *is* the gate: no panel, no lane, and
   * not one control anywhere that would do nothing. `lane` names which of a
   * widget's two sets of options is being edited — the wall's, or what it says
   * differently in black and white.
   */
  interface InkPanel {
    readonly id: string;
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly orientation: string;
  }
  interface InkTables {
    readonly panels: readonly InkPanel[];
    /** Which keys the lane offers, per widget type. */
    readonly lane: Readonly<Record<string, readonly string[]>>;
    /** Wall settings a panel cannot draw, each with the reason. */
    readonly ignores: readonly { readonly key: string; readonly label: string; readonly why: string }[];
  }
  let ink: InkTables | undefined;
  let lane: 'wall' | 'ink' = 'wall';
  /**
   * The bundled faces a style lane may name (RFC 014 §4.1), as the server
   * lists them — label and the exact stack the schema will accept. Served in
   * the bootstrap JSON rather than transcribed, because the allowlist is the
   * server's and a face this editor offered that the schema refused would be
   * a control that does nothing.
   */
  let fonts: readonly { readonly label: string; readonly stack: string }[] = [];
  /**
   * Which widgets have "Inherit the wall's theme" switched off *this session*
   * without having written anything yet.
   *
   * The inherited-number pattern seeds a revealed field with the value it was
   * following, because an empty override is inheritance and the switch would
   * spring back on. Seeding a whole lane the same way would write eleven
   * colours into every widget a household merely looked at — and freeze them
   * there, so the daylight theme never reached that widget again. So the
   * switch off writes nothing until a control is touched; the stored truth is
   * what the switch reads on reload, and that is the honest answer.
   */
  const styleLaneOpen = new Set<string>();
  /**
   * Widget id → why the wall leaves it out. Empty when everything is set up.
   *
   * The server's answer at page load. Once `omission` facts arrive beside it
   * the map is re-derived from them on every read (`notDrawn()` below), so a
   * household picking a list in the inspector sees the flag change without a
   * reload; this seed is what an older server's page falls back to.
   */
  const notDrawnSeed = new Map<string, string>();
  let omissionFacts: OmissionFacts | undefined;

  let state: LayoutState;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as {
      readonly screen?: unknown;
      readonly kind?: unknown;
      readonly mode?: unknown;
      readonly portrait?: RawCanvas;
      readonly landscape?: RawCanvas;
      readonly slots?: unknown;
      readonly maxSlots?: unknown;
      readonly calendars?: unknown;
      readonly readings?: unknown;
      readonly modules?: unknown;
      readonly people?: unknown;
      readonly report?: { readonly w?: unknown; readonly h?: unknown };
      readonly orientation?: unknown;
      readonly panel?: { readonly width?: unknown; readonly height?: unknown };
      readonly ink?: unknown;
      readonly notDrawn?: unknown;
      readonly omission?: unknown;
      readonly todoLists?: unknown;
      readonly fonts?: unknown;
    };
    const r = parsed.report;
    if (r !== undefined && typeof r.w === 'number' && typeof r.h === 'number' && r.w > 0 && r.h > 0) {
      report = { w: r.w, h: r.h };
    }
    epaperHost = parsed.kind === 'epaper';
    if (parsed.orientation === 'landscape' || parsed.orientation === 'portrait') {
      hostOrientation = parsed.orientation;
    }
    const pnl = parsed.panel;
    if (pnl !== undefined && typeof pnl.width === 'number' && typeof pnl.height === 'number') {
      panelSize = { w: pnl.width, h: pnl.height };
    }
    /*
     * Which widget types the wall will leave out, and why (RFC 009 Phase 2).
     *
     * The manifest omits a widget the household has nothing set up for. The
     * editor cannot: a box you cannot see is a box you cannot move, and the
     * preview here is the one place a household can find out *why* something is
     * missing from their wall. So the box stays and carries the reason.
     *
     * The server decides — the same `widgetIsSetUp` the manifest uses — because
     * a second opinion here is how the wall and the screen that describes it
     * come to disagree.
     */
    const rawNotDrawn = parsed.notDrawn;
    if (Array.isArray(rawNotDrawn)) {
      for (const entry of rawNotDrawn) {
        const row = entry as { id?: unknown; why?: unknown };
        if (typeof row.id === 'string' && typeof row.why === 'string') {
          notDrawnSeed.set(row.id, row.why);
        }
      }
    }
    /*
     * And the facts the server decided from (RFC 012 §6.2), so the editor can
     * decide the same way as the household edits: a to-do box's flag follows
     * the list it names. Read defensively and dropped whole on anything
     * unexpected — a predicate fed half a table would flag the wrong boxes,
     * which is worse than the seed alone.
     */
    const rawFacts = parsed.omission as
      | { drawn?: unknown; todoLists?: unknown; why?: unknown }
      | undefined;
    if (
      rawFacts !== undefined &&
      typeof rawFacts.drawn === 'object' && rawFacts.drawn !== null &&
      Array.isArray(rawFacts.todoLists) &&
      typeof rawFacts.why === 'object' && rawFacts.why !== null
    ) {
      omissionFacts = {
        drawn: rawFacts.drawn as Record<string, boolean>,
        todoLists: rawFacts.todoLists.filter((one): one is string => typeof one === 'string'),
        why: rawFacts.why as Record<string, string>,
      };
    }
    // Read defensively and drop the whole block on anything unexpected: a lane
    // built from half a table would offer controls with no meaning, which is
    // worse than no lane at all.
    const rawInk = parsed.ink as InkTables | undefined;
    if (
      rawInk !== undefined &&
      Array.isArray(rawInk.panels) &&
      rawInk.panels.length > 0 &&
      typeof rawInk.lane === 'object' &&
      rawInk.lane !== null &&
      Array.isArray(rawInk.ignores)
    ) {
      ink = rawInk;
    }
    if (Array.isArray(parsed.fonts)) {
      fonts = parsed.fonts.filter(
        (one): one is { label: string; stack: string } =>
          typeof one === 'object' && one !== null &&
          typeof (one as { label?: unknown }).label === 'string' &&
          typeof (one as { stack?: unknown }).stack === 'string',
      );
    }
    // Start on portrait; landscape waits in the stash (RFC 005). 9:16 and 16:9
    // are the per-orientation defaults when a canvas has no aspect yet.
    const portrait = canvasFrom(parsed.portrait, 0.5625);
    const landscape = canvasFrom(parsed.landscape, 1.7778);
    /*
     * And every named canvas (RFC 014 §5.2), both orientations each, sharing
     * the orientation's aspect and background — a slot is an arrangement and
     * never a shape. Read defensively: a slot whose name is not one is
     * dropped whole rather than offered as a tab that cannot be saved.
     */
    const stash: Record<string, Canvas> = { [canvasKey('landscape', null)]: landscape };
    const slots: string[] = [];
    if (Array.isArray(parsed.slots)) {
      for (const entry of parsed.slots) {
        const named = entry as { slot?: unknown; portrait?: RawCanvas; landscape?: RawCanvas };
        if (typeof named.slot !== 'string' || !SLOT_NAME.test(named.slot) || slots.includes(named.slot)) continue;
        slots.push(named.slot);
        const p = canvasFrom(named.portrait, portrait.aspect);
        const l = canvasFrom(named.landscape, landscape.aspect);
        stash[canvasKey('portrait', named.slot)] = {
          aspect: portrait.aspect, widgets: p.widgets,
          ...(portrait.background !== undefined ? { background: portrait.background } : {}),
        };
        stash[canvasKey('landscape', named.slot)] = {
          aspect: landscape.aspect, widgets: l.widgets,
          ...(landscape.background !== undefined ? { background: landscape.background } : {}),
        };
      }
    }
    state = {
      screen: typeof parsed.screen === 'string' ? parsed.screen : null,
      mode: parsed.mode === 'freeform' ? 'freeform' : 'auto',
      orientation: 'portrait',
      slot: null,
      aspect: portrait.aspect,
      widgets: portrait.widgets,
      ...(portrait.background !== undefined ? { background: portrait.background } : {}),
      stash,
      slots,
      maxSlots: typeof parsed.maxSlots === 'number' && parsed.maxSlots > 0 ? parsed.maxSlots : 4,
      calendars: Array.isArray(parsed.calendars) ? (parsed.calendars as LayoutState['calendars']) : [],
      readings: Array.isArray(parsed.readings) ? (parsed.readings as string[]) : [],
      modules: Array.isArray(parsed.modules) ? (parsed.modules as LayoutState['modules']) : [],
      people: Array.isArray(parsed.people) ? (parsed.people as LayoutState['people']) : [],
      todoLists: Array.isArray(parsed.todoLists)
        ? (parsed.todoLists as unknown[]).filter(
            (one): one is LayoutState['todoLists'][number] =>
              typeof one === 'object' && one !== null &&
              typeof (one as { id?: unknown }).id === 'string' &&
              typeof (one as { name?: unknown }).name === 'string' &&
              typeof (one as { key?: unknown }).key === 'string',
          )
        : [],
    };
  } catch {
    state = {
      screen: null, mode: 'auto', orientation: 'portrait', slot: null, aspect: 0.5625, widgets: [],
      stash: { [canvasKey('landscape', null)]: { aspect: 1.7778, widgets: [] } },
      slots: [], maxSlots: 4,
      calendars: [], readings: [], modules: [], people: [], todoLists: [],
    };
  }

  // The wall being edited, as a query for the per-wall endpoints.
  const screenQuery = state.screen === null ? '' : `?screen=${encodeURIComponent(state.screen)}`;

  /**
   * Which boxes are selected, in the order they were chosen (RFC 014 §5.1).
   *
   * One id was the whole of selection until groups needed two or more. The
   * first entry is the *primary* selection — what the inspector describes
   * when it is alone, and where focus returns when the sheet closes — and
   * `selection.ts` owns the arithmetic (a Shift+click, a marquee).
   */
  let selection: string[] = [];
  const primary = (): string | undefined => selection[0];
  /** What a box is called, on a layout that may hold groups — the one composition. */
  const nameOf = (widget: Widget): string => describeWidgetIn(widget, state.widgets);
  let dirty = false;
  /*
   * The ladder lists currently on screen, so the cut marker can be refreshed
   * after the preview redraws. Rebuilt with the config panel; never more than
   * one, but a list is simpler than a nullable and cannot go stale.
   */
  let ladderPanels: { readonly widget: Widget; readonly list: HTMLElement }[] = [];
  /**
   * The inspector's four numeric box fields, so a drag or an arrow key writes
   * back into them rather than leaving them stale. Rebuilt with the panel;
   * absent whenever the Style tab is not the one showing.
   */
  let boxFields:
    | { readonly id: string; readonly inputs: readonly (readonly ['x' | 'y' | 'w' | 'h', HTMLInputElement])[] }
    | undefined;
  // Whether the anchored Layers / Canvas popovers are open. UI-only; not saved.
  let layersOpen = false;
  let canvasOpen = false;
  // The wall this canvas belongs to, as a URL segment for the per-display admin
  // routes the toolbar links to (the gallery and the reset action).
  const detailSeg = state.screen === null ? 'default' : encodeURIComponent(state.screen);

  /**
   * The one place `dirty` changes, so the host save bar always hears about it.
   * The editor has no save button of its own now — the page's single sticky bar
   * saves the layout (through `mwEditor.saveCurrent`) and the settings together.
   */
  function setDirty(value: boolean): void {
    dirty = value;
    try {
      (window as EditorWindow).mwEditorState?.({ dirty });
    } catch {
      // The bar is a convenience; a missing host must never break the editor.
    }
  }
  /**
   * The canvas as it would be saved, as one string — `canvas-state.ts`, which
   * is also what builds the request body, so the two cannot disagree about a
   * field and report a saved canvas as unsaved.
   */
  const activeSnapshot = (): string => canvasSnapshot(state);

  /**
   * What the server holds for each orientation, and whether the canvas waiting
   * in the stash differs from it.
   *
   * Dirtiness is *per canvas* (RFC 009 Phase 5). It used to be one flag, which
   * is why switching orientation performed a hidden save: with one flag there
   * was nowhere to record that portrait still had unsaved work, so the switch
   * wrote it out — discarded the outcome, and cleared the flag whether or not
   * the write succeeded, reporting a failed save as a success. Nothing is
   * written on a switch now; the save bar saves both.
   */
  const savedSnapshot: Record<string, string> = {};
  /** The key of the canvas being edited — `canvasKey` of the active pair. */
  const activeKey = (): string => canvasKey(state.orientation, state.slot);
  /**
   * Whether any canvas waiting in the stash differs from what the server
   * holds. Derived on every ask rather than remembered on the switch, so a
   * named canvas edited, left and undone back to its saved state reads clean
   * — which is the comparison-not-flag rule (RFC 009 Phase 5) applied to
   * every canvas rather than to the one other canvas there used to be.
   */
  const anyStashDirty = (): boolean =>
    Object.keys(state.stash).some(
      (key) => canvasSnapshot(state.stash[key] as Canvas) !== (savedSnapshot[key] ?? ''),
    );

  /**
   * One undo stack per canvas.
   *
   * Portrait and landscape are two arrangements that share nothing, so a single
   * stack would offer to restore a portrait canvas over a landscape one. The
   * stacks are not saved anywhere: undo is about the session in front of you,
   * and a stack that survived a reload would offer to undo edits the household
   * has already seen written.
   */
  const histories: Record<string, History> = {};
  const history = (): History => {
    const key = activeKey();
    const known = histories[key];
    if (known !== undefined) return known;
    const made = createHistory();
    histories[key] = made;
    return made;
  };

  /*
   * A run of small edits is one intention.
   *
   * Thirty arrow-key nudges are one "move it left a bit", and spending the
   * whole stack on them would put the delete that came before out of reach —
   * so a run of the same edit on the same widget records once. Discrete
   * mutations (add, remove, duplicate, a drag, a switch) always record.
   */
  const RUN_MS = 700;
  let runKey = '';
  let runAt = 0;

  /**
   * One step back for a change that takes more than one write.
   *
   * The ladder is the case: it clears the switches it supersedes and *then*
   * writes the field list, so the snapshot `setConfig` takes has already lost
   * the switches — undoing restored the list and left them deleted. Recording
   * around the pair rather than inside it is the fix, and the suspend is what
   * keeps it one step rather than two.
   */
  let suspendRecording = false;
  function recordOnce(change: () => void): void {
    record();
    suspendRecording = true;
    try {
      change();
    } finally {
      suspendRecording = false;
    }
  }

  /** Remember the canvas as it is now, before mutating it. */
  function record(): void {
    if (suspendRecording) return;
    history().push(activeSnapshot());
    runKey = '';
    refreshUndo();
  }
  function recordRun(key: string): void {
    if (suspendRecording) return;
    const at = Date.now();
    if (key === runKey && at - runAt < RUN_MS) {
      runAt = at;
      return;
    }
    record();
    runKey = key;
    runAt = at;
  }
  /** End an interaction: a drag that put the box back drops its entry. */
  function settle(): void {
    history().settle(activeSnapshot());
    refreshUndo();
  }

  function refreshUndo(): void {
    undoButton.disabled = !history().canUndo();
  }

  /** Step back one remembered canvas. Nothing to undo is a no-op, not an error. */
  function undoLast(): void {
    const snapshot = history().undo();
    if (snapshot === undefined) return;
    restoreCanvas(snapshot);
  }

  /**
   * Put a remembered canvas back.
   *
   * Read as defensively as the boot parse is, for the same reason: this string
   * was written by this bundle, but a shape assumed and not checked is how a
   * poll throws inside a wall. A selection whose widget is no longer there is
   * dropped, so the inspector cannot end up describing a box that has gone.
   */
  function restoreCanvas(snapshot: string): void {
    let parsed: { aspect?: unknown; background?: unknown; widgets?: unknown };
    try {
      parsed = JSON.parse(snapshot) as { aspect?: unknown; background?: unknown; widgets?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.aspect === 'number' && parsed.aspect > 0) state.aspect = parsed.aspect;
    state.widgets = Array.isArray(parsed.widgets) ? (parsed.widgets as Widget[]) : [];
    state.background = bgFrom(parsed.background);
    selection = selection.filter((id) => state.widgets.some((w) => w.id === id));
    runKey = '';
    syncAspectSelect();
    draw();
    markDirty();
  }

  // Snap to the grid while dragging. An editor affordance only — the stored
  // coordinates stay fractional, so snapping changes where a widget lands, never
  // how it is saved. The arithmetic is `placement.ts`.
  let snap = false;

  // The live preview, once it has loaded. Until then the overlay draws with
  // labels, which is a fine fallback and the whole editor if the fetch fails.
  let model: DisplayModel | undefined;
  let manifest: Manifest | undefined;
  let previewShadow: ShadowRoot | undefined;
  /** The household's CSS on the preview's sheet, and each box's block by id (RFC 014 §7). */
  let previewCss: CustomCssSheet | undefined;
  let customCssById = new Map<string, string>();
  // The e-paper designer's backdrop: the panel's own 1-bit frame, fetched from
  // the server for whatever is on the canvas now. Kept as an <img> rather than
  // a second renderer in this bundle — see `renderEpaperPreview`.
  let epaperImage: HTMLImageElement | undefined;
  let epaperObjectUrl: string | undefined;
  let epaperTimer: number | undefined;
  let epaperPending = false;
  let previewWall: HTMLElement | undefined;

  // ---- structure, built once -------------------------------------------

  const stage = document.createElement('div');
  stage.className = 'le-stage';
  const canvas = document.createElement('div');
  canvas.className = 'le-canvas';

  // The live preview sits behind the draggable overlay, and never takes a
  // pointer — every drag is the overlay's.
  const preview = document.createElement('div');
  preview.className = 'le-preview';
  const overlay = document.createElement('div');
  // On a panel the backdrop *is* the artwork, so the boxes stop tinting it —
  // each widget already draws its own border in the frame beneath.
  overlay.className = epaperHost ? 'le-overlay is-epaper' : 'le-overlay';
  canvas.append(preview, overlay);
  stage.appendChild(canvas);

  const hint = document.createElement('p');
  hint.className = 'hint';
  /*
   * What an empty canvas actually means, and it is now the same on both kinds.
   *
   * It has been wrong twice, in opposite directions. The first wording promised
   * the stacked layout, retired with the auto mode in 0.27.0. The second
   * promised a panel would draw its built-in view — true then, and false since
   * an authored-empty canvas became its own frame: `renderScreenFrame` tells
   * `undefined` (no canvas) from `[]` (an empty one), which is what lets a
   * Blank card differ from the Built-in above it. A panel with nothing placed
   * now says the same short note a wall does, so this says so once.
   *
   * Getting back to the built-in view is Reset, not deletion — it clears the
   * canvas rather than emptying it — and the sentence names it, because that
   * is the question somebody looking at an empty editor is about to ask.
   */
  hint.textContent = epaperHost
    ? 'Nothing is placed yet — add a widget above. Until you do, this panel ' +
      'shows a short note in place of a layout. To go back to the view it drew ' +
      'out of the box, use Reset layout.'
    : 'Nothing is placed yet — add a widget above. Until you do, the wall ' +
      'shows a short note in place of a layout rather than going blank.';

  // The canvas background control (RFC 005 Phase 3): none, a solid colour, or a
  // gradient. Per canvas, so it swaps with the orientation like the widgets do.
  const backgroundPanel = document.createElement('div');
  backgroundPanel.className = 'le-bg';

  /**
   * The toolbar: one row (RFC 009 Phase 5).
   *
   * It was four clusters in three visual treatments across two rows — a
   * Portrait/Landscape toggle, a chip, Add widget and Templates on one; Canvas
   * and Layers on another — and two of those items were duplicates of entries
   * in the page's own overflow menu a few pixels above. On a 390px phone the
   * pair cost 124px of an 844px viewport before the canvas began.
   *
   * One row now: which canvas, add a widget, undo, the layers list, and the
   * canvas's own settings behind one button. Templates and Reset are gone from
   * here on a wall because the page's overflow menu already carries both — an
   * e-paper panel's page has no overflow menu, so there they stay.
   */
  const toolbar = document.createElement('div');
  toolbar.className = 'le-toolbar';
  const barMain = document.createElement('div');
  barMain.className = 'le-bar-main';
  toolbar.append(barMain);

  // Portrait | Landscape — which of the display's two canvases is being edited.
  const orientToggle = document.createElement('div');
  orientToggle.className = 'le-orient seg';
  orientToggle.setAttribute('role', 'group');
  orientToggle.setAttribute('aria-label', 'Which layout you are arranging');
  const orientButtons: Record<'portrait' | 'landscape', HTMLButtonElement> = {
    portrait: document.createElement('button'),
    landscape: document.createElement('button'),
  };
  for (const which of ['portrait', 'landscape'] as const) {
    const button = orientButtons[which];
    button.type = 'button';
    button.textContent = which === 'portrait' ? 'Portrait' : 'Landscape';
    button.className = 'le-orient-btn' + (state.orientation === which ? ' is-on' : '');
    // Selected state announced, not drawn only — the tick and the fill are the
    // sighted half of the same fact.
    button.setAttribute('aria-pressed', state.orientation === which ? 'true' : 'false');
    button.addEventListener('click', () => switchCanvas(which, state.slot));
    orientToggle.appendChild(button);
  }

  /*
   * Which of this wall's *named* layouts is being arranged (RFC 014 §5.2).
   *
   * A tablist, wired by `wireTabs` — the roving tabindex the inspector's
   * tabs and the ink lane use, and not a second mechanism — beside the
   * orientation buttons: orientation decides the family of canvases and the
   * slot picks within it, so the two controls sit together and read in that
   * order. "Everyday" is the default canvas, which has no name in the store
   * and no window in the schedule; it is what the wall draws outside every
   * rule. New starts a layout *from what is there now*, which is the whole
   * "start from what you have" affordance: a school-morning wall is the
   * everyday one with a box or two moved, not a blank page. Remove is only
   * offered on a named layout, because the everyday one cannot be removed.
   *
   * Hidden on a panel with the orientation buttons, for the reason the
   * server refuses a slot at one: a battery panel draws one layout. And
   * **hidden on a wall with no named layout**, which is every wall until a
   * household makes one: measured, a second segment beside the orientation
   * buttons wrapped the toolbar onto a third row on a 390px phone and took the
   * canvas from 455px to 388px — under the half-screen floor RFC 009 Phase 5
   * measured it up to. So New and Remove live in the Layout popover, where the
   * canvas's own settings already are, and the tabs cost the toolbar nothing
   * until there is a second layout to choose between.
   */
  const slotBar = document.createElement('div');
  slotBar.className = 'le-slots';
  const slotGroup = document.createElement('div');
  slotGroup.className = 'le-orient seg';
  slotGroup.setAttribute('role', 'tablist');
  slotGroup.setAttribute('aria-label', 'Which of this wall’s layouts you are arranging');
  const slotTabs: HTMLButtonElement[] = [];
  const slotKeyOf = (tab: HTMLButtonElement): string | undefined => tab.dataset['slot'];
  const newSlotButton = document.createElement('button');
  newSlotButton.type = 'button';
  newSlotButton.className = 'le-add';
  newSlotButton.textContent = 'New layout';
  newSlotButton.title = 'Start another layout from this one, to show at certain hours';
  newSlotButton.addEventListener('click', () => newSlotFromCurrent());
  const removeSlotButton = document.createElement('button');
  removeSlotButton.type = 'button';
  removeSlotButton.className = 'le-add';
  removeSlotButton.textContent = 'Remove layout';
  removeSlotButton.addEventListener('click', () => {
    void removeCurrentSlot();
  });
  function drawSlotTabs(): void {
    for (const tab of slotTabs) tab.remove();
    slotTabs.length = 0;
    for (const slot of [null, ...state.slots]) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'le-orient-btn';
      tab.setAttribute('role', 'tab');
      tab.dataset['slot'] = slot ?? '';
      tab.textContent = slot ?? 'Everyday';
      slotTabs.push(tab);
    }
    slotGroup.append(...slotTabs);
    wireTabs(
      slotTabs,
      slotKeyOf,
      (key) => switchCanvas(state.orientation, key === '' ? null : key),
      false,
    );
    markSlotTabs();
  }
  function markSlotTabs(): void {
    markTabs(slotTabs, slotKeyOf, state.slot ?? '', 'is-on');
    slotBar.hidden = epaperHost || state.slots.length === 0;
    removeSlotButton.hidden = state.slot === null;
    newSlotButton.hidden = state.slots.length >= state.maxSlots;
    newSlotButton.title =
      state.slots.length >= state.maxSlots
        ? `A wall can hold ${state.maxSlots} extra layouts`
        : 'Start another layout from this one, to show at certain hours';
  }
  slotBar.append(slotGroup);
  drawSlotTabs();

  // A panel has one orientation and one ratio, both facts about the hardware.
  // Offering the wall's Portrait/Landscape tabs and its aspect list let a
  // household arrange a canvas the device would never draw, on a shape it does
  // not have — so on a panel the two controls become one chip that states what
  // the panel is. The canvases themselves are unchanged underneath: the other
  // orientation is still loaded and still saved, it is simply not on offer.
  const panelChip = document.createElement('span');
  panelChip.className = 'le-panel-chip';
  if (epaperHost) {
    orientToggle.style.display = 'none';
    const size = panelSize === undefined ? '' : `${panelSize.w}×${panelSize.h} · `;
    panelChip.textContent = `${size}${hostOrientation === 'portrait' ? 'portrait' : 'landscape'}`;
  } else {
    panelChip.style.display = 'none';
  }

  const aspectSelect = document.createElement('select');
  aspectSelect.className = 'le-aspect';
  aspectSelect.setAttribute('aria-label', 'Layout size');
  for (const a of ASPECTS) {
    const opt = document.createElement('option');
    opt.value = String(a.value);
    opt.textContent = a.label;
    if (Math.abs(a.value - state.aspect) < 0.01) opt.selected = true;
    aspectSelect.appendChild(opt);
  }

  // "Match this wall" — set the active canvas's aspect to this wall's real
  // reported size, for the orientation being edited. Only a paired wall that
  // has checked in reports one; the shared Default has no single size to match.
  const matchButton = document.createElement('button');
  matchButton.type = 'button';
  matchButton.className = 'le-add';
  if (report !== undefined) {
    const big = Math.max(report.w, report.h);
    const small = Math.min(report.w, report.h);
    matchButton.textContent = `Match this wall (${report.w}×${report.h})`;
    matchButton.addEventListener('click', () => {
      record();
      // Wide for landscape, tall for portrait, from the same reported pixels.
      state.aspect = round3(state.orientation === 'landscape' ? big / small : small / big);
      syncAspectSelect();
      draw();
      markDirty();
    });
  } else {
    matchButton.style.display = 'none';
  }

  /** A switch built the way the admin's own settings rows are, so a persistent
   *  on/off setting looks like one wherever it appears. */
  function switchRow(
    label: string,
    hint: string,
    on: boolean,
    onChange: (v: boolean) => void,
    key?: string,
  ): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    if (key !== undefined) wrap.dataset['cfgKey'] = key;
    const text = document.createElement('span');
    text.className = 'switch-text';
    const strong = document.createElement('b');
    strong.textContent = label;
    text.appendChild(strong);
    if (hint !== '') {
      const small = document.createElement('small');
      small.textContent = hint;
      text.appendChild(small);
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(text, input);
    return wrap;
  }

  const snapToggle = switchRow('Snap to grid', '', snap, (on) => {
    snap = on;
    // The grid is drawn on the overlay only while snapping, as a placement aid;
    // it is not part of the wall. Sizes are a percentage of the canvas, so the
    // lines fall exactly on the snap steps at any canvas size.
    overlay.classList.toggle('is-snapping', snap);
    overlay.style.backgroundSize = snap ? `${SNAP * 100}% ${SNAP * 100}%` : '';
  });

  // One "+ Add widget" button in the toolbar opens a modal grid of the widget
  // types, rather than a row of chips — closer to the reference, and it keeps the
  // toolbar uncluttered as the palette grows. The grid is first-party only
  // (rule three): no website, video or embed widget can be placed.
  const palette = document.createElement('div');
  palette.className = 'le-palette';
  const addWidgetButton = document.createElement('button');
  addWidgetButton.type = 'button';
  addWidgetButton.className = 'le-add le-add-primary';
  addWidgetButton.textContent = '+ Add widget';
  addWidgetButton.setAttribute('aria-haspopup', 'dialog');
  palette.appendChild(addWidgetButton);

  const modal = document.createElement('div');
  modal.className = 'le-modal';
  modal.hidden = true;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Add a widget');
  const openAddModal = (): void => {
    modal.hidden = false;
    modalGrid.querySelector('button')?.focus();
  };
  const closeAddModal = (): void => {
    modal.hidden = true;
    addWidgetButton.focus();
  };
  const modalCard = document.createElement('div');
  modalCard.className = 'le-modal-card';
  const modalHead = document.createElement('div');
  modalHead.className = 'le-modal-head';
  const modalTitle = document.createElement('span');
  modalTitle.textContent = 'Add a widget';
  const modalClose = document.createElement('button');
  modalClose.type = 'button';
  modalClose.className = 'le-modal-close';
  modalClose.setAttribute('aria-label', 'Close');
  modalClose.textContent = '×';
  modalClose.addEventListener('click', closeAddModal);
  modalHead.append(modalTitle, modalClose);
  const modalGrid = document.createElement('div');
  modalGrid.className = 'le-modal-grid';
  for (const item of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'le-modal-item';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      modal.hidden = true;
      addWidget(item.type);
    });
    modalGrid.appendChild(button);
  }
  modalCard.append(modalHead, modalGrid);
  modal.appendChild(modalCard);
  addWidgetButton.addEventListener('click', openAddModal);
  // A click on the backdrop (not the card) closes; Escape closes.
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeAddModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeAddModal();
  });

  /**
   * Undo, in the toolbar and on Ctrl/Cmd+Z (RFC 009 Phase 5).
   *
   * Before this the only way back from a mistake was Discard changes, which is
   * `location.reload()` — so an accidental drag after twenty minutes of
   * arranging cost the twenty minutes. It is also what lets Remove stop asking:
   * a confirmation whose reassurance was "Discard changes brings it back" was
   * offering exactly that trade.
   */
  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'le-tool-btn';
  undoButton.textContent = 'Undo';
  undoButton.title = 'Undo the last change (Ctrl+Z)';
  undoButton.disabled = true;
  undoButton.addEventListener('click', () => undoLast());
  /*
   * The keyboard shortcut everybody tries first.
   *
   * Not inside a *text* box: a field somebody is typing in has its own undo and
   * the browser's is the right one there — taking a keystroke out of a title
   * being typed to move a box somewhere else is a worse editor than no shortcut
   * at all. A checkbox, a colour or a range is not a text box and has no undo of
   * its own, so a household who has just ticked something and pressed Ctrl+Z
   * with the focus still on it gets what they asked for. Shift+Ctrl+Z is redo on
   * most platforms and there is no redo here, so it is left alone rather than
   * quietly doing a second undo.
   */
  const TEXT_ENTRY = ['text', 'number', 'search', 'url', 'tel', 'email', 'password'];
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'z') return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    /*
     * Only while the canvas is on screen.
     *
     * The wall's page has two panes and the settings one hides this editor
     * entirely — Ctrl+Z there would silently step back a layout edit nobody can
     * see, which the next Save would then write. `offsetParent` is null for a
     * hidden pane, and this mount is never positioned, so it is the whole check.
     */
    if (mount.offsetParent === null) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable === true) return;
    if (target?.tagName === 'TEXTAREA') return;
    // An <input> with no type at all is a text field, so an unknown type is
    // treated as one: the safe direction is leaving a keystroke alone.
    if (target?.tagName === 'INPUT') {
      const kind = (target as HTMLInputElement).type;
      if (kind === '' || TEXT_ENTRY.includes(kind)) return;
    }
    if (!history().canUndo()) return;
    event.preventDefault();
    undoLast();
  });

  /**
   * Group and Ungroup (RFC 014 §5.1), at the end of the row. Each is one
   * undo step however many boxes it moves, and that is the property a
   * household relies on when they press one to see what it does.
   *
   * Group appears with two or more boxes selected, Ungroup with one group
   * selected, and neither otherwise: a control that would only ever answer
   * with a 400 is the `options.json` fault in a button. The arithmetic is
   * `grouping.ts`; what is decided here is only when each is offered.
   */
  const groupButton = document.createElement('button');
  groupButton.type = 'button';
  groupButton.className = 'le-tool-btn le-group-btn';
  groupButton.textContent = 'Group';
  groupButton.title = 'Put the selected widgets in one group you can move as one';
  groupButton.hidden = true;
  groupButton.addEventListener('click', () => groupSelected());
  const ungroupButton = document.createElement('button');
  ungroupButton.type = 'button';
  ungroupButton.className = 'le-tool-btn le-ungroup-btn';
  ungroupButton.textContent = 'Ungroup';
  ungroupButton.title = 'Take the group apart, putting its widgets back where they were';
  ungroupButton.hidden = true;
  ungroupButton.addEventListener('click', () => ungroupSelected());
  function refreshGroupButtons(): void {
    groupButton.hidden = !canGroup(state.widgets, selection);
    ungroupButton.hidden = !canUngroup(state.widgets, selection);
  }

  // Templates sits beside Add widget as its quieter neighbour: both start a
  // layout, one widget at a time or all at once.
  const templateLink = document.createElement('a');
  templateLink.className = 'le-add';
  templateLink.href = `admin/displays/${detailSeg}/gallery`;
  templateLink.textContent = 'Templates';

  const resetForm = document.createElement('form');
  resetForm.className = 'le-reset-form';
  resetForm.method = 'post';
  resetForm.action = `admin/displays/${detailSeg}/reset-layout`;
  resetForm.addEventListener('submit', (event) => {
    // Says which layouts go, because a wall has two of them and only one is on
    // screen — "Reset" on its own never said what it would take.
    const question = epaperHost
      ? 'Reset this panel to its built-in layout? Your current arrangement is removed.'
      : 'Reset both the portrait and landscape layouts of this wall to the Classic ' +
        'layout? Everything arranged here is replaced.';
    if (!window.confirm(question)) {
      event.preventDefault();
    }
  });
  const resetButton = document.createElement('button');
  resetButton.type = 'submit';
  resetButton.className = 'le-tool-btn';
  resetButton.textContent = 'Reset layout…';
  resetForm.appendChild(resetButton);

  /**
   * Canvas settings: the shape being arranged, whether dragging snaps, and what
   * is behind the widgets — plus the reset, which is a fact about this canvas
   * and is destructive, so it is the last thing in a panel you had to open.
   */
  const canvasButton = document.createElement('button');
  canvasButton.type = 'button';
  canvasButton.className = 'le-tool-btn';
  canvasButton.setAttribute('aria-haspopup', 'true');
  canvasButton.setAttribute('aria-expanded', 'false');
  canvasButton.appendChild(document.createTextNode('Layout'));
  // The shape, as its own node rather than part of the label: on a phone the
  // row has to fit and the popover states it anyway, so the stylesheet hides
  // this and the button keeps its name.
  const canvasNote = document.createElement('span');
  canvasNote.className = 'le-tool-note';
  canvasButton.appendChild(canvasNote);

  const canvasPopover = document.createElement('div');
  canvasPopover.className = 'le-canvas-pop';
  canvasPopover.hidden = true;
  {
    const title = document.createElement('div');
    title.className = 'le-pop-title';
    title.textContent = 'Layout';
    const sub = document.createElement('div');
    sub.className = 'le-pop-sub';
    sub.textContent = epaperHost
      ? 'The panel’s own shape. It is fixed by the hardware.'
      : 'The shape you are arranging. The wall fits it to the device it is on.';
    canvasPopover.append(title, sub);
    if (!epaperHost) {
      const sizeRow = document.createElement('div');
      sizeRow.className = 'le-pop-row';
      const sizeLabel = document.createElement('span');
      sizeLabel.textContent = 'Layout size';
      sizeRow.append(sizeLabel, aspectSelect);
      canvasPopover.appendChild(sizeRow);
      if (report !== undefined) {
        const matchRow = document.createElement('div');
        matchRow.className = 'le-pop-row';
        matchRow.appendChild(matchButton);
        canvasPopover.appendChild(matchRow);
      }
      const sep1 = document.createElement('div');
      sep1.className = 'le-pop-sep';
      canvasPopover.appendChild(sep1);
    }
    const snapRow = document.createElement('div');
    snapRow.className = 'le-pop-row';
    snapRow.appendChild(snapToggle);
    canvasPopover.appendChild(snapRow);
    if (!epaperHost) {
      // Another layout for certain hours (RFC 014 §5.2): started from this
      // one, or the one on screen removed. Here rather than in the toolbar,
      // which has no row to spare on a phone — see `slotBar`.
      const slotSep = document.createElement('div');
      slotSep.className = 'le-pop-sep';
      const slotRow = document.createElement('div');
      slotRow.className = 'le-pop-row le-pop-slots';
      slotRow.append(newSlotButton, removeSlotButton);
      canvasPopover.append(slotSep, slotRow);
      const sep2 = document.createElement('div');
      sep2.className = 'le-pop-sep';
      canvasPopover.append(sep2, backgroundPanel);
    }
    // The reset, on a panel only. On a wall the page's overflow menu carries
    // "Reset layout…" already, and one destructive action offered twice on one
    // screen is one of them somebody presses by accident.
    if (epaperHost) {
      const actions = document.createElement('div');
      actions.className = 'le-pop-actions';
      actions.appendChild(resetForm);
      canvasPopover.appendChild(actions);
    }
  }

  // Layers: a toggle that opens an anchored popover (built below). Anchored to
  // the tools row, never <body>, so it cannot float over the settings pane.
  const layersButton = document.createElement('button');
  layersButton.type = 'button';
  layersButton.className = 'le-layers-btn';
  layersButton.textContent = 'Layers';
  layersButton.setAttribute('aria-haspopup', 'true');
  layersButton.setAttribute('aria-expanded', 'false');

  const layersPopover = document.createElement('div');
  layersPopover.className = 'le-layers-pop';
  layersPopover.hidden = true;
  const layersHead = document.createElement('div');
  layersHead.className = 'le-layers-head';
  const layersTitle = document.createElement('div');
  layersTitle.className = 'le-layers-title';
  layersTitle.textContent = 'Widget Layers';
  const layersSub = document.createElement('div');
  layersSub.className = 'le-layers-sub';
  layersSub.textContent = 'Drag to reorder — top shows in front';
  layersHead.append(layersTitle, layersSub);
  // The body drawLayers fills. It keeps the old class so the row styling applies.
  const layersPanel = document.createElement('div');
  layersPanel.className = 'le-layers';
  layersPopover.append(layersHead, layersPanel);

  const setLayersOpen = (open: boolean): void => {
    layersOpen = open;
    layersPopover.hidden = !open;
    layersButton.classList.toggle('is-on', open);
    layersButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setCanvasOpen(false);
  };
  const setCanvasOpen = (open: boolean): void => {
    canvasOpen = open;
    canvasPopover.hidden = !open;
    canvasButton.classList.toggle('is-on', open);
    canvasButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setLayersOpen(false);
  };
  layersButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setLayersOpen(!layersOpen);
  });
  canvasButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setCanvasOpen(!canvasOpen);
  });
  // Click outside a popover (and off its button) closes it; so does Escape,
  // which then hands focus back to the button that opened it.
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (layersOpen && !layersPopover.contains(target) && target !== layersButton) setLayersOpen(false);
    if (canvasOpen && !canvasPopover.contains(target) && target !== canvasButton) setCanvasOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (layersOpen) {
      setLayersOpen(false);
      layersButton.focus();
      return;
    }
    if (canvasOpen) {
      setCanvasOpen(false);
      canvasButton.focus();
      return;
    }
    // With nothing else to close, Escape clears the selection (RFC 014 §5.1)
    // — a marquee's or a run of Shift+clicks' — and leaves focus on the box
    // it was on. The inspector's own Escape stops here before this sees it.
    if (modal.hidden && selection.length > 0) clearSelection(true);
  });

  // Templates duplicates the page overflow's "Start from a template…" on a
  // wall, and is the only route to the gallery on a panel, whose page has no
  // overflow menu at all.
  if (epaperHost) palette.appendChild(templateLink);
  /*
   * Each popover hangs off its own button, not off the row.
   *
   * They used to anchor to a tools row whose first item was the button that
   * opened them, so `left: 0` landed underneath it by luck. In one row the
   * buttons are at the end, and a popover anchored to the row opens flush with
   * the far edge — detached from the control that opened it, which is how it
   * looked the first time this was rendered and read as a stray panel.
   */
  const anchor = (button: HTMLElement, popover: HTMLElement): HTMLElement => {
    const wrap = document.createElement('span');
    wrap.className = 'le-pop-anchor';
    wrap.append(button, popover);
    return wrap;
  };
  barMain.append(
    orientToggle,
    slotBar,
    panelChip,
    palette,
    undoButton,
    anchor(layersButton, layersPopover),
    anchor(canvasButton, canvasPopover),
    // Last, because they come and go: a button that appears in the middle of
    // a row moves every control after it, and these appear on a selection.
    groupButton,
    ungroupButton,
  );

  /**
   * What the canvas currently is, in words — on the "Layout" button and on the
   * preview header, which is the one place the wall's size and its update
   * cadence are stated. They used to be repeated under every widget panel.
   */
  function canvasSizeLabel(): string {
    if (panelSize !== undefined) return `${panelSize.w}×${panelSize.h}`;
    if (report !== undefined) {
      const big = Math.max(report.w, report.h);
      const small = Math.min(report.w, report.h);
      const matched = state.orientation === 'landscape' ? big / small : small / big;
      if (Math.abs(matched - state.aspect) < 0.01) return `Match wall · ${report.w}×${report.h}`;
    }
    const preset = ASPECTS.find((a) => Math.abs(a.value - state.aspect) < 0.01);
    return preset?.label ?? `Custom · ${round3(state.aspect)}`;
  }

  function updateCanvasLabel(): void {
    canvasNote.textContent = `\u2014 ${canvasSizeLabel()}`;
    canvasButton.setAttribute('aria-label', `Layout \u2014 ${canvasSizeLabel()}`);
    const dims = document.querySelector<HTMLElement>('[data-preview-dims]');
    if (dims !== null) dims.textContent = `${canvasSizeLabel()} · updates within a minute`;
  }

  /**
   * Make the aspect dropdown reflect `state.aspect`: select a matching preset,
   * or show a "Custom" option when a matched or hand-set aspect is not one of
   * them (a real screen is rarely exactly 9:16). One stale custom option at
   * most — it is rebuilt each call.
   */
  function syncAspectSelect(): void {
    for (const opt of Array.from(aspectSelect.options)) {
      if (opt.dataset['custom'] === '1') aspectSelect.removeChild(opt);
    }
    let matched = false;
    for (const opt of Array.from(aspectSelect.options)) {
      const on = Math.abs(Number(opt.value) - state.aspect) < 0.01;
      opt.selected = on;
      matched = matched || on;
    }
    if (!matched) {
      const opt = document.createElement('option');
      opt.value = String(state.aspect);
      opt.textContent = `Custom (${round3(state.aspect)})`;
      opt.dataset['custom'] = '1';
      opt.selected = true;
      aspectSelect.appendChild(opt);
    }
  }

  // The layers list — every widget, front on top, drag a row to restack, click
  // to select — lives in the anchored popover built in the toolbar above, not
  // as an inline panel here.

  /**
   * The contextual widget inspector.
   *
   * Selecting a widget opens this, and it says which widget it is, what it
   * holds (Content), how it looks (Style), how to close it and how to remove
   * it. On a wall the host is the page's own `#wall-inspector` — a column
   * beside the canvas on a wide screen, a bottom sheet that leaves the canvas
   * visible above it on a phone. The e-paper design page has no such host, so
   * the same panel is built into a card under the stage there.
   *
   * The per-widget options used to be a bare panel that appeared under the
   * canvas and ran straight into the wall's own settings below it, with no
   * heading to say which widget — or indeed that this was a widget at all.
   */
  const inspectorHost =
    document.getElementById('wall-inspector') ?? document.createElement('div');
  const inspectorInline = inspectorHost.id !== 'wall-inspector';
  if (inspectorInline) inspectorHost.className = 'le-inspect-card';
  inspectorHost.textContent = '';

  const inspectorHead = document.createElement('div');
  inspectorHead.className = 'insp-head';
  const inspectorTitle = document.createElement('div');
  inspectorTitle.className = 'insp-title';
  const inspectorClose = document.createElement('button');
  inspectorClose.type = 'button';
  inspectorClose.className = 'insp-close';
  inspectorClose.setAttribute('aria-label', 'Close widget settings');
  inspectorClose.innerHTML = '';
  inspectorClose.textContent = '×';
  inspectorClose.addEventListener('click', () => clearSelection(true));
  inspectorHead.append(inspectorTitle, inspectorClose);

  const inspectorBody = document.createElement('div');
  inspectorBody.className = 'insp-body';

  // Content | Style. Drawn only when the widget actually has both — a Clock
  // has nothing to configure but its box, and a tab bar with one live tab is
  // a control that says nothing.
  const inspectorTabs = document.createElement('div');
  inspectorTabs.className = 'insp-tabs';
  inspectorTabs.setAttribute('role', 'tablist');
  const inspectorTabButtons: Record<'content' | 'style', HTMLButtonElement> = {
    content: document.createElement('button'),
    style: document.createElement('button'),
  };
  let inspectorTab: 'content' | 'style' = 'content';
  for (const which of ['content', 'style'] as const) {
    const button = inspectorTabButtons[which];
    button.type = 'button';
    button.className = 'insp-tab';
    button.setAttribute('role', 'tab');
    button.dataset['tab'] = which;
    button.textContent = which === 'content' ? 'Content' : 'Style';
    inspectorTabs.appendChild(button);
  }
  /*
   * Arrow keys, Home and End — `wireTabs`, shared with `display-editor.ts`.
   *
   * These carried a roving `tabindex` and no arrow handler, which is the worst
   * of both: the inactive tab leaves the tab order, and nothing else reaches
   * it. Style was unreachable by keyboard entirely, and so was everything on
   * it — including, now, the numeric position fields.
   */
  wireTabs(
    [inspectorTabButtons.content, inspectorTabButtons.style],
    (tab) => tab.dataset['tab'],
    (key) => {
      inspectorTab = key === 'style' ? 'style' : 'content';
      renderConfigPanel();
    },
    false,
  );

  /*
   * The two lanes (RFC 005, direction B): the wall's settings, and what this
   * widget says differently on a panel that follows this canvas.
   *
   * Drawn only when a panel is actually following — the server sends the tables
   * only then — so a household with no e-paper never sees it. It sits above the
   * Content/Style tabs rather than beside them because it is not a third tab: it
   * chooses *which widget's settings* the tabs are showing.
   */
  const laneBar = document.createElement('div');
  laneBar.className = 'insp-lanes';
  laneBar.setAttribute('role', 'tablist');
  laneBar.hidden = true;
  const laneButtons: Record<'wall' | 'ink', HTMLButtonElement> = {
    wall: document.createElement('button'),
    ink: document.createElement('button'),
  };
  for (const which of ['wall', 'ink'] as const) {
    const button = laneButtons[which];
    button.type = 'button';
    button.className = 'insp-lane';
    button.setAttribute('role', 'tab');
    button.dataset['lane'] = which;
    button.textContent = which === 'wall' ? 'On the wall' : 'On ink';
    laneBar.appendChild(button);
  }
  // The lane had the same roving-tabindex-with-no-arrows fault as the tabs
  // above, so the whole ink lane was pointer-only.
  wireTabs(
    [laneButtons.wall, laneButtons.ink],
    (tab) => tab.dataset['lane'],
    (key) => {
      const next = key === 'ink' ? 'ink' : 'wall';
      if (lane === next) return;
      lane = next;
      inspectorTab = 'content';
      renderConfigPanel();
      renderPreview();
    },
    false,
  );

  // The per-widget options themselves. Boxless — the inspector is the card.
  const configPanel = document.createElement('div');
  configPanel.className = 'le-config';

  /*
   * Duplicate, which the undo stack is what makes safe to offer.
   *
   * It sits above Remove and outside the danger row: copying a widget is the
   * cheapest thing on this panel, and putting it beside the destructive action
   * would give the two the same weight — the mistake the toolbar made with
   * "Reset layout" beside "Add widget".
   */
  const inspectorActions = document.createElement('div');
  inspectorActions.className = 'insp-actions';
  const duplicateButton = document.createElement('button');
  duplicateButton.type = 'button';
  duplicateButton.className = 'le-add';
  duplicateButton.textContent = 'Duplicate';
  duplicateButton.addEventListener('click', duplicateSelected);
  inspectorActions.appendChild(duplicateButton);

  const inspectorDanger = document.createElement('div');
  inspectorDanger.className = 'insp-danger';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'insp-remove';
  removeButton.addEventListener('click', removeSelected);
  inspectorDanger.appendChild(removeButton);

  inspectorBody.append(laneBar, inspectorTabs, configPanel, inspectorActions, inspectorDanger);
  inspectorHost.append(inspectorHead, inspectorBody);
  // Nothing selected yet: on a wall the host keeps the empty note the server
  // rendered, so the column is not a blank box on a desktop.
  const inspectorEmpty = document.createElement('p');
  inspectorEmpty.className = 'insp-empty';
  inspectorEmpty.textContent =
    'Nothing selected. Tap a widget on the layout to change what it shows and how it looks.';
  inspectorHost.appendChild(inspectorEmpty);

  // Escape closes the inspector wherever focus is inside it, and hands focus
  // back to the widget on the canvas — the element that opened it.
  inspectorHost.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.stopPropagation();
    clearSelection(true);
  });

  mount.append(toolbar, stage, hint, modal);
  if (inspectorInline) mount.appendChild(inspectorHost);

  // ---- the live preview ------------------------------------------------

  // Load the real manifest and the display's stylesheet, then draw the preview.
  // Both behind the session; a failure just leaves the labelled overlay.
  //
  // A panel takes neither: its backdrop is the frame its own renderer draws,
  // so the wall's manifest, stylesheet and shadow root are all beside the
  // point there.
  void (async (): Promise<void> => {
    if (epaperHost) {
      renderPreview();
      return;
    }
    try {
      const [manifestRes, cssRes] = await Promise.all([
        fetch(`admin/layout/preview.json${screenQuery}`),
        fetch('assets/display.css'),
      ]);
      if (!manifestRes.ok || !cssRes.ok) return;
      manifest = (await manifestRes.json()) as Manifest;
      const css = await cssRes.text();

      const shadow = preview.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = previewStylesheet(css);
      const wall = document.createElement('div');
      wall.className = PREVIEW_ROOT_CLASS;
      shadow.append(styleEl, wall);
      previewShadow = shadow;
      previewWall = wall;
      /*
       * The household's own CSS (RFC 014 §7), on the preview's copy of the
       * stylesheet exactly as the wall puts it on its own: after every rule
       * of it, through the CSSOM. The blocks are the manifest's — scoped by
       * the server, keyed by the ids this canvas already has — so a wall and
       * its editor cannot disagree about what a box looks like, which is the
       * fault the preview exists to prevent. A box added here has none yet.
       */
      previewCss = createCustomCssSheet(() => styleEl.sheet ?? undefined);
      customCssById = new Map();
      const remember = (widgets: unknown): void => {
        if (!Array.isArray(widgets)) return;
        for (const widget of widgets as { readonly id?: unknown; readonly customCss?: unknown }[]) {
          if (typeof widget?.id === 'string' && typeof widget.customCss === 'string') {
            customCssById.set(widget.id, widget.customCss);
          }
        }
      };
      remember(manifest.layout?.portrait?.widgets);
      remember(manifest.layout?.landscape?.widgets);
      for (const slot of manifest.layout?.slots ?? []) {
        const named = slot as { readonly portrait?: { readonly widgets?: unknown }; readonly landscape?: { readonly widgets?: unknown } };
        remember(named?.portrait?.widgets);
        remember(named?.landscape?.widgets);
      }

      const at = Date.now();
      model = buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false });
      renderPreview();
    } catch {
      // Leave the labelled overlay; it is a complete editor without the preview.
    }
  })();

  function renderPreview(): void {
    // On a panel the preview is the panel's own frame, not the wall's.
    if (epaperHost) {
      scheduleEpaperPreview();
      return;
    }
    // The ink lane's frame is the real panel, so it has to be re-fetched when
    // anything changes — the wall preview below still redraws, because the lane
    // switch does not stop somebody dragging a box.
    if (lane === 'ink') scheduleInkFrame();
    if (model === undefined || previewWall === undefined || manifest === undefined) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    /*
     * Render at a reference resolution, then scale the whole wall down to this
     * box — rather than rendering it at the box's own small pixel size. The
     * arithmetic and the argument are in `preview-css.ts`, shared with the
     * template gallery's cards so the editor and a card cannot come to draw one
     * canvas two ways.
     *
     * The comment that stood here had the mechanism right and was incomplete in
     * a way that mattered: it named the rem, and not the `:root` block the rem
     * sizes are declared in, which a shadow root also cannot see — so the wall
     * this preview drew was correctly proportioned and missing its type scale,
     * its spacing scale and its theme's display face. `previewStylesheet` is the
     * other half, and it is why this is now two calls rather than fifteen lines.
     */
    layoutPreviewRoot(previewWall, { width: rect.width, height: rect.height }, state.aspect);
    // With the resolved tokens, so a custom theme previews as itself rather
    // than as the bundle's fallback — and so the style lane's seeded values
    // (`styleBase`) and the preview describe the same wall.
    applyTheme(previewWall, manifest.theme.active, manifest.theme.activeTokens, manifest.theme.activeShape);

    // The wall as it will actually draw — always free-form now. It draws straight
    // into the shadow wall: the reused sections measure themselves and scale to
    // their box, so they are indifferent to the shadow root having no root
    // font-size of its own.
    const drawn = previewWidgets();
    renderFreeform(previewWall, model, {
      aspect: state.aspect,
      widgets: drawn,
      ...(state.background !== undefined ? { background: state.background } : {}),
    }, EDITOR_MEDIA_BASE);
    // Then the household's CSS, for the boxes on this canvas that carry one.
    previewCss?.apply(
      customCssBlocks(
        manifest.screen?.customCss,
        drawn.map((widget) => ({ customCss: customCssById.get(widget.id) })),
      ),
    );

    // The ladder's cut marker is read back out of what was just drawn, so the
    // editor and the wall cannot disagree about what fits. The tier note is the
    // same read-back one control along, and it moves when a box is resized —
    // which is the moment a household most wants to be told what they bought.
    markLadderCut();
    refreshDensityNote();
  }

  /**
   * The panel's own frame, behind the drag overlay.
   *
   * The arrange area used to draw through `renderFreeform` — the *wall*
   * renderer — so a black-and-white panel was arranged against colour cards
   * that shared none of its type, sizes or truncation. Rather than write a
   * second 1-bit renderer here and have the two disagree (which is exactly how
   * the clock came to read "08:3" on a panel while the editor showed 08:32),
   * the server draws it: the canvas is posted as it stands and the reply is the
   * frame the panel would put on glass.
   *
   * Debounced, because a drag is hundreds of moves and this is a round trip;
   * the boxes you drag are the overlay, which never waits for it. A failed or
   * refused request keeps the frame already showing rather than blanking the
   * area somebody is working in.
   */
  /*
   * The ink lane's frame: the panel's own drawing of this canvas.
   *
   * Not a backdrop behind the drag boxes, which is what the panel's *own*
   * designer does — there the canvas is the panel's ratio, so the boxes line up
   * with the frame. Here the canvas is the wall's ratio and the panel's is not,
   * so drawing one behind the other would put every box somewhere it is not.
   * It sits in the inspector instead, beside the controls that change it, which
   * is the "side by side" this lane was always for: the household reads the
   * real frame rather than a browser's impression of one.
   *
   * Debounced and single-flight, the same shape as the designer's backdrop, and
   * a failed request keeps the frame already showing.
   */
  let inkImage: HTMLImageElement | undefined;
  let inkObjectUrl: string | undefined;
  let inkTimer: number | undefined;
  let inkPending = false;

  /**
   * The following panel that draws the canvas currently open, if any.
   *
   * A widget row belongs to one orientation, so an ink override on a portrait
   * widget is only ever read by a panel that draws the portrait canvas. Picking
   * the panel by orientation is what stops the lane offering settings that
   * nothing would read — the `options.json` rule, one level down.
   */
  function inkPanelForCanvas(): InkPanel | undefined {
    return ink?.panels.find((panel) => panel.orientation === state.orientation);
  }

  function scheduleInkFrame(): void {
    if (ink === undefined) return;
    if (inkTimer !== undefined) window.clearTimeout(inkTimer);
    inkTimer = window.setTimeout(() => {
      inkTimer = undefined;
      void refreshInkFrame();
    }, 260);
  }

  async function refreshInkFrame(): Promise<void> {
    const panel = inkPanelForCanvas();
    if (panel === undefined) return;
    if (inkPending) {
      scheduleInkFrame();
      return;
    }
    inkPending = true;
    try {
      const response = await fetch(`admin/epaper/${encodeURIComponent(panel.id)}/preview.png`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ widgets: widgetsForSave(drawnWidgets()) }),
      });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      if (inkImage !== undefined) inkImage.src = url;
      if (inkObjectUrl !== undefined) URL.revokeObjectURL(inkObjectUrl);
      inkObjectUrl = url;
    } catch {
      // Keep the last good frame.
    } finally {
      inkPending = false;
    }
  }

  function scheduleEpaperPreview(): void {
    if (epaperTimer !== undefined) window.clearTimeout(epaperTimer);
    epaperTimer = window.setTimeout(() => {
      epaperTimer = undefined;
      void renderEpaperPreview();
    }, 220);
  }

  async function renderEpaperPreview(): Promise<void> {
    if (state.screen === null) return;
    // One in flight at a time; the newest state re-queues behind it so the
    // frame that lands is always the canvas as it stands.
    if (epaperPending) {
      scheduleEpaperPreview();
      return;
    }
    epaperPending = true;
    try {
      const response = await fetch(`admin/epaper/${detailSeg}/preview.png`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ widgets: widgetsForSave(drawnWidgets()) }),
      });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      if (epaperImage === undefined) {
        const img = document.createElement('img');
        img.className = 'le-epaper-preview';
        img.alt = '';
        preview.appendChild(img);
        epaperImage = img;
      }
      epaperImage.src = url;
      // Release the frame this one replaces, not this one.
      if (epaperObjectUrl !== undefined) URL.revokeObjectURL(epaperObjectUrl);
      epaperObjectUrl = url;
    } catch {
      // Keep the last good frame.
    } finally {
      epaperPending = false;
    }
  }

  // ---- the draggable overlay -------------------------------------------

  /**
   * Recompute whether anything is unsaved, rather than assert it.
   *
   * Every mutation calls this, and it answers by comparing what would be posted
   * with what was last posted — so undoing back to where you started clears the
   * flag honestly, and the other orientation's unsaved work keeps it set.
   */
  function markDirty(): void {
    setDirty(isCanvasDirty(state, savedSnapshot[activeKey()] ?? '', anyStashDirty()));
    refreshUndo();
  }

  function sizeCanvas(): void {
    // A bigger canvas: the editor is the main surface now, so give it more room
    // to drag in than the old inline-below-the-settings size. The left pane is
    // sticky, so cap the height to the viewport too — a tall portrait canvas
    // must not run off the bottom and take the preview out of view.
    /*
     * The stage's *content* width, not its `clientWidth` — which includes its
     * own 16px padding either side.
     *
     * Asking for 32px more than the stage can give does not overflow: the
     * canvas is a flex item, so it is shrunk back to fit, keeping the height
     * this function set. The canvas then has a ratio that is not the one being
     * authored, and the preview — which is fitted from the height and is
     * correct — runs off the side and is clipped. Portrait hid it, because
     * there the height clamp recomputes the width and lands inside the stage
     * anyway; landscape is width-driven, so it showed.
     */
    const stagePad = (() => {
      const cs = getComputedStyle(stage);
      return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    })();
    /*
     * The stage is the whole width budget: it is already bounded by the pane
     * the page gives it, so a constant on top of it is a second opinion about
     * the same thing. There used to be one — `Math.min(…, 720)`, the width
     * twin of the old 720px height cap — and it was invisible only because the
     * 1180px content column could never hand this stage more than 685px. It
     * would have swallowed the wider column whole: a landscape wall would have
     * gone from 685px to 720px on a 1920px monitor and stopped there.
     */
    const maxW = Math.max(120, (stage.clientWidth || 360) - stagePad);
    // With the inspector open as a sheet, the canvas keeps the top third of
    // the viewport rather than running underneath it — a preview you cannot
    // see is not a preview.
    const sheetOpen = inspectorIsSheet() && inspectorHost.classList.contains('is-open');
    const narrow = window.innerWidth < 900;
    /*
     * What is left of a phone once the chrome above the canvas and the save bar
     * below it are paid for (RFC 009 Phase 5).
     *
     * Measured, not guessed at a fraction of the viewport: the canvas's own top
     * is a fact about everything above it and does not move when the canvas is
     * resized, so there is no feedback loop here. Guessing is also how a canvas
     * ends up with its bottom edge — and the resize handle of every widget on
     * it — underneath a fixed save bar.
     */
    const roomBelowChrome = (): number => {
      const above = canvas.getBoundingClientRect().top + window.scrollY;
      const bar = document.getElementById('savebar')?.getBoundingClientRect().height ?? 64;
      return Math.round(window.innerHeight - above - bar - 12);
    };
    /*
     * What a desktop viewport can show of the canvas *at once*, which is a
     * different question from `roomBelowChrome()`.
     *
     * The chrome above the canvas scrolls away; the app bar and the fixed save
     * bar do not. So the tallest canvas that is still whole on screen — once
     * the household has scrolled the toolbar up under the app bar — is the
     * viewport less those two, and that is the budget here. Measured for the
     * same reason as `roomBelowChrome()`: a second copy of the bar heights in
     * this file would drift from the stylesheet that sets them.
     *
     * It replaces a constant 720, which is what stopped this editor using a
     * large screen: a portrait wall came out 383px wide at 1280 *and* at 1440,
     * and 405px at 1920 — 21% of the monitor, with the canvas the smallest
     * thing on a page that exists to arrange it. A constant cannot know the
     * viewport, so this scales with it instead of being a larger constant.
     */
    const roomOnScreen = (): number => {
      const bar = document.getElementById('savebar')?.getBoundingClientRect().height ?? 64;
      const top = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 64;
      return Math.round(window.innerHeight - top - bar - 24);
    };
    // Measured against the sheet rather than guessed at a fraction of the
    // viewport: the sheet's own height is a min() of two values in the
    // stylesheet, and a second copy of that sum here would drift.
    const maxH = sheetOpen
      ? Math.max(
          140,
          Math.round(
            window.innerHeight - inspectorHost.getBoundingClientRect().height - SHEET_CLEARANCE,
          ),
        )
      : narrow
        /*
         * The canvas is the point of this screen, so on a phone it takes what
         * the chrome above it leaves rather than a fixed 46% of the viewport —
         * but never *less* than that fraction.
         *
         * A page whose chrome is taller than the viewport is one the household
         * scrolls to reach the canvas at all: the panel designer carries a
         * source form and a full-height preview above its mount, so "what is
         * left below the chrome" there is negative, and taken literally it
         * would collapse the canvas to its floor — smaller than before this
         * measurement existed.
         */
        ? Math.max(
            260,
            Math.min(
              Math.round(window.innerHeight * 0.62),
              Math.max(roomBelowChrome(), Math.round(window.innerHeight * 0.46)),
            ),
          )
        : Math.max(360, roomOnScreen());
    let w = maxW;
    let h = w / state.aspect;
    if (h > maxH) {
      h = maxH;
      w = h * state.aspect;
    }
    canvas.style.width = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(h)}px`;
  }

  /*
   * Re-size when the stage's own width changes, not only at boot and on a
   * window resize.
   *
   * `sizeCanvas()` reads `stage.clientWidth`, and a `display:none` stage reports
   * 0 — so the `|| 360` fallback runs and the canvas is laid out for a stage a
   * third of the real one. The wall page hides the Layout pane whenever this
   * browser last left off on Wall settings (`display-editor.ts` restores that
   * from `localStorage`, and it runs *before* this module), so for every
   * household who has ever opened Wall settings the editor boots against a
   * stage of zero width: measured on a 1440px window, a 992px stage drew a
   * 328x583 canvas where it should draw 477x848. Switching back to Layout
   * un-hid the stage and nothing recomputed, so the canvas stayed a third of
   * its size until the window happened to be resized — which is exactly how it
   * was reported.
   *
   * An observer rather than a `sizeCanvas()` beside every place that shows the
   * pane, for the reason the preview's own observer below gives: the fit is a
   * fact about the geometry, not a step in a routine somebody has to remember,
   * and the pane is shown from a different module that knows nothing about this
   * canvas. It also picks up what a `resize` listener cannot see at all — a
   * scrollbar appearing, the inspector column arriving, a font landing.
   *
   * No feedback loop: the stage's width comes from the pane above it and never
   * from the canvas inside it (`.le-stage` is a flex row and `.le-canvas` a flex
   * item that shrinks), so sizing the canvas cannot change the width being
   * observed. The width guard makes that belt-and-braces — the stage's *height*
   * does follow the canvas, and reacting to that would be a loop.
   */
  if (typeof ResizeObserver !== 'undefined') {
    let sizedFor = -1;
    new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? stage.clientWidth;
      if (width === sizedFor) return;
      sizedFor = width;
      // Nothing to size against yet: leave the canvas as it is rather than
      // laying it out for a stage that is not on screen.
      if (width <= 0) return;
      /*
       * The size and nothing else. The overlay is positioned in percentages so
       * it follows the box for free, and the preview has its own observer on
       * the canvas below — which is also why this must not be a `draw()`: on a
       * panel that would `renderPreview()`, and a panel's preview is a POST.
       */
      sizeCanvas();
    }).observe(stage);
  }

  /*
   * What the wall will actually draw of this canvas, and why a box is left out.
   *
   * Both are `omission.ts`, which is also where the three sentences a household
   * reads about it are composed — the flag on the box, the note in the
   * inspector and the box's accessible name. The overlay keeps every box (one
   * you cannot see is one you cannot move); the *preview* is a claim about the
   * glass, and a preview drawing "Nothing to show yet." underneath a box
   * flagged "Not on the wall" is two sentences on one screen contradicting each
   * other.
   */
  /**
   * The flags, as of now.
   *
   * Re-derived from the server's facts on every read rather than kept, so a box
   * added a moment ago, a list picked in the inspector, or an undo that put a
   * list back all get the answer the wall would give — with no hook anybody
   * has to remember to call after a mutation. Both canvases are asked, since a
   * flag has to follow a box through the orientation toggle.
   */
  const notDrawn = (): NotDrawn =>
    omissionFacts === undefined
      ? notDrawnSeed
      : notDrawnFor(allWidgets(), omissionFacts);
  /*
   * A flagged box that names a fallback draws the fallback in its rectangle
   * (RFC 014 §5.3) — substituted here from the same facts, in the server's
   * order, so the preview, the ink-lane frame and the arrange backdrop all draw
   * what the wall and the panel will.
   */
  const drawnWidgets = (): readonly Widget[] => drawnOf(state.widgets, notDrawn(), omissionFacts);
  const omissionOf = (widget: Widget): Omission | undefined =>
    omissionOfBox(widget, state.widgets, notDrawn(), omissionFacts);
  /** The name of what stands in for a flagged box, when something does. */
  const insteadName = (omission: Omission | undefined): string | undefined =>
    omission?.instead === undefined ? undefined : describeWidget(omission.instead);

  /**
   * The widgets as the wall's own renderer needs them for the preview.
   *
   * A to-do box stores the list's entity id and the manifest hands the wall a
   * handle in its place (`displayConfig`, server side), keying the to-do panel
   * the same way. The preview renders the real manifest through the wall's own
   * `renderFreeform`, so the box has to say the handle here too — substituted
   * from what the server handed the picker, never derived: the editor has no
   * opinion about how a handle is made, it only repeats one it was given.
   */
  const previewWidgets = (): (Widget & { styleTokens?: Record<string, string> })[] =>
    drawnWidgets().map((w) => {
      const list = w.type === 'todo' ? todoListOf(w.config) : undefined;
      const known = list === undefined ? undefined : state.todoLists.find((one) => one.id === list);
      const placed = known === undefined ? { ...w } : { ...w, config: { ...w.config, list: known.key } };
      /*
       * The style lane, resolved for the preview (RFC 014 §4.1). The wall
       * reads what the server resolved; an unsaved lane has no server behind
       * it yet, so the preview resolves it here through the bundle's own
       * mirror of the derivation — the theme builder's arrangement, one
       * widget down — against the same base the seeded controls read.
       */
      const own = styleLayerOf(w.config?.['style']);
      const tokens = resolveStyleTokens(styleBase(), styleContext(), own);
      return tokens === undefined ? placed : { ...placed, styleTokens: tokens };
    });

  /** The wall's theme as colour tokens: what every lane is resolved against. */
  const styleBase = (): Readonly<Record<string, string>> =>
    manifest?.theme.activeTokens ?? themeTokens(manifest?.theme.active ?? 'panels');

  /** The wall's default lane, resolved by the server, as the layer under a widget's. */
  const styleContext = (): readonly StyleLayer[] => {
    const canvas = styleLayerOf(manifest?.screen?.layoutStyleTokens);
    return canvas === undefined ? [] : [canvas];
  };

  /**
   * What this editor is arranging, in the household's word for it.
   *
   * The same editor draws a wall's canvas and an e-paper panel's, and the two
   * are different objects on two different pages. One noun for both would be
   * wrong on one of them every time.
   */
  const surfaceWord = (): Surface => (epaperHost ? 'panel' : 'wall');

  /** Rebuild the overlay boxes from state. Cheap — a box is a div and a label. */
  function drawOverlay(): void {
    overlay.textContent = '';
    // The layout's own boxes back to front, then each group's children in
    // their own order (RFC 014 §5.1): a child's `z` is relative to its group,
    // so the two scales are never sorted against each other, and `overlayZ`
    // is what stacks a child over its parent's box.
    const children = groupChildren(state.widgets);
    const ordered: Widget[] = [];
    for (const widget of topLevelWidgets(state.widgets).sort((a, b) => a.z - b.z)) {
      ordered.push(widget, ...(children.get(widget.id) ?? []));
    }
    for (const widget of ordered) overlay.appendChild(overlayNode(widget));
    /*
     * Place the name chips again now the boxes are in the document.
     *
     * `placeLabel` reads the chip's own height and the canvas's, and neither
     * exists for a node that has not been laid out yet — so the pass inside
     * `overlayNode` is the cheap one that gets the width cap right, and this is
     * the one that can measure. Skipped when the overlay has no height of its
     * own yet (the first draw of a hidden orientation), where the first pass's
     * answer stands until something moves.
     */
    if (overlay.clientHeight > 0) {
      for (const widget of ordered) {
        const label = overlay.querySelector<HTMLElement>(
          `.le-widget[data-id="${widget.id}"] > .le-widget-label`,
        );
        if (label !== null) placeLabel(label, canvasBoxOf(state.widgets, widget));
      }
    }
    hint.style.display = state.widgets.length === 0 ? '' : 'none';
    refreshGroupButtons();
    renderConfigPanel();
  }

  /**
   * A box's stacking on the overlay. A child sits over its group's own box —
   * which is where a tap has to land on the child and not on the group
   * behind it — so its value is its parent's rung plus its own place, and a
   * box on the layout takes a rung of its own. Hundreds apart, so a group of
   * up to fifty children (the server's whole cap) never reaches the next box.
   */
  function overlayZ(widget: Widget): number {
    const parentId = parentIdOf(widget);
    const parent = parentId === undefined ? undefined : state.widgets.find((w) => w.id === parentId);
    return parent === undefined ? widget.z * 100 : parent.z * 100 + 1 + widget.z;
  }

  /** Every box's rectangle and stacking re-read in place — after a group's layout or order changed. */
  function repositionAll(): void {
    for (const box of overlay.querySelectorAll<HTMLElement>('.le-widget')) {
      const widget = state.widgets.find((one) => one.id === box.dataset['id']);
      if (widget === undefined) continue;
      positionBox(box, widget);
      box.style.zIndex = String(overlayZ(widget));
    }
  }

  /**
   * Take the `z` values of a list `grouping.ts` answered onto the widgets the
   * overlay's handlers already hold. Those handlers close over the objects in
   * `state.widgets`, so replacing the list mid-drag would leave a drag writing
   * into a box that is no longer on the layout; copying the numbers back is
   * what keeps a reorder in place.
   */
  function adoptZ(next: readonly Widget[]): void {
    const z = new Map(next.map((w) => [w.id, w.z]));
    for (const widget of state.widgets) {
      const value = z.get(widget.id);
      if (value !== undefined) widget.z = value;
    }
  }

  function overlayNode(widget: Widget): HTMLElement {
    const box = document.createElement('div');
    const parentId = parentIdOf(widget);
    box.className =
      'le-widget' +
      (selection.includes(widget.id) ? ' is-selected' : '') +
      (widget.type === 'group' ? ' is-group' : '') +
      (parentId === undefined ? '' : ' is-child');
    box.dataset['id'] = widget.id;
    if (parentId !== undefined) box.dataset['parent'] = parentId;
    positionBox(box, widget);
    box.style.zIndex = String(overlayZ(widget));

    /*
     * A widget on the canvas is a control, so it is one: a tab stop with a
     * name and a pressed state. Dragging needs a pointer, but *choosing* a
     * widget to edit must not — and it is also where focus returns when the
     * inspector closes, which a plain <div> could not accept.
     */
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-pressed', selection.includes(widget.id) ? 'true' : 'false');
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        // Shift+Enter is Shift+click for the keyboard: into or out of the set.
        if (event.shiftKey) toggleInSelection(widget.id);
        else selectWidget(widget.id);
        return;
      }
      /*
       * Arrow keys place the box (RFC 009 Phase 5): 1% a press, Shift to
       * resize. The editor was pointer-only — the only key bound to a widget
       * was Enter to select it, and the arrows scrolled the page underneath.
       *
       * The arithmetic is `placement.ts`, shared with the drag and with the
       * inspector's numeric fields, so all three stop at the same edge.
       */
      // Alt+Left and Cmd+Left are Back, and Ctrl+Arrow is a word jump or a
      // desktop switch. A nudge is a bare arrow, or Shift for the size.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      /*
       * A child of a row, a column or a grid has no position of its own — its
       * place is the group's order — so an arrow moves it along that order
       * instead (RFC 014 §5.1), and the siblings slide over in place.
       */
      const parent = parentId === undefined ? undefined : state.widgets.find((w) => w.id === parentId);
      if (parent !== undefined && groupIsOrdered(parent.config)) {
        const step =
          event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
          : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : 0;
        if (step === 0) return;
        event.preventDefault();
        const siblings = groupChildren(state.widgets).get(parent.id) ?? [];
        const at = siblings.findIndex((one) => one.id === widget.id);
        recordRun(`order:${widget.id}`);
        adoptZ(moveChildTo(state.widgets, widget.id, at + step));
        repositionAll();
        drawLayers();
        if (primary() !== widget.id || selection.length !== 1) selectWidget(widget.id, true);
        markDirty();
        schedulePreview();
        return;
      }
      // A child's fractions are of its group, so the same nudge clamps at the
      // group's edge with no second rule (`placement.ts`).
      const next = nudge(widget, event.key, { resize: event.shiftKey });
      if (next === undefined) return;
      event.preventDefault();
      recordRun(`${event.shiftKey ? 'size' : 'move'}:${widget.id}`);
      applyBox(widget, next);
      positionBox(box, widget);
      /*
       * Nudging is editing, so the inspector follows the box — and keeps focus
       * where it is, which is the whole reason `selectWidget` toggles classes
       * in place instead of rebuilding the overlay. Rebuilding destroyed the
       * focused element, so the second arrow key went to the document.
       */
      if (primary() !== widget.id || selection.length !== 1) selectWidget(widget.id, true);
      else syncBoxFields(widget);
      markDirty();
      schedulePreview();
    });

    /*
     * The name chip, appended before the flag and the handle so it is the
     * child `positionBox` finds — and placed only once it is in the document,
     * because placing it reads its own height.
     */
    const label = document.createElement('span');
    label.className = 'le-widget-label';
    label.textContent = nameOf(widget);
    box.appendChild(label);
    placeLabel(label, canvasBoxOf(state.widgets, widget));

    /*
     * A box the wall will not draw, said on the box.
     *
     * Without this the editor shows five widgets and the wall shows three, with
     * nothing anywhere connecting the two — which is the shape of every fault
     * in this project where one thing is stored and two things read it. The
     * reason is in the inspector; this is the flag that sends you there.
     */
    const omission = omissionOf(widget);
    const instead = insteadName(omission);
    if (omission !== undefined) {
      box.classList.add('is-not-drawn');
      const flag = document.createElement('span');
      flag.className = 'le-widget-flag';
      // The noun follows the host. This editor draws a panel's canvas as well
      // as a wall's, and "not on the wall" beside a 1-bit frame is the wrong
      // object — the same page carries the word "panel" everywhere else.
      flag.textContent = omissionFlag(surfaceWord(), instead);
      box.appendChild(flag);
    }
    // Composed after the flag, and by the same function `refreshLabels` uses,
    // so a flagged box whose name changes is renamed to a screen reader too.
    box.setAttribute(
      'aria-label',
      boxAriaLabel(nameOf(widget), omission?.why, surfaceWord(), instead, widget.type === 'group' ? 'group' : 'widget'),
    );

    const handle = document.createElement('span');
    handle.className = 'le-handle';
    box.appendChild(handle);

    box.addEventListener('pointerdown', (event) => startDrag(event, widget, box, false));
    handle.addEventListener('pointerdown', (event) => startDrag(event, widget, box, true));
    return box;
  }

  /** Write a box computed by `placement.ts` back onto the widget. */
  function applyBox(widget: Widget, box: Box): void {
    widget.x = box.x;
    widget.y = box.y;
    widget.w = box.w;
    widget.h = box.h;
  }

  /**
   * Put the widget's real box back into the inspector's numeric fields.
   *
   * A drag and an arrow key both move the same widget the fields describe, so
   * leaving them behind would give one widget two positions on one screen —
   * and the field is the one a household would then trust. Never over a field
   * being typed into, unless the edit has been committed (`force`), which is
   * where the clamp becomes visible: type 140 and the field settles on what
   * the canvas can actually hold.
   */
  function syncBoxFields(widget: Widget, force = false): void {
    if (boxFields === undefined || boxFields.id !== widget.id) return;
    for (const [field, input] of boxFields.inputs) {
      if (!force && document.activeElement === input) continue;
      input.value = String(Math.round(widget[field] * 100));
    }
  }

  /*
   * The preview catches up shortly after, never on every keystroke.
   *
   * A drag redraws it once on release for the same reason: re-rendering a month
   * grid on every pointer move judders. Holding an arrow key is the same event
   * rate, so it gets the same treatment — the box itself moves immediately,
   * because that is the thing being placed.
   */
  let previewTimer: number | undefined;
  function schedulePreview(): void {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = undefined;
      renderPreview();
    }, 140);
  }

  function positionBox(box: HTMLElement, widget: Widget): void {
    // On the layout: a child's own fractions are of its group, and where it
    // actually sits is `grouping.ts`'s answer — through the group's box, and
    // through the group's order in a row, a column or a grid.
    const rect = canvasBoxOf(state.widgets, widget);
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    const label = box.querySelector<HTMLElement>('.le-widget-label');
    if (label !== null) placeLabel(label, rect);
  }

  /*
   * The chip's own height, measured once and kept.
   *
   * `placeLabel` runs on every pointer move of a drag, and reading offsetHeight
   * there is a layout flush per move. The height is a fact about the stylesheet
   * — one font, one padding — so it is read from the first chip that has one
   * and reused. Zero until a chip has been laid out, which `placeLabel` treats
   * as "no measurement yet" rather than as "no room anywhere".
   */
  let chipHeight = 0;

  /**
   * Put the name chip on the side of the box that has room for it.
   *
   * Above by default, because a name reads as a caption over the thing it names
   * and the box's own bottom-right corner is the resize handle. A widget
   * against the top of the canvas has nothing above it and `.le-canvas` is
   * `overflow:hidden`, so a chip left there is cut off rather than tight — it
   * goes below instead. When neither side has room (a widget filling the
   * canvas) it takes the roomier one and is clipped; Layers and the inspector
   * still name it, and there is nowhere outside the box left to go.
   *
   * The width cap is the same argument sideways: the chip is left-aligned with
   * the box, so on a box near the right edge a long name would run off the
   * canvas and be cut mid-word. Capped to what is left of the canvas, it
   * ellipsises instead — a shortened name, not a sliced one.
   */
  function placeLabel(label: HTMLElement, widget: Box): void {
    // A percentage max-width resolves against the *box*, not the canvas, so the
    // canvas fraction to the right of the box's left edge is converted into
    // one. w is at least 0.02 by schema, so this cannot divide by zero.
    label.style.maxWidth = `${((1 - widget.x) / widget.w) * 100}%`;
    if (chipHeight === 0) chipHeight = label.offsetHeight;
    const canvasHeight = overlay.clientHeight;
    // 2px of clearance, matching the calc() in the stylesheet.
    const needed = chipHeight + 2;
    const above = widget.y * canvasHeight;
    const below = (1 - widget.y - widget.h) * canvasHeight;
    label.classList.toggle('is-below', above < needed && below > above);
  }

  /**
   * The layers list, front (highest z) first — the order the eye reads a stack,
   * top of the list nearest the viewer. Drag a row by its grip to restack;
   * click a row to select its widget on the canvas.
   */
  function drawLayers(): void {
    layersPanel.textContent = '';
    if (state.widgets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'le-layers-empty';
      empty.textContent = 'Nothing placed yet. Add a widget to see it here.';
      layersPanel.appendChild(empty);
      return;
    }

    /*
     * Front first on the layout, and under each group its children, front
     * first among themselves, indented (RFC 014 §5.1). A child's `z` is its
     * place in its group, so the two lists are two scopes; the grip reorders
     * within the scope its row is in and never across it.
     */
    const children = groupChildren(state.widgets);
    const row = (widget: Widget, scope: string): void => {
      const line = document.createElement('div');
      line.className =
        'le-layer' + (selection.includes(widget.id) ? ' is-selected' : '') + (scope === '' ? '' : ' le-layer-child');
      line.dataset['id'] = widget.id;
      line.dataset['scope'] = scope;

      const grip = document.createElement('span');
      grip.className = 'le-layer-grip';
      grip.textContent = '⋮⋮';
      grip.addEventListener('pointerdown', (event) => startReorder(event, widget, scope));

      const swatch = document.createElement('span');
      swatch.className = 'le-layer-swatch';
      swatch.style.background = SWATCH[widget.type] ?? 'var(--muted)';

      const name = document.createElement('span');
      name.className = 'le-layer-name';
      name.textContent = nameOf(widget);

      line.append(grip, swatch, name);
      line.addEventListener('click', () => selectWidget(widget.id));
      layersPanel.appendChild(line);
    };
    for (const widget of topLevelWidgets(state.widgets).sort((a, b) => b.z - a.z)) {
      row(widget, '');
      for (const child of (children.get(widget.id) ?? []).slice().sort((a, b) => b.z - a.z)) row(child, widget.id);
    }
  }

  /**
   * Drag a layer row to restack. The dragged row follows the pointer; the row it
   * is over decides the new order, and z is reassigned from the list on release
   * so the canvas stacking matches the list. Pointer-based, like the canvas drag,
   * for the same reason — a synthetic pointer and a drag that leaves the row.
   */
  function startReorder(event: PointerEvent, widget: Widget, scope: string): void {
    event.preventDefault();
    event.stopPropagation();
    // Restacking is a mutation, so it is one step back like any other.
    record();
    // Front-first working order of ids, within this row's scope: the layout's
    // own boxes, or one group's children (RFC 014 §5.1).
    const inScope = (w: Widget): boolean => (scope === '' ? parentIdOf(w) === undefined : parentIdOf(w) === scope);
    let order = state.widgets.filter(inScope).sort((a, b) => b.z - a.z).map((w) => w.id);

    const move = (moveEvent: PointerEvent): void => {
      const rows = Array.from(layersPanel.querySelectorAll<HTMLElement>('.le-layer')).filter(
        (row) => (row.dataset['scope'] ?? '') === scope,
      );
      // Which row is the pointer over? Insert the dragged id before it.
      let target = order.length;
      for (let index = 0; index < rows.length; index++) {
        const rect = rows[index]!.getBoundingClientRect();
        if (moveEvent.clientY < rect.top + rect.height / 2) {
          target = index;
          break;
        }
      }
      const from = order.indexOf(widget.id);
      if (from === -1) return;
      // Account for the removal shifting indices when moving downward.
      const insertAt = target > from ? target - 1 : target;
      if (insertAt === from) return;
      order.splice(from, 1);
      order.splice(insertAt, 0, widget.id);
      // Reflect the tentative order live, so the list follows the pointer.
      const byId = new Map(state.widgets.map((w) => [w.id, w]));
      order = order.filter((id) => byId.has(id));
      order.forEach((id, index) => {
        const w = byId.get(id);
        if (w !== undefined) w.z = order.length - 1 - index;
      });
      selection = [widget.id];
      drawLayers();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draw();
      settle();
      markDirty();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * The canvas background control: none, a solid colour, or a two-stop gradient.
   * A property of the active canvas, so it is redrawn on an orientation switch.
   */
  function drawBackgroundPanel(): void {
    backgroundPanel.textContent = '';
    const kick = document.createElement('span');
    kick.className = 'le-bg-label';
    kick.textContent = 'Background';
    backgroundPanel.appendChild(kick);

    const kind = state.background?.type ?? 'none';
    const select = document.createElement('select');
    for (const [value, label] of [
      ['none', 'None'], ['solid', 'Solid colour'], ['gradient', 'Gradient'], ['image', 'Image'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (kind === value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      record();
      if (select.value === 'solid') state.background = { type: 'solid', color: '#111820' };
      else if (select.value === 'gradient') {
        state.background = { type: 'gradient', from: '#0B0E11', to: '#242D38', angle: 180 };
      } else if (select.value === 'image') {
        // Empty until a picture is chosen; saved as "no background" until then.
        state.background = { type: 'image', image: '' };
      } else state.background = undefined;
      drawBackgroundPanel();
      renderPreview();
      markDirty();
    });
    backgroundPanel.appendChild(select);

    const colour = (value: string, onChange: (v: string) => void): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#111820';
      input.addEventListener('change', () => {
        record();
        onChange(input.value);
        renderPreview();
        markDirty();
      });
      return input;
    };

    const bg = state.background;
    if (bg?.type === 'image') {
      backgroundPanel.appendChild(
        mediaPicker(bg.image === '' ? undefined : bg.image, (name) => {
          record();
          state.background = { type: 'image', image: name };
          renderPreview();
          markDirty();
        }),
      );
    } else if (bg?.type === 'solid') {
      backgroundPanel.appendChild(colour(bg.color, (v) => { bg.color = v; }));
    } else if (bg?.type === 'gradient') {
      backgroundPanel.appendChild(colour(bg.from, (v) => { bg.from = v; }));
      backgroundPanel.appendChild(colour(bg.to, (v) => { bg.to = v; }));
      const angle = document.createElement('input');
      angle.type = 'number';
      angle.min = '0';
      angle.max = '359';
      angle.value = String(bg.angle);
      angle.title = 'Gradient angle in degrees';
      angle.addEventListener('change', () => {
        record();
        const n = Math.round(Number(angle.value));
        bg.angle = Number.isFinite(n) ? ((n % 360) + 360) % 360 : 180;
        renderPreview();
        markDirty();
      });
      backgroundPanel.appendChild(angle);
    }
  }

  /*
   * Keep the preview fitted to the canvas, whoever resized it.
   *
   * The preview is the wall rendered at a reference resolution and scaled into
   * the canvas with a transform computed *at render time* from the canvas box
   * (see `renderPreview`). So a canvas that changes size without a re-render
   * keeps the scale it was given, for ever — and closing the widget sheet did
   * exactly that: the canvas grew back to full size while the preview stayed at
   * the sheet-sized scale, a small picture in the corner of a big empty box,
   * with nothing in the editor that would ever put it right. Opening only
   * looked correct by accident, because the tap that opens the inspector ends
   * in a pointer release that re-renders.
   *
   * This is an observer rather than a `renderPreview()` beside every
   * `sizeCanvas()` because the fit is a fact about the geometry, not a step in
   * a routine somebody has to remember: the canvas is sized from three places
   * today and the next one would have the same bug. `draw()` still renders
   * directly, for a different reason — it rebuilds the *content*, and that has
   * to happen in the same frame as the edit that caused it.
   *
   * Not on a panel: its backdrop is a server-rendered frame stretched to the
   * box by CSS, so it needs no re-fit, and re-rendering would post to the
   * server on every resize.
   */
  if (!epaperHost && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => renderPreview()).observe(canvas);
  }

  /** Everything: size the canvas, redraw the overlay, layers and background, then preview. */
  function draw(): void {
    updateCanvasLabel();
    sizeCanvas();
    drawOverlay();
    drawLayers();
    drawBackgroundPanel();
    renderPreview();
  }

  /**
   * Drop the selection, close the inspector, and — when the person asked for
   * that in so many words (the sheet's Close, or Escape) — put focus back on
   * the widget they came in from, which is a real tab stop on the canvas.
   */
  function clearSelection(restoreFocus: boolean): void {
    const previous = primary();
    selection = [];
    markSelection();
    renderConfigPanel();
    if (!restoreFocus || previous === undefined) return;
    overlay.querySelector<HTMLElement>(`.le-widget[data-id="${previous}"]`)?.focus();
  }

  /**
   * Re-read every box's name from its own options, in place.
   *
   * A widget's name carries the view it is set to, so changing the view has to
   * change the name — on the canvas and in Layers, which are two lists of the
   * same boxes. Found by driving it: the Calendar's picker rebuilt the
   * inspector and nothing else, so a box went on saying "Month grid" while
   * drawing a week. In place rather than a redraw, for the same reason
   * selection is: a rebuild throws away focus and the boxes have not changed.
   */
  function refreshLabels(): void {
    for (const box of overlay.querySelectorAll<HTMLElement>('.le-widget')) {
      const widget = state.widgets.find((one) => one.id === box.dataset['id']);
      if (widget === undefined) continue;
      // Through `describeWidgetIn`, so a group is renamed when a child changes
      // its view — the name is composed from what the group holds.
      const name = nameOf(widget);
      const label = box.querySelector('.le-widget-label');
      if (label !== null) label.textContent = name;
      const omission = omissionOf(widget);
      const why = omission?.why;
      const instead = insteadName(omission);
      /*
       * The flag too, in place (RFC 012 §6.2). A to-do box is flagged by the
       * list its own settings name, and the list is picked in the inspector —
       * so the flag can change on a config write, and until this it was only
       * ever written where the box is *built*. Measured: a box whose list was
       * un-watched stayed marked "Not on the wall" after the household chose
       * the typed items instead, while the preview beneath it had already
       * started drawing the box. The class was stale and the pixels were not,
       * which is the shape of every fault this project records by measuring.
       */
      box.classList.toggle('is-not-drawn', why !== undefined);
      const flag = box.querySelector<HTMLElement>('.le-widget-flag');
      if (why === undefined) {
        flag?.remove();
      } else if (flag !== null) {
        // And its words: a box whose fallback changed says what stands in now.
        flag.textContent = omissionFlag(surfaceWord(), instead);
      } else {
        const made = document.createElement('span');
        made.className = 'le-widget-flag';
        made.textContent = omissionFlag(surfaceWord(), instead);
        // Before the handle, where `buildBox` puts it, so the box's children
        // keep one order however the flag arrived.
        const handle = box.querySelector('.le-handle');
        if (handle !== null) box.insertBefore(made, handle);
        else box.appendChild(made);
      }
      /*
       * The accessible name too, through the same `boxAriaLabel` the box was
       * built with. It used to be skipped on a flagged box, because the longer
       * sentence a flagged box carries was composed only where the flag is —
       * so a Calendar the wall leaves out, switched from a month to an agenda,
       * showed the new name on its chip and went on announcing the old one.
       * The visible half updating is exactly what hid it — and a fallback
       * chosen or switched in the inspector (RFC 014 §5.3) changes this name
       * and nothing a household can see on the box but the flag's words.
       */
      box.setAttribute(
        'aria-label',
        boxAriaLabel(name, why, surfaceWord(), instead, widget.type === 'group' ? 'group' : 'widget'),
      );
    }
    for (const row of layersPanel.querySelectorAll<HTMLElement>('.le-layer')) {
      const widget = state.widgets.find((one) => one.id === row.dataset['id']);
      const name = row.querySelector('.le-layer-name');
      if (widget !== undefined && name !== null) name.textContent = nameOf(widget);
    }
  }

  /**
   * Reflect the selection on the boxes and the layer rows, in place.
   *
   * Selecting used to rebuild the whole overlay (RFC 009 Phase 5). Every box
   * was a new element, so the one that had focus was destroyed by the act of
   * choosing it — which is why the keyboard could select a widget and then do
   * nothing else with it. Two classes and an `aria-pressed` is all a selection
   * ever was; the boxes themselves have not changed.
   */
  function markSelection(): void {
    // A set now (RFC 014 §5.1), and still two classes toggled in place: a
    // Shift+click adds a box without rebuilding the one that has focus.
    for (const box of overlay.querySelectorAll<HTMLElement>('.le-widget')) {
      const on = selection.includes(box.dataset['id'] ?? '');
      box.classList.toggle('is-selected', on);
      box.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const row of layersPanel.querySelectorAll<HTMLElement>('.le-layer')) {
      row.classList.toggle('is-selected', selection.includes(row.dataset['id'] ?? ''));
    }
    refreshGroupButtons();
  }

  /** Shift+click: this box into the selection, or out of it (RFC 014 §5.1). */
  function toggleInSelection(id: string): void {
    selection = toggleSelected(selection, id);
    markSelection();
    drawLayers();
    renderConfigPanel(true);
  }

  // ---- per-widget config ------------------------------------------------

  /**
   * Merge one option into the selected widget's config, dropping empties.
   *
   * On the ink lane the same call writes into `config.ink` instead — one level
   * deep, never nested further, matching `inkOverrideBody` on the server. That
   * is the whole of the two lanes at this end: every control in the editor is
   * unchanged and simply lands in a different place depending on which lane is
   * open. Clearing the last override removes `ink` entirely, so a widget that
   * says nothing different on a panel carries nothing.
   */
  function setConfig(widget: Widget, key: string, value: unknown): void {
    // One step back per option — and a run of writes from one control (a colour
    // committed twice, a title typed) is one step rather than thirty.
    recordRun(`cfg:${lane}:${widget.id}:${key}`);
    const next = setLaneValue(widget.config, lane, key, value);
    if (next !== undefined) widget.config = next;
    else delete widget.config;
    // The name carries the view, so any option write may have renamed the box.
    refreshLabels();
    // A group's layout decides where its children sit, so their boxes follow.
    if (widget.type === 'group') repositionAll();
    markDirty();
    renderPreview();
  }

  /**
   * The config the open lane's controls should show.
   *
   * On the ink lane that is the *effective* value — the wall's setting unless
   * this widget overrides it — so the controls say what the panel will actually
   * draw rather than what has been typed here. Touching one then pins it, which
   * is ordinary override behaviour and is why the lane says how many are pinned
   * and offers to clear them.
   */
  function laneConfig(widget: Widget): Record<string, unknown> {
    return lane === 'ink' ? mergeInk(widget.config) : (widget.config ?? {});
  }

  /**
   * One labelled control in the inspector, optionally naming the config key it
   * writes.
   *
   * The key is what makes the ink lane honest. A panel reads a *subset* of a
   * widget's options, so the lane must show that subset and nothing else — and
   * the safe way round is for an unnamed control to be *hidden* there rather
   * than shown. Annotate the handful of controls the lane offers and everything
   * else disappears from it by default, including anything added later by
   * somebody who never read this comment. `pruneToLane` is the pass that does
   * it.
   */
  function cfgField(label: string, key?: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'le-cfg-field';
    if (key !== undefined) wrap.dataset['cfgKey'] = key;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    return wrap;
  }

  /**
   * Keep only the controls the open lane can honour.
   *
   * Runs after the type's own builder, so the builders stay one implementation
   * for both lanes rather than growing a branch each. On the wall lane it does
   * nothing at all; on the ink lane every direct child without a key this
   * widget's type offers is dropped, hints and headings included — a note about
   * a control that is not there reads as a bug.
   */
  function pruneToLane(type: string): void {
    if (lane !== 'ink') return;
    const allowed = ink?.lane[type] ?? [];
    for (const child of [...configPanel.children]) {
      const key = (child as HTMLElement).dataset['cfgKey'];
      if (key === undefined || !allowed.includes(key)) child.remove();
    }
  }

  /** A set of checkboxes; empty selection means "all", stated where used. */
  function checkList(
    options: readonly { readonly value: string; readonly label: string }[],
    chosen: readonly string[],
    onChange: (values: string[]) => void,
    emptyNote: string,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'le-cfg-checks';
    if (options.length === 0) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = emptyNote;
      box.appendChild(note);
      return box;
    }
    const current = new Set(chosen);
    for (const opt of options) {
      const row = document.createElement('label');
      row.className = 'le-cfg-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = current.has(opt.value);
      input.addEventListener('change', () => {
        if (input.checked) current.add(opt.value);
        else current.delete(opt.value);
        onChange([...current]);
      });
      row.appendChild(input);
      row.appendChild(document.createTextNode(' ' + opt.label));
      box.appendChild(row);
    }
    return box;
  }

  /**
   * The View row, which every widget has and most cannot change.
   *
   * Every type declares its views in `VIEWS`, so the Content tab is never empty
   * and the inspector reads the same from one widget to the next: what it draws,
   * then what it draws it from. A type with one view states it rather than
   * offering a dropdown of one, because a control that cannot be changed is a
   * control that does nothing — and the day a second view exists it becomes a
   * real picker with no other change here.
   */
  function buildViewField(widget: Widget, cfg: Record<string, unknown>): void {
    const views = WIDGET_VIEWS[widget.type] ?? [];
    const first = views[0];
    if (first === undefined) return;

    if (views.length === 1) {
      // Not a <label>: there is no control for it to name.
      const row = document.createElement('div');
      row.className = 'le-cfg-field';
      const name = document.createElement('span');
      name.textContent = 'View';
      const fact = document.createElement('div');
      fact.className = 'le-cfg-fact';
      fact.textContent = first.label;
      row.append(name, fact);
      configPanel.appendChild(row);
      return;
    }

    const field = cfgField('View', 'mode');
    /*
     * A calendar's view is not the string in `mode`.
     *
     * A canvas holding `skyweek` is a *Week columns* widget drawn compactly,
     * and `calendarView` is the one place that is decided — so the picker asks
     * it rather than reading the raw value, and writes the whole pair back
     * through `setCalendarShape`. Reading `mode` here would have shown "Month
     * grid" for `skymonth` by the accident of the unknown-means-default
     * fallback below, and then written a view beside a legacy value that
     * already carried one.
     */
    const shape = widget.type === 'calendar' ? calendarView(cfg) : undefined;
    const current =
      shape !== undefined
        ? shape.view
        : typeof cfg['mode'] === 'string'
          ? (cfg['mode'] as string)
          : first.value;
    const select = document.createElement('select');
    for (const view of views) {
      const option = document.createElement('option');
      option.value = view.value;
      option.textContent = view.label;
      if (view.value === current) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      // The default view is stored as an absence, exactly as `mode` always was.
      if (shape !== undefined) setCalendarShape(widget, select.value as CalendarView, shape.density);
      else setConfig(widget, 'mode', select.value === first.value ? undefined : select.value);
      // Which options apply depends on the view, so the panel is rebuilt.
      renderConfigPanel();
    });
    field.appendChild(select);
    configPanel.appendChild(field);
  }

  /**
   * Write a calendar's view and its density together, as the one pair they are.
   *
   * Both keys or neither, and each stored as an *absence* at its default
   * (`month`, `comfortable`). That is what stops a half-written config existing
   * at all: a widget holding a legacy `skymonth` already carries both halves in
   * one string, so writing only the density beside it would leave `skymonth`
   * winning and the control springing back — and writing only the view would
   * leave a compact widget that had quietly become comfortable. Touch either
   * control and the pair is written canonically, which is also how the legacy
   * value leaves a canvas: when the household edits it, and never behind their
   * back.
   *
   * One `recordRun` key for the pair, so one press is one step back rather
   * than two.
   */
  function setCalendarShape(widget: Widget, view: CalendarView, density: CalendarDensity): void {
    recordRun(`cfg:${lane}:${widget.id}:calendar-shape`);
    let next = setLaneValue(widget.config, lane, 'mode', view === 'month' ? undefined : view);
    /*
     * The density is a wall setting and the ink lane may not carry it: it is
     * not in `INK_KEYS`, so `inkOverrideBody` would reject the save outright.
     * The lane offers the View picker and no Density control, and this is the
     * other half of that — a panel draws one density because it has no gaps or
     * cards to give up (`PANEL_IGNORES`).
     */
    if (lane !== 'ink') {
      next = setLaneValue(next, lane, 'density', density === 'comfortable' ? undefined : density);
    }
    if (next !== undefined) widget.config = next;
    else delete widget.config;
    refreshLabels();
    markDirty();
    renderPreview();
  }

  /** True where the inspector is the phone's bottom sheet rather than a column. */
  function inspectorIsSheet(): boolean {
    if (inspectorInline) return false;
    try {
      return window.matchMedia('(max-width: 1199px)').matches;
    } catch {
      return false;
    }
  }

  function openInspector(keepFocus = false): void {
    const wasOpen = inspectorHost.classList.contains('is-open');
    inspectorEmpty.hidden = true;
    inspectorHead.hidden = false;
    inspectorBody.hidden = false;
    inspectorHost.classList.add('is-open');
    if (wasOpen || !inspectorIsSheet()) return;
    /*
     * The sheet takes the foot of the screen, so the canvas above it shrinks to
     * stay visible — the preview is what you are editing against, and a
     * widget's settings that hide it are settings for something you cannot see.
     *
     * Both halves are needed and the second is the one that is easy to miss:
     * the class opens up enough page below the canvas to scroll it clear. The
     * first version only scrolled, and on a short page there was nothing to
     * scroll into — the canvas sat behind the sheet exactly as before, which
     * looks like the shrink not working.
     */
    document.documentElement.classList.add('mw-insp-open');
    sizeCanvas();
    // Not scrollIntoView({block:'center'}): centring a canvas in a viewport
    // whose bottom half is the sheet puts half of it behind the sheet. Its top
    // goes just below the sticky app bar, where the whole of it is visible.
    const top = window.scrollY + canvas.getBoundingClientRect().top - 88;
    window.scrollTo(0, Math.max(0, top));
    if (!keepFocus) inspectorClose.focus();
  }

  function closeInspector(): void {
    const wasOpen = inspectorHost.classList.contains('is-open');
    inspectorHost.classList.remove('is-open');
    inspectorHead.hidden = true;
    inspectorBody.hidden = true;
    inspectorEmpty.hidden = false;
    document.documentElement.classList.remove('mw-insp-open');
    if (wasOpen && inspectorIsSheet()) sizeCanvas();
  }

  /**
   * Select a widget from anywhere — a tap, the keyboard, the layers list.
   *
   * `keepFocus` is for the keyboard: an arrow key selects the box it is moving,
   * and focus has to stay on that box or the next arrow key goes to the
   * document. On a phone the inspector is a sheet and opening it normally takes
   * focus, which is right for a tap and wrong for a nudge.
   */
  function selectWidget(id: string, keepFocus = false): void {
    selection = [id];
    markSelection();
    renderConfigPanel(keepFocus);
  }

  function renderConfigPanel(keepFocus = false): void {
    configPanel.textContent = '';
    ladderPanels = [];
    boxFields = undefined;
    /*
     * What this panel should show, decided in `inspector.ts` and drawn here.
     *
     * Every question it answers used to be answered in the middle of building
     * the DOM — whether there is anything to show, what the widget is called,
     * whether the lane switch appears, which lane is actually in force,
     * whether this box is one the wall leaves out, and which tab supplies the
     * body. There is no DOM in this package's test suite, so none of them
     * could be asked without a browser.
     */
    const chosen = primary();
    const view = inspectorView({
      widgets: state.widgets,
      selected: chosen,
      selection,
      lane,
      inkAvailable: ink !== undefined,
      tab: inspectorTab,
      notDrawn: notDrawn(),
      facts: omissionFacts,
      surface: surfaceWord(),
      ...(chosen === undefined ? {} : { drawnTier: drawnTierOf(chosen) }),
    });
    if (view.kind === 'empty') {
      closeInspector();
      return;
    }
    /*
     * Two or more boxes (RFC 014 §5.1): the shared style lane, and nothing
     * else — no tabs, no lane switch, no Duplicate, no Remove. One colour
     * chosen here lands on every selected box in one undo step.
     */
    if (view.kind === 'multi') {
      inspectorTitle.textContent = view.title;
      laneBar.hidden = true;
      lane = 'wall';
      inspectorTabs.hidden = true;
      inspectorActions.hidden = true;
      inspectorDanger.hidden = true;
      const targets = view.widgetIds
        .map((id) => state.widgets.find((w) => w.id === id))
        .filter((w): w is Widget => w !== undefined);
      buildStyleLane(targets, targets[0]?.config ?? {});
      openInspector(keepFocus);
      return;
    }
    // The widget the view describes — the same object, because everything
    // below mutates it. `inspectorView` found it in this very list.
    const widget = state.widgets.find((w) => w.id === view.widgetId)!;

    // Which widget this is, said outright. The panel used to open with
    // "Clock options" buried under the canvas, with the wall's own settings
    // running on directly beneath it.
    inspectorTitle.textContent = view.title;
    removeButton.textContent = view.removeLabel;

    /*
     * The lane switch, when a panel follows this canvas.
     *
     * The ink lane has no Content/Style split: a panel honours a handful of
     * keys and they are one short list, so two tabs over them would be two
     * mostly-empty tabs. The tabs come back with the wall lane.
     */
    laneBar.hidden = !view.laneBarVisible;
    lane = view.lane;
    markTabs([laneButtons.wall, laneButtons.ink], (tab) => tab.dataset['lane'], lane, 'is-on');
    laneButtons.ink.classList.toggle('has-override', view.hasInkOverrides);

    if (view.lane === 'ink') {
      renderInkPanel(widget);
      openInspector(keepFocus);
      return;
    }

    /*
     * Why this one is not on the wall, above everything else in the panel.
     *
     * There is no point reading a widget's options while nothing draws it, and
     * this is the answer to "I put a Weather box on and my wall has not got
     * one" — the question the omission would otherwise leave a household with.
     * On the wall lane only: the ink lane is about what a panel says
     * differently, and it rebuilds this panel for itself.
     */
    if (view.note !== undefined) {
      const note = document.createElement('p');
      note.className = 'le-not-drawn';
      note.textContent = view.note;
      configPanel.appendChild(note);
    }
    if (view.fallback !== undefined) buildFallbackConfig(widget, view.fallback);

    /*
     * And what this box has room to say, which is a fact about the size the
     * household dragged it to rather than about anything they can set here.
     *
     * Read back out of the preview — see `drawnTierOf` — for the reason the
     * ladder's strike-through is: the preview renders the household's real
     * manifest through the wall's own `renderFreeform`, which is what resolves
     * the tier, so reading what it drew is the same answer the screen gives.
     * A second opinion about what fits is the whole class of bug this project
     * keeps finding, and one with a rung's name on it would be that bug wearing
     * a label.
     */
    if (view.density !== undefined) {
      const density = document.createElement('p');
      density.className = 'hint le-density';
      density.textContent = view.density;
      configPanel.appendChild(density);
    }
    // A child whose place is its group's order (RFC 014 §5.1): said here, and
    // the position fields are not drawn — `buildBoxFields` reads this.
    orderedChildNote = view.placement;
    if (view.placement !== undefined) {
      const note = document.createElement('p');
      note.className = 'hint le-ordered';
      note.textContent = view.placement;
      configPanel.appendChild(note);
    }

    // Both tabs, always: every widget has a view to state, so neither tab is
    // ever empty and the inspector reads the same whichever widget is open.
    inspectorTabs.hidden = false;
    inspectorDanger.hidden = false;
    inspectorActions.hidden = false;
    markTabs(
      [inspectorTabButtons.content, inspectorTabButtons.style],
      (tab) => tab.dataset['tab'],
      inspectorTab,
      'is-on',
    );

    // Layering moved to the Layers list (drag a row to restack); the
    // per-widget front/back buttons it replaces are gone.
    const cfg = widget.config ?? {};
    if (view.tab === 'content') buildTypeConfig(widget, cfg);
    else {
      // Style is the same set of controls for every widget — one
      // implementation, writing the same per-widget keys it always has.
      buildFormatConfig(widget, cfg);
    }
    openInspector(keepFocus);
  }

  /**
   * "When this has nothing to show" (RFC 014 §5.3): leave the box empty, as it
   * always was, or show another widget in its rectangle.
   *
   * Substitution only. The box keeps its rectangle whatever it draws, so the
   * canvas the household arranged is the canvas on the wall and a panel's
   * refresh regions do not move; giving the room to a neighbour is a different
   * decision and is not offered.
   *
   * Written as one `whenEmpty` object through `setConfig`, so it is one undo
   * step per edit and a typed run of a note is one step, and read back through
   * `fallbackOf` — the same reading the preview substitutes from. The content
   * controls are each type's minimum: what the fallback *says*, never how it
   * is dressed — a note's words, a countdown's name and date, a checklist's
   * lines. Every other type draws what the household has already set up, and
   * the picker never offers one the wall would leave out too.
   */
  function buildFallbackConfig(
    widget: Widget,
    offer: { readonly current: string | undefined; readonly choices: readonly string[] },
  ): void {
    const chosen = fallbackOf(widget.config);
    const write = (next: Fallback | undefined): void => {
      const own = next?.config;
      setConfig(
        widget,
        'whenEmpty',
        next === undefined
          ? undefined
          : own !== undefined && Object.keys(own).length > 0
            ? { type: next.type, config: own }
            : { type: next.type },
      );
    };
    const first = offer.choices[0];
    const section = document.createElement('div');
    section.className = 'le-fallback';
    section.appendChild(
      segControl(
        'When this has nothing to show',
        first === undefined
          ? [['empty', 'Leave the box empty']]
          : [['empty', 'Leave the box empty'], ['other', 'Show another widget']],
        chosen === undefined ? 'empty' : 'other',
        (value) => {
          if (value === 'empty') write(undefined);
          else if (chosen === undefined && first !== undefined) write({ type: first });
        },
      ),
    );
    configPanel.appendChild(section);
    if (chosen === undefined) return;

    const typeField = cfgField('Show instead');
    const select = document.createElement('select');
    select.className = 'le-fallback-type';
    for (const type of offer.choices) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = labelFor(type);
      if (type === chosen.type) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      // The content carries across: one strict object for every type, and a
      // key a type does not read is simply not read — so a note's words
      // survive a look at the countdown and back. Read *now*, not from
      // `chosen`: the text areas below write without rebuilding this panel,
      // so what was captured when it was built is missing everything typed
      // since — measured, a switch dropped the note it had just been given.
      write({ type: select.value, config: fallbackOf(widget.config)?.config });
      renderConfigPanel();
    });
    typeField.appendChild(select);
    section.appendChild(typeField);

    const own = chosen.config ?? {};
    const setOwn = (key: string, value: unknown): void => {
      const next: Record<string, unknown> = { ...(fallbackOf(widget.config)?.config ?? {}) };
      const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
      if (empty) delete next[key];
      else next[key] = value;
      write({ type: chosen.type, config: next });
    };
    const text = (label: string, key: string, rows: number, max: number, hint: string): void => {
      const field = cfgField(label);
      const area = document.createElement('textarea');
      area.rows = rows;
      area.maxLength = max;
      area.placeholder = hint;
      const stored = own[key];
      area.value = Array.isArray(stored) ? (stored as string[]).join('\n') : typeof stored === 'string' ? stored : '';
      area.addEventListener('input', () => {
        if (key === 'items') {
          const lines = area.value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
          setOwn(key, lines.slice(0, 40));
        } else setOwn(key, area.value);
      });
      field.appendChild(area);
      section.appendChild(field);
    };
    if (chosen.type === 'notes') {
      text('Note', 'text', 4, 2000, 'What the wall should say in this box instead.');
    } else if (chosen.type === 'todo') {
      text('Items (one per line)', 'items', 5, 4000, 'Pick up milk\nPut the bins out');
    } else if (chosen.type === 'countdown') {
      const nameField = cfgField('Counting down to');
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 60;
      name.placeholder = 'e.g. Summer holiday';
      name.value = typeof own['title'] === 'string' ? (own['title'] as string) : '';
      name.addEventListener('change', () => setOwn('title', name.value.trim()));
      nameField.appendChild(name);
      section.appendChild(nameField);
      const dateField = cfgField('Date');
      const date = document.createElement('input');
      date.type = 'date';
      date.value = typeof own['target'] === 'string' ? (own['target'] as string) : '';
      date.addEventListener('change', () =>
        setOwn('target', /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : undefined),
      );
      dateField.appendChild(date);
      section.appendChild(dateField);
    } else {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = `Drawn as a new ${labelFor(chosen.type).toLowerCase()} widget would be, from what is already set up.`;
      section.appendChild(hint);
    }
  }

  /** The type's own controls — the Content tab, and the ink lane's raw material. */
  function buildTypeConfig(widget: Widget, cfg: Record<string, unknown>): void {
    buildViewField(widget, cfg);
    if (widget.type === 'group') buildGroupConfig(widget, cfg);
    else if (widget.type === 'calendar') buildCalendarConfig(widget, cfg);
    else if (widget.type === 'homeassistant') buildHaConfig(widget, cfg);
    else if (widget.type === 'countdown') buildCountdownConfig(widget, cfg);
    else if (widget.type === 'external') buildExternalConfig(widget, cfg);
    else if (widget.type === 'notes') buildNotesConfig(widget, cfg);
    else if (widget.type === 'todo') buildTodoConfig(widget, cfg);
    else if (widget.type === 'chores') buildChoresConfig(widget, cfg);
    else if (widget.type === 'image') buildImageConfig(widget, cfg);
    else if (widget.type === 'shift') buildShiftConfig(widget, cfg);
    else if (widget.type === 'clock') buildClockConfig(widget, cfg);
    else if (widget.type === 'weather') buildWeatherConfig(widget, cfg);
  }

  /**
   * A group's own settings (RFC 014 §5.1): how it lays its children out, and
   * how many across when that is a grid. `free` keeps each child where it
   * was; the other three place from the group's order, which is the Layers
   * list's order and what an arrow key or a drag on a child changes.
   *
   * Written out in full rather than as an absence — `row` is what an absent
   * layout means, but a household who chose it has chosen it, and a group
   * made by Group is `free` on purpose. Both keys are annotated, which is the
   * default every control here takes; whether the ink lane *offers* them is
   * the server's table (`INK_LANE`), which lists nothing for a group today —
   * a panel lays a group out exactly as its wall does — so `pruneToLane`
   * drops both there until that table says otherwise.
   */
  function buildGroupConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const layoutNames: Readonly<Record<string, string>> = { free: 'Free', row: 'Row', column: 'Column', grid: 'Grid' };
    const current = typeof cfg['layout'] === 'string' && (GROUP_LAYOUTS as readonly string[]).includes(cfg['layout'] as string)
      ? (cfg['layout'] as string)
      : 'row';
    configPanel.appendChild(
      segControl(
        'Arrange the widgets in it',
        ['free', 'row', 'column', 'grid'].map((layout) => [layout, layoutNames[layout] ?? layout] as const),
        current,
        (value) => setConfig(widget, 'layout', value),
        'layout',
      ),
    );
    if (current === 'grid') {
      const columns = typeof cfg['columns'] === 'number' ? String(cfg['columns']) : '2';
      configPanel.appendChild(
        segControl(
          'Across',
          [['2', '2'], ['3', '3'], ['4', '4']],
          columns,
          (value) => setConfig(widget, 'columns', value === '2' ? undefined : Number(value)),
          'columns',
        ),
      );
    }
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Colours and type chosen on the Style tab reach every widget in the group unless one sets its own.';
    configPanel.appendChild(hint);
  }

  /** The sentence for a child of an ordered group, set per render; the box fields read it. */
  let orderedChildNote: string | undefined;

  /**
   * The ink lane: what this widget says differently in black and white.
   *
   * The same controls the wall lane draws, built by the same builders against
   * the *effective* ink config, and then cut down to the keys a panel actually
   * honours (`pruneToLane`). Building both the type's controls and the format
   * ones is deliberate: alignment is a format control and a panel does honour
   * it, so gating by tab would have hidden a working setting while showing
   * nothing in its place.
   *
   * What is *not* offered is as considered as what is. A panel's title, note,
   * picture, module and countdown date are the wall's — a household looking at
   * two screens has to be able to believe they are showing the same canvas, so
   * the lane changes how much a widget says and never what it is.
   */
  function renderInkPanel(widget: Widget): void {
    inspectorTabs.hidden = true;
    // Removing or copying a widget here would remove or copy it on the wall,
    // which is not what "on ink" means anywhere else on this panel.
    inspectorDanger.hidden = true;
    inspectorActions.hidden = true;

    const panel = inkPanelForCanvas();
    if (panel === undefined) {
      /*
       * A panel follows this wall, but it draws the *other* canvas.
       *
       * Said rather than hidden: a lane that quietly disappeared on one
       * orientation would read as a bug, and a lane that stayed and worked
       * would be writing overrides onto widget rows the panel never reads.
       */
      const other = ink?.panels[0];
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent =
        other === undefined
          ? 'No panel is drawing this layout.'
          : `${other.name} draws the ${other.orientation} layout. Switch the layout above to ` +
            `${other.orientation === 'landscape' ? 'Landscape' : 'Portrait'} to change what it says there.`;
      configPanel.appendChild(note);
      return;
    }

    const head = document.createElement('p');
    head.className = 'hint insp-ink-head';
    const others = (ink?.panels.length ?? 1) - 1;
    head.textContent =
      `What this widget says on ${panel.name} — ${panel.width}×${panel.height}, black & white.` +
      (others > 0 ? ` And on ${others} other panel${others > 1 ? 's' : ''}.` : '');
    configPanel.appendChild(head);

    /*
     * The real frame, not a drawing of one.
     *
     * The same `preview.png` the panel's own designer uses: the canvas as it
     * stands is posted and the server answers with the exact frame the device
     * would put on glass. Two renderers disagreeing is the fault this endpoint
     * was built for, and reaching for a second 1-bit renderer in the browser
     * here would have reintroduced it.
     */
    const frame = document.createElement('img');
    frame.className = 'insp-ink-frame';
    frame.alt = `${panel.name} as it will draw this layout`;
    if (inkObjectUrl !== undefined) frame.src = inkObjectUrl;
    inkImage = frame;
    configPanel.appendChild(frame);
    scheduleInkFrame();

    const offered = ink?.lane[widget.type] ?? [];
    if (offered.length === 0) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent =
        'This widget draws the same on a panel as on the wall — there is nothing here worth ' +
        'saying differently in black and white.';
      configPanel.appendChild(none);
    } else {
      const cfg = laneConfig(widget);
      buildTypeConfig(widget, cfg);
      buildFormatConfig(widget, cfg);
      pruneToLane(widget.type);
      // Put the heading and the frame back: `pruneToLane` drops everything it
      // was not told about, which is the right default and takes these with it.
      configPanel.insertBefore(frame, configPanel.firstChild);
      configPanel.insertBefore(head, configPanel.firstChild);
      // The Look leads here as it leads the Style tab: it is the largest thing
      // the lane can change, and the type's own rows are built before it.
      const look = configPanel.querySelector<HTMLElement>(':scope > [data-cfg-key="variant"]');
      if (look !== null) configPanel.insertBefore(look, frame.nextSibling);
    }

    /*
     * What the panel will not draw, said where the setting was made.
     *
     * Only the ones this widget actually has set — a list of everything a panel
     * cannot do would be a wall of text on every widget, and a household who
     * never set a shadow does not need to be told about shadows. This is the
     * "states what it cannot honour" half of the lane, and the reason it is
     * here rather than on the wall lane is that this is the screen the sentence
     * is about.
     */
    const wall = widget.config ?? {};
    /*
     * A key one level down — `style.<key>`, the style lane's spelling in both
     * honours tables (RFC 014 §4.1) — is looked up inside `style`; anything
     * else is a top-level key as before. And the lane's entries are folded by
     * their reason, so a widget with eleven colours set reads one line about
     * colour rather than eleven.
     */
    const isSet = (key: string): boolean => {
      if (!key.startsWith('style.')) return wall[key] !== undefined;
      const lane = wall['style'];
      return typeof lane === 'object' && lane !== null &&
        (lane as Record<string, unknown>)[key.slice('style.'.length)] !== undefined;
    };
    const ignored = (ink?.ignores ?? []).filter((entry) => isSet(entry.key));
    if (ignored.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'hint insp-ink-note';
      heading.textContent = 'Set on the wall, not drawn here:';
      configPanel.appendChild(heading);
      const list = document.createElement('ul');
      list.className = 'insp-ink-list';
      const folded = new Map<string, string[]>();
      for (const entry of ignored) {
        const labels = folded.get(entry.why) ?? [];
        labels.push(entry.label);
        folded.set(entry.why, labels);
      }
      for (const [why, labels] of folded) {
        const row = document.createElement('li');
        row.textContent = `${labels.join(', ')} — ${why}`;
        list.appendChild(row);
      }
      configPanel.appendChild(list);
    }

    const overrides = Object.keys(inkOf(widget.config));
    if (overrides.length > 0) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn-ghost insp-ink-reset';
      reset.textContent =
        overrides.length === 1 ? 'Match the wall again (1 change)' : `Match the wall again (${overrides.length} changes)`;
      reset.addEventListener('click', () => {
        // Every override at once, and unrecoverable without this: it was the
        // one mutation in this file that took no step back.
        record();
        const cfgNow: Record<string, unknown> = { ...(widget.config ?? {}) };
        delete cfgNow['ink'];
        if (Object.keys(cfgNow).length > 0) widget.config = cfgNow;
        else delete widget.config;
        markDirty();
        renderConfigPanel();
        renderPreview();
      });
      configPanel.appendChild(reset);
    }
  }

  function buildExternalConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('Module');
    if (state.modules.length === 0) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'No modules yet — add one on the Store page first.';
      field.appendChild(note);
      configPanel.appendChild(field);
      return;
    }
    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose a module…';
    select.appendChild(none);
    for (const module of state.modules) {
      const opt = document.createElement('option');
      opt.value = module.id;
      opt.textContent = module.name;
      if (cfg['module'] === module.id) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => setConfig(widget, 'module', select.value || undefined));
    field.appendChild(select);
    configPanel.appendChild(field);

    /*
     * How many of the module's rows to draw.
     *
     * A module decides its own panel's shape and may send twelve readings; this
     * is the household deciding how many fit the box they dragged. It is
     * presentation of data the module already sent — nothing new is asked of it.
     */
    const rows = cfgField('How many rows', 'count');
    const count = document.createElement('input');
    count.type = 'number';
    count.min = '1';
    count.max = '12';
    count.placeholder = 'All of them';
    count.value = typeof cfg['count'] === 'number' ? String(cfg['count']) : '';
    count.addEventListener('change', () => {
      const n = Math.round(Number(count.value));
      setConfig(widget, 'count', Number.isFinite(n) && n >= 1 ? Math.min(12, n) : undefined);
    });
    rows.appendChild(count);
    configPanel.appendChild(rows);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Only applies to a module that sends a list.';
    note.dataset['cfgKey'] = 'count';
    configPanel.appendChild(note);
  }

  function buildCountdownConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const nameField = cfgField('Counting down to');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 60;
    name.placeholder = 'e.g. Summer holiday';
    // The label is the widget title, so it round-trips with the Format title.
    name.value = typeof cfg['title'] === 'string' ? (cfg['title'] as string) : '';
    name.addEventListener('change', () => setConfig(widget, 'title', name.value.trim()));
    nameField.appendChild(name);
    configPanel.appendChild(nameField);

    const dateField = cfgField('Date');
    const date = document.createElement('input');
    date.type = 'date';
    date.value = typeof cfg['target'] === 'string' ? (cfg['target'] as string) : '';
    date.addEventListener('change', () =>
      setConfig(widget, 'target', /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : undefined),
    );
    dateField.appendChild(date);
    configPanel.appendChild(dateField);
  }

  /**
   * The image picker, shared by the Image widget and the image background
   * (RFC 005 Phase 3b): a grid of the household's uploaded pictures plus an
   * upload. Reads the list behind the session; on a pick or a fresh upload it
   * calls back with the stored name. Rule three throughout — every image is the
   * household's own, served from the media store, never an external URL.
   */
  function mediaPicker(current: string | undefined, onPick: (name: string) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'le-media';
    const grid = document.createElement('div');
    grid.className = 'le-media-grid';
    const status = document.createElement('span');
    status.className = 'le-media-status';

    let selected = current;
    let images: { name: string; originalName: string }[] = [];

    const drawGrid = (): void => {
      grid.textContent = '';
      if (images.length === 0) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = 'No pictures yet — upload one below.';
        grid.appendChild(note);
        return;
      }
      for (const img of images) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'le-media-item' + (img.name === selected ? ' is-on' : '');
        button.style.backgroundImage = `url("admin/media/${img.name}")`;
        button.title = img.originalName;
        button.addEventListener('click', () => {
          selected = img.name;
          onPick(img.name);
          drawGrid();
        });
        grid.appendChild(button);
      }
    };

    void fetch('admin/media/list')
      .then((r) => (r.ok ? r.json() : { images: [] }))
      .then((data: { images?: { name: string; originalName: string }[] }) => {
        images = Array.isArray(data.images) ? data.images : [];
        drawGrid();
      })
      .catch(() => drawGrid());

    const label = document.createElement('label');
    label.className = 'le-media-upload';
    label.appendChild(document.createTextNode('Upload a picture'));
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/gif,image/webp';
    file.addEventListener('change', () => {
      const picked = file.files?.[0];
      if (picked === undefined) return;
      status.textContent = 'Uploading…';
      const form = new FormData();
      form.append('image', picked);
      void fetch('admin/media/upload', { method: 'POST', body: form })
        .then((r) => r.json())
        .then((data: { ok?: boolean; name?: string; message?: string }) => {
          if (data.ok === true && typeof data.name === 'string') {
            if (!images.some((i) => i.name === data.name)) {
              images.unshift({ name: data.name, originalName: picked.name });
            }
            selected = data.name;
            onPick(data.name);
            drawGrid();
            status.textContent = '';
          } else {
            status.textContent = data.message ?? 'That did not upload.';
          }
        })
        .catch(() => { status.textContent = 'Could not reach the server.'; });
      file.value = '';
    });
    label.appendChild(file);

    wrap.append(grid, label, status);
    return wrap;
  }

  function buildImageConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('Picture');
    const current = typeof cfg['image'] === 'string' ? (cfg['image'] as string) : undefined;
    field.appendChild(mediaPicker(current, (name) => setConfig(widget, 'image', name)));
    configPanel.appendChild(field);
  }

  function buildNotesConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('Note');
    const area = document.createElement('textarea');
    area.rows = 5;
    area.maxLength = 2000;
    area.placeholder = 'Anything the wall should show — one line per line.';
    area.value = typeof cfg['text'] === 'string' ? (cfg['text'] as string) : '';
    area.addEventListener('input', () => setConfig(widget, 'text', area.value));
    field.appendChild(area);
    configPanel.appendChild(field);
  }

  /**
   * The Chores widget's own options: whose to show.
   *
   * By person *id*, which is the same key and the same meaning the Shift
   * widget's "Whose rota" uses — one config key must not mean two things, and
   * an id survives a rename where a name does not. None ticked shows everybody,
   * including the chores nobody owns, and that is stated rather than left to be
   * discovered.
   *
   * There is no count here and no "hide the done ones". A household's chores in
   * a day are few, and a board that hides what has been done cannot be used to
   * check that it was.
   */
  function buildChoresConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const which = cfgField('Whose chores to show', 'people');
    which.appendChild(
      checkList(
        state.people.map((person) => ({ value: person.id, label: person.name })),
        Array.isArray(cfg['people']) ? (cfg['people'] as string[]) : [],
        (values) => setConfig(widget, 'people', values),
        'No people yet — add them on the People page.',
      ),
    );
    configPanel.appendChild(which);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'None ticked shows everybody, including chores nobody owns.';
    configPanel.appendChild(note);
  }

  /**
   * The To-do widget: the lines the household types, or a Home Assistant list
   * (RFC 012 phase 1).
   *
   * One picker decides which. Choosing a list hides the textarea and choosing
   * "The items typed below" hides the list's switch — but a stored `items`
   * array is **left untouched** either way, so a household who tries a list
   * and comes back finds their lines where they left them. The wall reads
   * `list` absent as the typed items, so clearing the picker is the whole of
   * going back.
   */
  function buildTodoConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const chosen = todoListOf(cfg);
    const picker = cfgField('Show', 'list');
    const select = document.createElement('select');
    const typed = document.createElement('option');
    typed.value = '';
    typed.textContent = 'The items typed below';
    select.appendChild(typed);
    for (const list of state.todoLists) {
      const opt = document.createElement('option');
      opt.value = list.id;
      opt.textContent = `${list.name} — from Home Assistant`;
      if (chosen === list.id) opt.selected = true;
      select.appendChild(opt);
    }
    // A list this page was not told about — un-watched since the widget was
    // saved — is still shown as chosen, so the picker says what is stored
    // rather than quietly falling back to the first option.
    if (chosen !== undefined && !state.todoLists.some((list) => list.id === chosen)) {
      const gone = document.createElement('option');
      gone.value = chosen;
      gone.textContent = 'A list no longer on Home Assistant';
      gone.selected = true;
      select.appendChild(gone);
    }
    picker.appendChild(select);
    configPanel.appendChild(picker);
    if (state.todoLists.length === 0) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'To show a Home Assistant to-do list, add one on the Home Assistant page first.';
      configPanel.appendChild(note);
    }

    const field = cfgField('Items (one per line)', 'items');
    const area = document.createElement('textarea');
    area.rows = 6;
    area.maxLength = 4000;
    area.placeholder = 'Pick up milk\nWalk the dog\nPut the bins out';
    const items = Array.isArray(cfg['items']) ? (cfg['items'] as string[]) : [];
    area.value = items.join('\n');
    area.addEventListener('input', () => {
      const lines = area.value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      // Cap to the schema's limit so a paste of a hundred lines is a clean 40,
      // not a rejected save.
      setConfig(widget, 'items', lines.slice(0, 40));
    });
    field.appendChild(area);
    configPanel.appendChild(field);

    const done = switchRow(
      'Show ticked items too',
      'Struck through, under the ones still to do. Off, the list is only what is left.',
      cfg['showDone'] === true,
      (on) => setConfig(widget, 'showDone', on ? true : undefined),
      'showDone',
    );
    configPanel.appendChild(done);

    const showFor = (list: string | undefined): void => {
      field.hidden = list !== undefined;
      done.hidden = list === undefined;
    };
    showFor(chosen);
    select.addEventListener('change', () => {
      const list = select.value === '' ? undefined : select.value;
      // The typed items stay in the config whatever is chosen: the key that
      // decides which source draws is `list`, and only it is written here.
      setConfig(widget, 'list', list);
      showFor(list);
    });
  }

  /**
   * A short mutually-exclusive choice, as a segmented control.
   *
   * Left/Centre/Right and Square/Rounded were dropdowns, which is a picker for
   * two or three words that are already short enough to show.
   */
  function segControl(
    label: string,
    options: readonly (readonly [string, string])[],
    current: string,
    onChange: (value: string) => void,
    key?: string,
  ): HTMLElement {
    const field = cfgField(label, key);
    const group = document.createElement('div');
    group.className = 'seg le-seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.className = value === current ? 'on' : '';
      button.setAttribute('aria-pressed', value === current ? 'true' : 'false');
      button.addEventListener('click', () => {
        onChange(value);
        renderConfigPanel();
      });
      group.appendChild(button);
    }
    field.appendChild(group);
    return field;
  }

  /** Whether the widget's own colour lane paints its box (`applyStyleTokens`). */
  function hasOwnGround(cfg: Record<string, unknown>): boolean {
    return typeof styleLayerOf(cfg['style'])?.['--bg'] === 'string';
  }

  /**
   * The Style tab: the box-level format every widget carries.
   *
   * One implementation for all ten widget types — it writes the same
   * per-widget config keys it always did, so nothing stored changed shape.
   * What changed is that a control is only drawn when it does something:
   * the title field appears when the title is set to show, and the background
   * colour and its opacity appear when there is a background to colour.
   *
   * Corners appear when there is a ground to round — a card background, the
   * widget's own lane background, or a picture. They used to be offered
   * everywhere, on the argument that `applyWidgetFormat` rounds and clips the
   * box whether or not a background is set, and that argument was written for
   * the drop shadow beside them: a shadow was visible on a bare box, and a
   * curve is not. The box is padded, so a bare box's rounded corner falls on
   * empty space, and a household pressing Rounded on a forecast saw nothing
   * move.
   *
   * There is no drop-shadow control here any more: a shadow bands on e-ink,
   * burns in on OLED, and buys nothing at reading distance. A widget that
   * already has `shadow: true` in its stored config simply draws without one
   * now — nothing here rewrites that key, so it is dead rather than migrated.
   */
  function buildFormatConfig(widget: Widget, cfg: Record<string, unknown>): void {
    buildLookField(widget, cfg);
    buildBoxFields(widget);

    // Title — countdown sets its own label in Content (the same `title` key),
    // so offering it again here would be two fields for one value.
    if (widget.type !== 'countdown') {
      const showTitle = cfg['showTitle'] === true;
      configPanel.appendChild(
        switchRow('Show title', 'Draws a heading above this widget on the wall.', showTitle, (checked) => {
          setConfig(widget, 'showTitle', checked ? true : undefined);
          renderConfigPanel();
        }),
      );
      // Off keeps whatever was typed — `showTitle` is the only key touched —
      // so turning it back on brings the same title with it.
      if (showTitle) {
        const titleField = cfgField('Title');
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.maxLength = 60;
        titleInput.placeholder = 'e.g. This week';
        titleInput.value = typeof cfg['title'] === 'string' ? (cfg['title'] as string) : '';
        titleInput.addEventListener('change', () => setConfig(widget, 'title', titleInput.value.trim()));
        titleField.appendChild(titleInput);
        configPanel.appendChild(titleField);
      }
    }

    // Alignment — 'left' is the default, stored as an absence.
    configPanel.appendChild(
      segControl(
        'Text alignment',
        [
          ['left', 'Left'],
          ['center', 'Centre'],
          ['right', 'Right'],
        ],
        typeof cfg['align'] === 'string' ? (cfg['align'] as string) : 'left',
        (value) => setConfig(widget, 'align', value === 'left' ? undefined : value),
        'align',
      ),
    );

    // Background
    const hasBg = typeof cfg['background'] === 'string';
    configPanel.appendChild(
      switchRow(
        'Card background',
        'Fills the widget’s box behind what it draws, and lets its corners be rounded.',
        hasBg,
        (checked) => {
          setConfig(widget, 'background', checked ? '#111820' : undefined);
          if (!checked) setConfig(widget, 'opacity', undefined);
          renderConfigPanel();
        },
      ),
    );
    if (hasBg) {
      const colorField = cfgField('Background colour');
      const color = document.createElement('input');
      color.type = 'color';
      color.value = /^#[0-9a-fA-F]{6}$/.test(String(cfg['background']))
        ? String(cfg['background'])
        : '#111820';
      color.addEventListener('change', () => setConfig(widget, 'background', color.value));
      colorField.appendChild(color);
      configPanel.appendChild(colorField);

      const opField = cfgField('Background opacity');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.value = typeof cfg['opacity'] === 'number' ? String(cfg['opacity']) : '100';
      range.addEventListener('change', () =>
        setConfig(widget, 'opacity', range.value === '100' ? undefined : Math.round(Number(range.value))),
      );
      opField.appendChild(range);
      configPanel.appendChild(opField);
    }

    /*
     * Corners — 'square' is the default — offered only where there is a ground
     * to round.
     *
     * Rounding clips the box, and the box is padded on every side, so on a
     * widget with nothing painted behind it the curve fell on empty space and
     * the control did nothing a household could see — the `options.json` rule.
     * A card background paints the box, and so does the widget's own colour
     * lane when it sets a background. A picture is the third case: the curve
     * is carried through to the picture itself (`--fw-radius`), because a
     * rounded photograph is what somebody pressing Rounded on one is asking
     * for. A stored `rounded` is left alone when the ground goes, so turning
     * the background back on brings the corners back with it.
     */
    if (hasBg || hasOwnGround(cfg) || widget.type === 'image') {
      configPanel.appendChild(
        segControl(
          'Corners',
          [
            ['square', 'Square'],
            ['rounded', 'Rounded'],
          ],
          typeof cfg['corners'] === 'string' ? (cfg['corners'] as string) : 'square',
          (value) => setConfig(widget, 'corners', value === 'square' ? undefined : value),
        ),
      );
    }

    buildStyleLane([widget], cfg);
  }

  /**
   * The Look: a widget's designed variant (RFC 014 §4.2), at the top of the
   * Style tab because it is the largest thing the tab can change.
   *
   * The clock is the one type with variants so far; a type without any draws
   * no row rather than a picker of one. Annotated with `variant`, so the ink
   * lane keeps it — a panel draws every clock variant (`PANEL_HONOURS`), so
   * every value is offered there too. `plain` is the default and is stored as
   * an absence on the wall; on the ink lane it is written out when the wall
   * says otherwise, because clearing the override there would hand the panel
   * straight back to the wall's variant rather than to the plain one chosen.
   */
  function buildLookField(widget: Widget, cfg: Record<string, unknown>): void {
    if (widget.type !== 'clock') return;
    const wallVariant = clockVariant(widget.config);
    configPanel.appendChild(
      segControl(
        'Look',
        [
          ['plain', 'Plain'],
          ['stacked', 'Stacked'],
          ['analogue', 'Analogue'],
        ],
        clockVariant(cfg),
        (value) =>
          setConfig(
            widget,
            'variant',
            value === 'plain' && (lane === 'wall' || wallVariant === 'plain') ? undefined : value,
          ),
        'variant',
      ),
    );
  }

  /**
   * Merge one option into the widget's style lane (RFC 014 §4.1) — `setConfig`
   * one level down, writing into `config.style` and never beside it, so the
   * lane stays the one strict object the server validates.
   */
  function setStyle(widget: Widget, key: string, value: string | number | undefined): void {
    recordRun(`style:${widget.id}:${key}`);
    const next = setStyleValue(widget.config, key, value);
    if (next !== undefined) widget.config = next;
    else delete widget.config;
    markDirty();
    renderPreview();
  }

  /**
   * The same write onto every selected box at once (RFC 014 §5.1), as one
   * undo step: `recordOnce` around the loop, for the reason the ladder uses
   * it — a snapshot per box would make one colour three Ctrl+Zs.
   */
  function setStyleMany(targets: readonly Widget[], key: string, value: string | number | undefined): void {
    const [first] = targets;
    if (first !== undefined && targets.length === 1) {
      setStyle(first, key, value);
      return;
    }
    recordOnce(() => {
      for (const widget of targets) {
        const next = setStyleValue(widget.config, key, value);
        if (next !== undefined) widget.config = next;
        else delete widget.config;
      }
    });
    markDirty();
    renderPreview();
  }

  /**
   * Colours and type: the widget's own style lane (RFC 014 §4.1), the ink
   * lane's twin on the Style tab.
   *
   * One switch, "Inherit the wall's theme", on for every widget until a
   * household says otherwise. Off, it reveals the lane's controls seeded with
   * the values this widget is inheriting right now — the theme's own colours,
   * over whatever the wall's default lane set — which is the inherited-number
   * pattern: the revealed field shows what it was following, so changing one
   * colour changes one colour and the other ten stay the theme's. Only what is
   * touched is written, so a widget that sets its accent carries its accent
   * and nothing else, and the daylight theme still reaches every token it did
   * not claim.
   *
   * The whole section carries one config key, `style`, which no panel lane
   * offers: `pruneToLane` drops it on the ink lane in one piece, so a panel is
   * never offered a colour it cannot draw (`PANEL_IGNORES` says why, beside
   * the wall's own settings). The contrast guidance is the theme builder's,
   * because a colour is chosen here the same way it is chosen there.
   */
  function buildStyleLane(targets: readonly Widget[], cfg: Record<string, unknown>): void {
    // The controls read the first box and write to all of them: a
    // multi-selection's lane shows what its primary box carries.
    const widget = targets[0];
    if (widget === undefined) return;
    const section = document.createElement('div');
    section.className = 'le-cfg-section le-style';
    section.dataset['cfgKey'] = 'style';
    const kicker = document.createElement('p');
    kicker.className = 'kick';
    kicker.textContent = 'Colours and type';
    section.appendChild(kicker);

    const own = styleLayerOf(cfg['style']);
    const inheriting = own === undefined && !styleLaneOpen.has(widget.id);
    section.appendChild(
      switchRow(
        'Inherit the wall’s theme',
        'Colours, faces, weight, tracking and inset follow the wall. Off, this widget keeps its own.',
        inheriting,
        (checked) => {
          if (checked) {
            styleLaneOpen.delete(widget.id);
            // Every value at once, on every selected box, and a step back for
            // all of them.
            record();
            for (const one of targets) {
              const cfgNow: Record<string, unknown> = { ...(one.config ?? {}) };
              delete cfgNow['style'];
              if (Object.keys(cfgNow).length > 0) one.config = cfgNow;
              else delete one.config;
            }
            markDirty();
            renderPreview();
          } else {
            styleLaneOpen.add(widget.id);
          }
          renderConfigPanel();
        },
      ),
    );
    configPanel.appendChild(section);
    if (inheriting) return;

    // What this widget is inheriting: the theme, then the wall's default lane.
    const effective: Record<string, string> = { ...styleBase() };
    for (const layer of styleContext()) {
      for (const token of STYLE_LANE_TOKENS) {
        const value = layer[token];
        if (typeof value === 'string') effective[token] = value;
      }
    }
    const current = (token: string): string | undefined => {
      const mine = own?.[token];
      return typeof mine === 'string' ? mine : effective[token];
    };

    const colours: readonly (readonly [string, string])[] = [
      ['--bg', 'Background'],
      ['--panel', 'Card'],
      ['--rule', 'Rule'],
      ['--ink', 'Text'],
      ['--muted', 'Muted text'],
      ['--faint', 'Faint text'],
      ['--accent', 'Accent'],
      ['--s-day', 'Day shift'],
      ['--s-night', 'Night shift'],
      ['--s-break', 'Rest day'],
      ['--s-straight', 'Straight shift'],
    ];
    const grid = document.createElement('div');
    grid.className = 'le-style-colours';
    for (const [token, label] of colours) {
      const field = cfgField(label);
      const input = document.createElement('input');
      input.type = 'color';
      input.dataset['token'] = token;
      const value = current(token);
      if (value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value)) input.value = value;
      input.addEventListener('change', () => {
        const grounded = hasOwnGround(widget.config ?? {});
        setStyleMany(targets, token, input.value);
        // A lane background is a ground Corners can round, so the panel is
        // redrawn the moment it first appears rather than on the next select.
        if (token === '--bg' && !grounded) {
          renderConfigPanel();
          return;
        }
        renderContrast(contrast, { ...effective, ...styleLayerOf(widget.config?.['style']) } as Record<string, string>);
      });
      field.appendChild(input);
      grid.appendChild(field);
    }
    section.appendChild(grid);

    // The theme builder's guidance, against the ground this widget will sit on.
    const contrast = document.createElement('div');
    contrast.className = 'le-style-contrast';
    renderContrast(contrast, { ...effective, ...own } as Record<string, string>);
    section.appendChild(contrast);

    for (const [token, label] of [
      ['--disp', 'Headings face'],
      ['--f-sans', 'Text face'],
    ] as const) {
      const field = cfgField(label);
      const select = document.createElement('select');
      select.dataset['token'] = token;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'Same as the wall';
      select.appendChild(none);
      for (const font of fonts) {
        const option = document.createElement('option');
        option.value = font.stack;
        option.textContent = font.label;
        select.appendChild(option);
      }
      const chosen = current(token);
      select.value = chosen !== undefined && fonts.some((font) => font.stack === chosen) ? chosen : '';
      select.addEventListener('change', () => setStyleMany(targets, token, select.value === '' ? undefined : select.value));
      field.appendChild(select);
      section.appendChild(field);
    }

    const weightNames: Readonly<Record<string, string>> = { regular: 'Regular', medium: 'Medium', bold: 'Bold' };
    section.appendChild(
      segControl(
        'Weight',
        STYLE_WEIGHTS.map((weight) => [weight, weightNames[weight] ?? weight] as const),
        typeof own?.weight === 'string' ? own.weight : 'regular',
        (value) => setStyleMany(targets, 'weight', value),
      ),
    );
    const trackingNames: Readonly<Record<string, string>> = { tight: 'Tight', normal: 'Normal', wide: 'Wide' };
    section.appendChild(
      segControl(
        'Tracking',
        STYLE_TRACKINGS.map((tracking) => [tracking, trackingNames[tracking] ?? tracking] as const),
        typeof own?.tracking === 'string' ? own.tracking : 'normal',
        (value) => setStyleMany(targets, 'tracking', value),
      ),
    );
    // The gutter's own words for the same five rungs: step 4 is what every
    // box draws today, so it is "Normal" here for the reason it is there.
    const insetNames = ['None', 'Very tight', 'Tight', 'Snug', 'Normal'];
    section.appendChild(
      segControl(
        'Inset',
        insetNames.slice(0, STYLE_INSET_MAX + 1).map((name, step) => [String(step), name] as const),
        String(typeof own?.inset === 'number' ? own.inset : STYLE_INSET_MAX),
        (value) => setStyleMany(targets, 'inset', Number(value)),
      ),
    );
  }

  /**
   * Where the box is, in numbers (RFC 009 Phase 5).
   *
   * Percentages of the canvas, which is what is stored — so what is typed is
   * what is saved, with no second unit to convert between. They cost almost
   * nothing and they are the only way to line two widgets up exactly: a drag
   * lands on a pixel and the snap grid is a twenty-fourth, so "the same left
   * edge as the one above" is otherwise a thing you can approach and never
   * reach.
   *
   * Deliberately unannotated with a config key, so `pruneToLane` drops the
   * whole row on the ink lane: a panel follows the wall's arrangement, and a
   * box that moved on ink alone would be two canvases a household believes are
   * one.
   */
  function buildBoxFields(widget: Widget): void {
    // Not built at all on the ink lane rather than built and pruned: pruning
    // detaches the row, and `boxFields` would go on pointing at inputs nothing
    // can see, which a drag would then dutifully write into.
    if (lane === 'ink') return;
    // Nor for a child whose place is its group's order (RFC 014 §5.1): the
    // panel already says so, and a field that moved nothing is the fault
    // this project keeps recording.
    if (orderedChildNote !== undefined) return;
    const inGroup = parentIdOf(widget) !== undefined;
    const row = document.createElement('div');
    row.className = 'le-cfg-field le-box';
    const label = document.createElement('span');
    // A child's fractions are of its group, and the fields say whose.
    label.textContent = inGroup ? 'Position and size, within the group' : 'Position and size';
    const grid = document.createElement('div');
    grid.className = 'le-box-grid';
    const inputs: (readonly ['x' | 'y' | 'w' | 'h', HTMLInputElement])[] = [];
    for (const [field, name] of [
      ['x', 'X'],
      ['y', 'Y'],
      ['w', 'Width'],
      ['h', 'Height'],
    ] as const) {
      const cell = document.createElement('label');
      cell.className = 'le-box-cell';
      const cellName = document.createElement('span');
      cellName.textContent = name;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.inputMode = 'numeric';
      input.value = String(Math.round(widget[field] * 100));
      input.setAttribute('aria-label', inGroup ? `${name}, per cent of the group` : `${name}, per cent of the layout`);
      input.addEventListener('input', () => {
        const typed = Number(input.value);
        // An empty field is a number half-typed, not a widget at zero.
        if (input.value.trim() === '' || !Number.isFinite(typed)) return;
        recordRun(`box:${widget.id}`);
        applyBox(widget, setDimension(widget, field, typed / 100));
        const box = overlay.querySelector<HTMLElement>(`.le-widget[data-id="${widget.id}"]`);
        if (box !== null) positionBox(box, widget);
        markDirty();
        schedulePreview();
      });
      // Committed: show what the canvas took, including the clamp.
      input.addEventListener('change', () => syncBoxFields(widget, true));
      cell.append(cellName, input);
      grid.appendChild(cell);
      inputs.push([field, input] as const);
    }
    row.append(label, grid);
    configPanel.appendChild(row);
    boxFields = { id: widget.id, inputs };
  }

  /**
   * The Calendar's options, which depend on the view *and* the density.
   *
   * Both axes gate, and that is the point of splitting them. The dense month
   * draws its own flat rows and reads no `cellEvents`; neither dense view draws
   * a week number. Offering either there would be a control that does nothing —
   * which this project has shipped before, and which the household reports as
   * "the calendar settings have no impact". The old `skymonth` showed the week
   * number switch for exactly that reason: the guard was `mode !== 'list'`, and
   * `skymonth` is not `list`.
   */
  function buildCalendarConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const shape = calendarView(cfg);
    const view = shape.view;

    /*
     * **The density axis does not exist on a panel**, so on the ink lane the
     * controls a dense wall gives up are exactly the ones a panel still reads.
     *
     * `PANEL_IGNORES` carries the reason: compact buys its room from gaps and
     * cards, and a 1-bit panel is already edge to edge with none to give up. So
     * a panel draws the month grid at one density whatever the wall does — and
     * it *does* read `cellEvents` there, which `INK_LANE` offers. Reading the
     * wall's density here would hide that control on the lane for every
     * household whose wall is compact, which is the same fault as offering one
     * the panel cannot honour, in the other direction.
     */
    const density = lane === 'ink' ? 'comfortable' : shape.density;

    /*
     * Density: how much room the calendar spends on itself.
     *
     * Not offered on the agenda, which has one. A segmented control rather than
     * two more entries in the View list, because that is what it was before —
     * "Sky month" beside "Month grid" made a density choice look like a
     * different thing to draw, and hid that the dense pair trades type size for
     * events a day. Named where the trade is, in the hint.
     *
     * Not offered on the ink lane either, for the reason just above.
     * `pruneToLane` would drop it regardless — that is its job, and the safe
     * default — but a control built to be thrown away reads as an oversight.
     */
    if (view !== 'list' && lane !== 'ink') {
      configPanel.appendChild(
        segControl(
          'Density',
          [
            ['comfortable', 'Comfortable'],
            ['compact', 'Compact'],
          ],
          density,
          (value) => {
            const next = CALENDAR_DENSITIES.find((one) => one === value) ?? 'comfortable';
            setCalendarShape(widget, view, next);
            renderConfigPanel();
          },
          'density',
        ),
      );
      const trade = document.createElement('p');
      trade.className = 'hint';
      trade.dataset['cfgKey'] = 'density';
      trade.textContent =
        density === 'compact'
          ? 'Hairlines instead of cards: more of the week in the same box, drawn smaller.'
          : 'Cards and gaps. Compact fits more in the same box, drawn smaller.';
      configPanel.appendChild(trade);
    }

    /*
     * The rota's colours, on the views that draw them.
     *
     * The only toggle in this panel whose *unticked* state is what gets
     * stored: it has been on since the wall was first drawn, so a household
     * who arranged a canvas around those colours keeps them by default.
     *
     * **Not the week columns, at either density.** `renderWeekColumns` and
     * `renderSkyWeek` paint no rota — no `paintShift`, no `shiftToken`, nothing
     * that could — so the switch has done nothing there since the week view
     * shipped. Hiding it is the honest answer for today and nothing more: a
     * week column *is* a day and the tint is per-day, so drawing the rota there
     * is a reasonable thing to build. It is a separate decision, because
     * `showShifts`'s absence means *on* — a week renderer that started painting
     * would light up rota colours on every week wall already hanging.
     */
    if (view !== 'week') {
      configPanel.appendChild(
        switchRow(
          'Show work schedules',
          'Colours the days a rota covers.',
          cfg['showShifts'] !== false,
          (checked) => setConfig(widget, 'showShifts', checked ? undefined : false),
        ),
      );
    }

    /*
     * The week of the year, on either comfortable grid.
     *
     * Not on the agenda, where a number per day group would repeat itself down
     * the wall — and not on either dense view, which draws no week number at
     * all. That last half is a bug this split found rather than one it caused:
     * the guard was `mode !== 'list'`, so `skymonth` and `skyweek` have been
     * offering a switch that does nothing since they shipped.
     */
    if (view !== 'list' && density === 'comfortable') {
      configPanel.appendChild(
        switchRow('Show week numbers', '', cfg['showWeekNumbers'] === true, (checked) =>
          setConfig(widget, 'showWeekNumbers', checked ? true : undefined),
        ),
      );
    }

    // Month cells: flat names (the default), quiet dots, Skylight-style
    // labelled pills, or Swiss — the same flat names in the typographic grid.
    // The dense month draws its own flat rows and reads none of these.
    if (view === 'month' && density === 'comfortable') {
      const cellStyles = ['dots', 'pills', 'swiss', 'text'] as const;
      const stored = cfg['cellEvents'];
      const current = cellStyles.find((key) => key === stored) ?? 'text';
      configPanel.appendChild(
        segControl(
          'Events in a day',
          [
            ['text', 'Names'],
            ['dots', 'Dots'],
            ['pills', 'Labelled pills'],
            ['swiss', 'Swiss rows'],
          ],
          current,
          (value) => {
            /*
             * The default is stored as an *absence*, and the default is now
             * `text`. `dots` is therefore written out in full: it used to be
             * the absence, so leaving it unwritten would silently mean names.
             */
            const next = cellStyles.find((key) => key === value);
            setConfig(widget, 'cellEvents', next === undefined || next === 'text' ? undefined : next);
          },
          'cellEvents',
        ),
      );
    }

    // Which calendars to show — for the week columns and the agenda, where
    // filtering means something; the month grid is a whole month at a glance.
    if (view === 'week') {
      const which = cfgField('Calendars to show', 'calendars');
      which.appendChild(
        checkList(
          state.calendars.map((c) => ({ value: c.id, label: c.name })),
          Array.isArray(cfg['calendars']) ? (cfg['calendars'] as string[]) : [],
          (values) => setConfig(widget, 'calendars', values),
          'No calendars yet — add one on the Calendars page.',
        ),
      );
      configPanel.appendChild(which);
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'None ticked shows them all.';
      note.dataset['cfgKey'] = 'calendars';
      configPanel.appendChild(note);
    }

    // Filtering plus a count for the list — the agenda.
    if (view === 'list') {
      const which = cfgField('Calendars to show', 'calendars');
      which.appendChild(
        checkList(
          state.calendars.map((c) => ({ value: c.id, label: c.name })),
          Array.isArray(cfg['calendars']) ? (cfg['calendars'] as string[]) : [],
          (values) => setConfig(widget, 'calendars', values),
          'No calendars yet — add one on the Calendars page.',
        ),
      );
      configPanel.appendChild(which);
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'None ticked shows them all.';
      note.dataset['cfgKey'] = 'calendars';
      configPanel.appendChild(note);

      const countField = cfgField('How many events', 'count');
      const count = document.createElement('input');
      count.type = 'number';
      count.min = '1';
      count.max = '50';
      count.value = typeof cfg['count'] === 'number' ? String(cfg['count']) : '12';
      count.addEventListener('change', () => {
        const n = Math.round(Number(count.value));
        setConfig(widget, 'count', Number.isFinite(n) && n >= 1 ? Math.min(50, n) : undefined);
      });
      countField.appendChild(count);
      configPanel.appendChild(countField);

      // Off unless asked for: a wall that already carries a weather widget
      // would otherwise say the same numbers twice.
      configPanel.appendChild(
        switchRow(
          'Show the forecast',
          'Off by default: a wall with a Weather widget would say it twice.',
          cfg['showWeather'] === true,
          (checked) => setConfig(widget, 'showWeather', checked ? true : undefined),
        ),
      );
    }
  }

  /**
   * The Shift widget's options: whose rota, and which of the badge's lines.
   *
   * "None ticked shows everyone" matches the calendar and reading pickers, and
   * is what an untouched widget has always drawn — except that until 0.45.0 it
   * silently drew only whoever sorted first, so a second shift worker could not
   * be put on the wall at all.
   *
   * The three switches are written the other way round from most in this panel:
   * their *unticked* state is what gets stored, because the face, the hours and
   * the run have been drawn since the badge existed and a household who
   * arranged a canvas around them must not lose them to a schema change.
   */
  /**
   * The Clock widget's options.
   *
   * No "show seconds": the wall redraws every fifteen seconds, so the control
   * would promise a precision the widget cannot keep. Its absence is the
   * decision, and it is written down in the schema too.
   */
  function buildClockConfig(widget: Widget, cfg: Record<string, unknown>): void {
    /*
     * An analogue face has no digits to format and a stacked clock always
     * draws its date, so each of these rows is offered only where it does
     * something — an option that does nothing is worse than one not offered.
     * Read off the lane's own config, so the ink lane asks what the *panel*
     * will draw.
     */
    const variant = clockVariant(cfg);
    if (variant === 'analogue') return;
    configPanel.appendChild(
      segControl(
        'Time format',
        [
          ['', 'Follow the household'],
          ['12', '12-hour'],
          ['24', '24-hour'],
        ],
        cfg['clockFormat'] === '12' || cfg['clockFormat'] === '24'
          ? (cfg['clockFormat'] as string)
          : '',
        // The household's own setting is stored as an absence, so a wall that
        // switches to 24-hour later takes its clocks with it.
        (value) => setConfig(widget, 'clockFormat', value === '' ? undefined : value),
        'clockFormat',
      ),
    );
    if (variant !== 'plain') return;
    configPanel.appendChild(
      switchRow(
        'Show the date',
        '',
        cfg['showDate'] !== false,
        (checked) => setConfig(widget, 'showDate', checked ? undefined : false),
        'showDate',
      ),
    );
  }

  /**
   * The Weather widget's options.
   *
   * "How many days" is capped at what the household's forecast setting supplies
   * rather than at the schema's 50 — a widget asking for ten days of a
   * five-day forecast is a control that does nothing for half its range.
   */
  function buildWeatherConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('How many days', 'count');
    const count = document.createElement('input');
    count.type = 'number';
    count.min = '1';
    count.max = '10';
    count.placeholder = 'All of them';
    count.value = typeof cfg['count'] === 'number' ? String(cfg['count']) : '';
    count.addEventListener('change', () => {
      const n = Math.round(Number(count.value));
      setConfig(widget, 'count', Number.isFinite(n) && n >= 1 ? Math.min(10, n) : undefined);
    });
    field.appendChild(count);
    configPanel.appendChild(field);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Empty shows every day the forecast has.';
    note.dataset['cfgKey'] = 'count';
    configPanel.appendChild(note);

    // The symbol and the low used to be two switches here; they are rows on the
    // ladder now, which is the one place a widget's rows are decided.
    buildLadder(widget, cfg);
  }

  function buildShiftConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const who = cfgField('Whose rota', 'people');
    who.appendChild(
      checkList(
        state.people.map((person) => ({ value: person.id, label: person.name })),
        Array.isArray(cfg['people']) ? (cfg['people'] as string[]) : [],
        (values) => setConfig(widget, 'people', values),
        'Nobody has a rota yet — set one up on the Work Schedule page.',
      ),
    );
    configPanel.appendChild(who);
    if (state.people.length > 0) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'None ticked shows everyone who is on today.';
      note.dataset['cfgKey'] = 'people';
      configPanel.appendChild(note);
    }

    configPanel.appendChild(
      segControl(
        'Shift name',
        [
          ['label', 'Full name'],
          ['code', 'Short code'],
        ],
        cfg['shiftName'] === 'code' ? 'code' : 'label',
        (value) => setConfig(widget, 'shiftName', value === 'code' ? 'code' : undefined),
        'shiftName',
      ),
    );

    configPanel.appendChild(
      switchRow('Show their photo', '', cfg['showFace'] !== false, (checked) =>
        setConfig(widget, 'showFace', checked ? undefined : false),
      ),
    );
    buildLadder(widget, cfg);
  }

  /** What each ladder field is called, and what it says, for the editor. */
  const LADDER_LABELS: Readonly<Record<string, readonly [string, string]>> = {
    person: ['Who it is', 'Amy'],
    shift: ['The shift', 'Nights'],
    hours: ['The hours', '19:00–07:00'],
    run: ['How far through', 'Day 2 of 4 · 2 more'],
    name: ['The day', 'Today'],
    // Named rather than shown: the example column beside it is a line of
    // plain text, and the one thing that could stand in for a drawing here is
    // a character out of a font nobody ships.
    icon: ['The symbol', 'a sun, a cloud'],
    high: ['The high', '24°'],
    low: ['The overnight low', '13°C'],
    label: ['What it is', 'Kitchen'],
    value: ['The reading', '19.4 °C'],
  };

  /**
   * Each widget's ladder: its fields, and the switches writing a list replaces.
   *
   * A widget with no entry has no ladder and gets its ordinary options. Adding
   * one here is what makes a third widget's rows orderable — the table is the
   * seam, not a branch inside the builder.
   */
  const LADDERS: Readonly<
    Record<
      string,
      {
        readonly fields: readonly string[];
        readonly resolve: (cfg: unknown) => readonly string[];
        readonly replaces: readonly string[];
      }
    >
  > = {
    shift: {
      fields: SHIFT_FIELDS,
      resolve: (cfg) => shiftLadder(cfg),
      replaces: ['showHours', 'showRun'],
    },
    weather: {
      fields: WEATHER_FIELDS,
      resolve: (cfg) => weatherLadder(cfg),
      replaces: ['showIcon', 'showLow'],
    },
    /*
     * A reading's parts. Its default comes from each entity's own display mode
     * rather than from one list, so the editor shows the commonest of those —
     * `label_value` — until the household writes a list of their own.
     */
    homeassistant: {
      fields: HOUSE_FIELDS,
      resolve: (cfg) => houseLadder(cfg, 'label_value'),
      replaces: [],
    },
  };

  /**
   * The field ladder: what the badge says, in the order it matters.
   *
   * One list rather than a row of switches, because the order carries a second
   * meaning the switches could not express — it is also the order rows are
   * given up in when the box will not hold them all. Everything is on the list
   * whether or not it is ticked, so there is one place to look and no
   * add/remove mode to be in.
   *
   * Writing it clears `showHours` and `showRun`, the two switches it replaces.
   * A widget is described one way or the other and never half in each; those
   * switches keep working for a widget nobody has touched (`shiftLadder`).
   */
  function buildLadder(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('What it says', 'fields');
    const list = document.createElement('div');
    list.className = 'le-ladder';

    const spec = LADDERS[widget.type];
    if (spec === undefined) return;
    const chosen = spec.resolve(cfg);
    const order = [...chosen, ...spec.fields.filter((name) => !chosen.includes(name))];

    const write = (next: readonly string[]): void => {
      /*
       * Clear the switches this list replaces — in whichever lane is open.
       *
       * On the wall that is the widget's own config; on the ink lane it is the
       * override object, and clearing the wall's copy from there would rewrite
       * the household's wall from a panel's settings. The lanes are one-way by
       * design and this is the one place that could have quietly broken it.
       *
       * Both writes are one step back: the clear happens first, so a snapshot
       * taken inside `setConfig` would restore the list and leave the switches
       * it cleared deleted.
       */
      recordOnce(() => {
        const cleared = clearLaneKeys(widget.config, lane, spec.replaces);
        if (cleared !== undefined) widget.config = cleared;
        else delete widget.config;
        setConfig(widget, 'fields', [...next]);
      });
      renderConfigPanel();
    };

    for (const name of order) {
      const on = chosen.includes(name);
      const [label, example] = LADDER_LABELS[name] ?? [name, ''];
      const row = document.createElement('div');
      row.className = 'le-ladder-row' + (on ? '' : ' is-off');
      row.dataset['field'] = name;

      const grip = document.createElement('span');
      grip.className = 'le-layer-grip';
      grip.textContent = '⋮⋮';
      grip.title = 'Drag to reorder';
      if (on) grip.addEventListener('pointerdown', (event) => startLadderDrag(event, name, list, write));

      const tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.checked = on;
      tick.addEventListener('change', () => {
        const next = tick.checked
          ? [...chosen, name]
          : chosen.filter((entry) => entry !== name);
        // Never all four off: the badge would have nothing to draw, and the
        // renderer would fall back to the default and contradict this list.
        write(next.length > 0 ? next : [name]);
      });

      const text = document.createElement('span');
      text.className = 'le-ladder-name';
      text.textContent = label;
      const eg = document.createElement('span');
      eg.className = 'le-ladder-eg';
      eg.textContent = example;

      // The whole row but the grip is the checkbox's label, so a tap on the
      // field's name ticks it. The box alone is 13px, on a list built for a
      // phone.
      const pick = document.createElement('label');
      pick.className = 'le-ladder-pick';
      pick.append(tick, text, eg);
      row.append(grip, pick);
      list.appendChild(row);
    }

    field.appendChild(list);
    configPanel.appendChild(field);

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent =
      widget.type === 'homeassistant'
        ? 'Each reading follows the shape you set it on the Home Assistant ' +
          'page. Change this list and every reading in this widget uses it ' +
          'instead — one shape for all of them.'
        : 'First is drawn first, and given up last. When the box is too small ' +
          'the bottom of the list goes first — so put what matters at the top.';
    configPanel.appendChild(note);
    ladderPanels.push({ widget, list });
    markLadderCut();
  }

  /**
   * Drag a ladder row to reorder, and write the new order once, on release.
   *
   * The rows follow the pointer by moving in place; nothing is written until
   * the pointer comes up. The first version wrote on every move, and every
   * write rebuilds the whole panel — so after the first step this function was
   * holding a list that was no longer in the document, whose rows all measured
   * zero high, and every later move read "below every row" and sent the
   * dragged field to the bottom. A drag upwards landed it last. It also put one
   * step on the undo stack per row crossed, where a drag is one edit.
   */
  function startLadderDrag(
    event: PointerEvent,
    name: string,
    list: HTMLElement,
    write: (next: readonly string[]) => void,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const onRows = (): HTMLElement[] =>
      Array.from(list.querySelectorAll<HTMLElement>('.le-ladder-row:not(.is-off)'));
    const orderOf = (rows: readonly HTMLElement[]): string[] => rows.map((row) => row.dataset['field'] ?? '');
    const start = orderOf(onRows());
    const dragged = onRows().find((row) => row.dataset['field'] === name);
    if (dragged === undefined) return;
    dragged.classList.add('is-dragging');

    const move = (moveEvent: PointerEvent): void => {
      // The other rows decide where it goes: the first one whose middle is
      // below the pointer is the row it now sits in front of.
      const others = onRows().filter((row) => row !== dragged);
      const before = others.find((row) => {
        const rect = row.getBoundingClientRect();
        return moveEvent.clientY < rect.top + rect.height / 2;
      });
      const anchor = before ?? others[others.length - 1]?.nextElementSibling ?? null;
      if (anchor === dragged || dragged.nextElementSibling === anchor) return;
      list.insertBefore(dragged, anchor);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragged.classList.remove('is-dragging');
      const next = orderOf(onRows());
      if (next.join(' ') !== start.join(' ')) write(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * The tier the live preview resolved for one widget, or nothing.
   *
   * `renderFreeform` stamps it on what it drew — `data-tier` on a month grid's
   * own section, and on the box for an agenda — so this is a read-back and
   * never a prediction. Nothing before the preview has loaded, and nothing for
   * a widget that has no tier, which is every type but the calendar.
   */
  function drawnTierOf(id: string): TierName | undefined {
    const box = previewShadow?.querySelector(`[data-widget-id="${id}"]`);
    if (!(box instanceof HTMLElement)) return undefined;
    const found = box.querySelector('[data-tier]') ?? (box.hasAttribute('data-tier') ? box : null);
    const value = found instanceof HTMLElement ? found.getAttribute('data-tier') : null;
    if (value === null) return undefined;
    // Checked against the table rather than cast, so a rung a newer bundle
    // stamped reads as absent instead of reaching a lookup that has no entry.
    return (TIER_NAMES as readonly string[]).indexOf(value) < 0 ? undefined : (value as TierName);
  }

  /**
   * Mark the rows the box is currently too small to draw.
   *
   * Read out of the *real* preview rather than predicted: the preview renders
   * the household's manifest through the wall's own `renderFreeform`, which
   * does the dropping, so counting what survived is the same answer the screen
   * gives. A slider that guessed would be a second opinion about fit, and two
   * opinions about fit is the whole class of bug this project keeps finding.
   */
  /**
   * Re-read the tier note after the preview has redrawn.
   *
   * The panel itself is not rebuilt — rebuilding it on every drag would take
   * focus off whatever the household is typing in — so the one line whose
   * answer the drag changed is refreshed in place, which is the same rule
   * `refreshLabels` follows for a box's accessible name.
   */
  function refreshDensityNote(): void {
    const note = configPanel.querySelector('.le-density');
    const selected = primary();
    if (!(note instanceof HTMLElement) || selected === undefined) return;
    const widget = state.widgets.find((one) => one.id === selected);
    if (widget === undefined) return;
    const view = inspectorView({
      widgets: state.widgets,
      selected,
      lane,
      inkAvailable: ink !== undefined,
      tab: inspectorTab,
      notDrawn: notDrawn(),
      facts: omissionFacts,
      surface: surfaceWord(),
      ...(drawnTierOf(selected) === undefined ? {} : { drawnTier: drawnTierOf(selected) }),
    });
    if (view.kind === 'widget' && view.density !== undefined) note.textContent = view.density;
  }

  function markLadderCut(): void {
    for (const { widget, list } of ladderPanels) {
      const rows = Array.from(list.querySelectorAll<HTMLElement>('.le-ladder-row:not(.is-off)'));
      const cut = lane === 'wall' ? cutFields(widget) : undefined;
      for (const row of rows) {
        row.classList.toggle('is-cut', cut !== undefined && cut.has(row.dataset['field'] ?? ''));
      }
    }
  }

  /**
   * The rungs the live preview gave up for one widget, by name.
   *
   * Read back by *field* rather than by counting rows, because a drawn row is
   * not a rung. The high and the low share one row while they are adjacent, so
   * counting took every ladder with both temperatures on it for one row short
   * and struck the low through while it sat on the glass beside the high; and
   * a field the day has nothing for — an untimed shift's hours — is no row at
   * all without anything having been cut. So a rung is struck through for
   * exactly two reasons, both the renderer's own: its tier kept fewer rungs
   * (`data-rungs`, stamped where that was decided), or the belt hid its row
   * because the box ended first.
   *
   * Nothing on the ink lane: this preview is the wall, and the list there is
   * the panel's, whose frame is a picture with nothing in it to read back. A
   * mark taken off the wall would be a second opinion about a different
   * screen. And a collapsed shift badge has cut nothing — its one line names
   * every rung on it — which falls out of reading names rather than being a
   * case of its own.
   */
  function cutFields(widget: Widget): ReadonlySet<string> | undefined {
    const box = previewShadow?.querySelector(`[data-widget-id="${widget.id}"]`);
    if (!(box instanceof HTMLElement)) return undefined;
    // The unit a ladder fills: one badge for a shift, one day's column for a
    // forecast. Every column has the same rungs, so the first one answers.
    const unit = box.querySelector(widget.type === 'weather' ? '.wx-day' : '.shift-badge');
    if (!(unit instanceof HTMLElement)) return undefined;
    const kept = box.getAttribute('data-rungs');
    const keptSet = kept === null ? undefined : new Set(kept.split(' '));
    const cut = new Set<string>();
    for (const field of LADDERS[widget.type]?.fields ?? []) {
      if (keptSet !== undefined && !keptSet.has(field)) {
        cut.add(field);
        continue;
      }
      const drawn = unit.querySelector(`[data-field~="${field}"]`);
      if (drawn !== null && getComputedStyle(drawn).display === 'none') cut.add(field);
    }
    return cut;
  }

  function buildHaConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const which = cfgField('Readings to show', 'readings');
    which.appendChild(
      checkList(
        state.readings.map((r) => ({ value: r, label: r })),
        Array.isArray(cfg['readings']) ? (cfg['readings'] as string[]) : [],
        (values) => setConfig(widget, 'readings', values),
        'No Home Assistant readings yet — connect it and choose entities first.',
      ),
    );
    configPanel.appendChild(which);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'None ticked shows them all.';
    note.dataset['cfgKey'] = 'readings';
    configPanel.appendChild(note);

    // What each of those readings says. Its default is per entity rather than
    // per widget, which the ladder's own hint explains.
    buildLadder(widget, cfg);
  }

  // ---- pointer interaction ---------------------------------------------

  function startDrag(event: PointerEvent, widget: Widget, box: HTMLElement, resizing: boolean): void {
    event.preventDefault();
    event.stopPropagation();
    /*
     * Shift+click adds to the selection, or takes away (RFC 014 §5.1), and
     * never starts a drag: the whole point of choosing several is to press
     * Group next, and a press that also moved the box would spend an undo
     * step on a tap.
     */
    if (event.shiftKey && !resizing) {
      toggleInSelection(widget.id);
      return;
    }
    // The canvas as it is before the drag, so putting the box down in the wrong
    // place is one Ctrl+Z. `settle` drops this again if the box came back to
    // where it started, so a grab that moved nothing is not an undo step.
    record();
    selection = [widget.id];
    renderConfigPanel();
    drawLayers();
    markSelection();

    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
    const parentId = parentIdOf(widget);
    const parent = parentId === undefined ? undefined : state.widgets.find((w) => w.id === parentId);

    /*
     * A child of a row, a column or a grid cannot be dragged to a position —
     * its place is the group's order — so dragging it reorders (RFC 014
     * §5.1): the cell the pointer is over is the place it takes, and the
     * siblings slide over in place. One undo step, like any drag.
     */
    if (parent !== undefined && groupIsOrdered(parent.config) && !resizing) {
      const reorder = (moveEvent: PointerEvent): void => {
        const point = { x: (moveEvent.clientX - rect.left) / rect.width, y: (moveEvent.clientY - rect.top) / rect.height };
        const at = cellIndexAt(state.widgets, parent.id, point);
        if (at === undefined) return;
        const siblings = groupChildren(state.widgets).get(parent.id) ?? [];
        if (siblings.findIndex((one) => one.id === widget.id) === at) return;
        adoptZ(moveChildTo(state.widgets, widget.id, at));
        repositionAll();
        drawLayers();
        markDirty();
      };
      const done = (): void => {
        window.removeEventListener('pointermove', reorder);
        window.removeEventListener('pointerup', done);
        settle();
        renderPreview();
      };
      window.addEventListener('pointermove', reorder);
      window.addEventListener('pointerup', done);
      return;
    }

    /*
     * Move and up on the window, not the box — a drag routinely leaves the box,
     * and pointer capture throws on the synthetic pointer a test dispatches.
     *
     * Only the dragged box's position is updated here, not the whole overlay
     * and certainly not the preview: re-rendering a month grid on every pointer
     * move would judder. The preview catches up once, on release.
     */
    /*
     * Grabbing brings a box to the front — on the first *move*, not on the
     * press.
     *
     * It used to be raised on pointerdown, which made every selection click a
     * silent restack of the canvas: nothing marked it dirty, so it would ride
     * along with the next save, and with an undo stack it also spent a step on
     * a tap that was only ever a look. A drag brings the box you are dragging
     * to the front, which is what the behaviour was for.
     */
    let raised = false;
    const bringToFront = (): void => {
      if (raised) return;
      raised = true;
      // A child stacks among its siblings and never over another box on the
      // layout, so its rung is its group's; only a box on the layout is raised.
      if (parent !== undefined) return;
      widget.z = nextZ(topLevelWidgets(state.widgets));
      box.style.zIndex = String(overlayZ(widget));
      drawLayers();
    };

    const move = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      bringToFront();
      // Where the box lands is `placement.ts` — snapped, then clamped by the
      // same arithmetic the arrow keys and the inspector's numeric fields use,
      // so a drag and a nudge stop at the same edge. A child's travel is
      // read in its group's fractions, and the same unit clamp is then the
      // group's own edge (RFC 014 §5.1).
      const delta = parent === undefined ? { dx, dy } : inParent({ dx, dy }, parent);
      applyBox(widget, resolveDrag(origin, delta, { resize: resizing, snap }));
      positionBox(box, widget);
      syncBoxFields(widget);
      markDirty();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      settle();
      renderPreview();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- mutations --------------------------------------------------------

  function addWidget(type: string): void {
    record();
    const z = nextZ(state.widgets);
    const n = state.widgets.length;
    state.widgets.push({
      id: randomId(),
      type,
      x: round3(clamp01(0.08 + (n % 4) * 0.04)),
      y: round3(clamp01(0.08 + (n % 4) * 0.04)),
      w: 0.4,
      h: 0.2,
      z,
    });
    selection = [state.widgets[state.widgets.length - 1]!.id];
    draw();
    markDirty();
  }

  /**
   * The selected boxes become one group (RFC 014 §5.1), and the group is what
   * is selected after. One `record()` for the whole change — three boxes
   * re-parented and rewritten as fractions of their union is one thing the
   * household did, and one Ctrl+Z is what takes it back. The arithmetic is
   * `grouping.ts`; nothing on the glass moves, because the group is `free`.
   */
  function groupSelected(): void {
    if (!canGroup(state.widgets, selection)) return;
    record();
    const id = randomId();
    state.widgets = groupWidgets(state.widgets, selection, id);
    selection = [id];
    draw();
    markDirty();
  }

  /** The selected group taken apart, its widgets back where they were and selected. */
  function ungroupSelected(): void {
    const id = primary();
    if (id === undefined || !canUngroup(state.widgets, selection)) return;
    record();
    const members = (groupChildren(state.widgets).get(id) ?? []).map((child) => child.id);
    state.widgets = ungroupWidget(state.widgets, id);
    selection = members;
    draw();
    markDirty();
  }

  /**
   * Copy the widget the inspector is showing, options and all.
   *
   * Three lines once undo exists, which is why it is here and was not before:
   * an editor whose only recovery was reloading the page could not afford a
   * one-tap way to create something.
   *
   * The copy is offset rather than placed exactly over the original — two boxes
   * at the same coordinates look like one box, and the household would go
   * looking for the widget they had just made.
   */
  function duplicateSelected(): void {
    const widget = state.widgets.find((w) => w.id === primary());
    if (widget === undefined) return;
    record();
    const clone = (of: Widget, over: Partial<Widget>): Widget => ({
      ...of,
      ...over,
      // A deep copy: sharing the options object would make editing the copy
      // edit the original. `structuredClone` is out under rule two.
      ...(of.config !== undefined
        ? { config: JSON.parse(JSON.stringify(of.config)) as Record<string, unknown> }
        : {}),
    });
    const scope = parentIdOf(widget);
    const siblings = state.widgets.filter((w) => parentIdOf(w) === scope);
    const copy = clone(widget, { id: randomId(), z: Math.max(0, ...siblings.map((w) => w.z)) + 1 });
    applyBox(copy, moveTo(copy, copy.x + 0.02, copy.y + 0.02));
    state.widgets.push(copy);
    // A group is copied with what it holds (RFC 014 §5.1), each child linked
    // to the copy — a group copied empty is a box the wall would leave out.
    if (widget.type === 'group') {
      for (const child of groupChildren(state.widgets).get(widget.id) ?? []) {
        state.widgets.push(clone(child, { id: randomId(), parentId: copy.id }));
      }
    }
    selection = [copy.id];
    draw();
    markDirty();
  }

  /**
   * Remove the widget the inspector is showing.
   *
   * It used to ask, and the reassurance it offered was "Discard changes brings
   * it back" — which throws away every other edit since the page loaded. That
   * was the confirmation nominating a substitute for an undo that did not
   * exist. It exists now, so the dialogue is gone: the Undo button lights up
   * and Ctrl+Z puts the widget back exactly where it was, options and all.
   */
  function removeSelected(): void {
    const widget = state.widgets.find((w) => w.id === primary());
    if (widget === undefined) return;
    record();
    // A group goes with its children (RFC 014 §5.1) — the button said so —
    // rather than leaving them as rows the server would refuse.
    state.widgets = state.widgets.filter((w) => w.id !== widget.id && parentIdOf(w) !== widget.id);
    clearSelection(false);
    draw();
    markDirty();
  }

  aspectSelect.addEventListener('change', () => {
    record();
    state.aspect = Number(aspectSelect.value) || 0.5625;
    draw();
    markDirty();
  });
  /*
   * A pointer on the empty layout starts a marquee (RFC 014 §5.1): released
   * where it was pressed it is the tap it always was and clears the selection
   * — never stealing focus — and dragged it selects the boxes it encloses,
   * on the layout itself. The rectangle is `selection.ts`'s and so is the
   * enclosure; what is drawn here is only the box the household sees.
   */
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target !== overlay) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const at = (e: PointerEvent): { x: number; y: number } => ({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
    const from = at(event);
    let marquee: HTMLElement | undefined;
    const move = (moveEvent: PointerEvent): void => {
      const box = marqueeBetween(from, at(moveEvent));
      if (box.w < MARQUEE_MIN && box.h < MARQUEE_MIN) return;
      if (marquee === undefined) {
        marquee = document.createElement('div');
        marquee.className = 'le-marquee';
        overlay.appendChild(marquee);
      }
      marquee.style.left = `${box.x * 100}%`;
      marquee.style.top = `${box.y * 100}%`;
      marquee.style.width = `${box.w * 100}%`;
      marquee.style.height = `${box.h * 100}%`;
    };
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (marquee === undefined) {
        clearSelection(false);
        return;
      }
      marquee.remove();
      const box = marqueeBetween(from, at(upEvent));
      const placed = topLevelWidgets(state.widgets).map((w) => ({ ...canvasBoxOf(state.widgets, w), id: w.id }));
      selection = enclosedBy(placed, box);
      markSelection();
      drawLayers();
      renderConfigPanel(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', draw);

  // ---- orientation ------------------------------------------------------

  /*
   * Which orientation the editor was last on, remembered per display so it
   * reopens where the household left it. Each orientation's canvas is saved on
   * its own server rows (RFC 005), but the editor always opened on portrait —
   * so a household that arranged landscape saw portrait next time and read it
   * as "it didn't save". This is only which tab was open, a per-browser UI
   * preference, so localStorage is the right home rather than a schema column;
   * it survives the ingress path changing because it is keyed to the origin.
   */
  const ORIENT_KEY = 'mw-layout-orientation';
  function rememberedOrientation(screen: string | null): 'portrait' | 'landscape' | null {
    try {
      const v = localStorage.getItem(`${ORIENT_KEY}:${screen ?? 'default'}`);
      return v === 'landscape' || v === 'portrait' ? v : null;
    } catch {
      return null;
    }
  }
  function rememberOrientation(screen: string | null, which: 'portrait' | 'landscape'): void {
    try {
      localStorage.setItem(`${ORIENT_KEY}:${screen ?? 'default'}`, which);
    } catch {
      // A browser with storage disabled (private mode) simply forgets the tab.
    }
  }

  /**
   * Swap the active canvas for the other orientation's. Nothing is written.
   *
   * It used to post the canvas being left whenever the editor was dirty — a
   * write nobody asked for on a tab press, whose outcome was discarded and
   * whose dirty flag was cleared either way, so a save that failed was reported
   * as a success (RFC 009 Phase 5). Both canvases are already here: the active
   * one flat in `aspect`/`widgets`, the other in `stash`. What was missing was
   * somewhere to record that the one going into the stash has unsaved work,
   * which is `stashDirty` — and the save bar saves both.
   *
   * A household that arranges portrait, flips to landscape and arranges that
   * still loses neither; it now loses neither to a failed request either.
   */
  function switchOrientation(which: 'portrait' | 'landscape'): void {
    switchCanvas(which, state.slot);
  }

  /** Every widget on every canvas — for the omission flags, which are per box. */
  function allWidgets(): Widget[] {
    return [
      ...state.widgets,
      ...Object.values(state.stash).flatMap((canvas) => canvas.widgets),
    ];
  }

  /**
   * Swap the active canvas for another — the other orientation, another named
   * layout, or both (RFC 014 §5.2). Nothing is written; every canvas is
   * already here, and the save bar saves whichever differ.
   *
   * A slot with no canvas on the arriving orientation gets an empty one at
   * that orientation's own aspect and background, which is honest on the
   * editor where the wall would fall back to the everyday canvas: the
   * household can see it is empty here and copy into it. Within one
   * orientation the arriving canvas takes the leaving one's aspect and
   * background, because those are the orientation's and not the slot's — a
   * size changed on the morning layout is the wall's size.
   */
  function switchCanvas(which: 'portrait' | 'landscape', slot: string | null): void {
    if (which === state.orientation && slot === state.slot) return;

    const leaving: Canvas = {
      aspect: state.aspect,
      widgets: state.widgets,
      ...(state.background !== undefined ? { background: state.background } : {}),
    };
    const arrivingKey = canvasKey(which, slot);
    const sameOrientation = which === state.orientation;
    const fallback: Canvas = sameOrientation
      ? { aspect: leaving.aspect, widgets: [], ...(leaving.background !== undefined ? { background: leaving.background } : {}) }
      : { aspect: state.stash[canvasKey(which, null)]?.aspect ?? (which === 'landscape' ? 1.7778 : 0.5625), widgets: [] };
    const arriving = state.stash[arrivingKey] ?? fallback;
    if (state.stash[arrivingKey] === undefined) {
      // A canvas that never existed reads as saved-empty, so an untouched
      // empty slot on this orientation is not something Save has to write.
      savedSnapshot[arrivingKey] = canvasSnapshot(fallback);
    }
    delete state.stash[arrivingKey];
    state.stash[activeKey()] = leaving;
    state.aspect = sameOrientation ? leaving.aspect : arriving.aspect;
    state.widgets = arriving.widgets;
    state.background = sameOrientation ? leaving.background : arriving.background;
    state.orientation = which;
    state.slot = slot;
    rememberOrientation(state.screen, which);
    selection = [];
    markSlotTabs();

    // Reflect the switch in the toolbar: the active button, and the aspect
    // select. `aria-pressed` moves with the class — the fill and the tick are
    // the sighted half of the same fact, and leaving the state behind is a
    // control that lies to everybody who cannot see it.
    for (const key of ['portrait', 'landscape'] as const) {
      orientButtons[key].classList.toggle('is-on', key === which);
      orientButtons[key].setAttribute('aria-pressed', key === which ? 'true' : 'false');
    }
    syncAspectSelect();
    draw();
    // Both canvases decide the flag now, and the undo button follows the stack
    // belonging to the one that just arrived.
    markDirty();
  }

  /**
   * Start a named layout from the canvas on screen (RFC 014 §5.2).
   *
   * The widgets are copied with fresh ids — a template's rule: two canvases
   * started from one arrangement must not share widget ids, or a box moved on
   * the morning layout would be the same row as the everyday one. The copy
   * lands on the current orientation only; the other orientation's canvas for
   * the new layout starts empty, which the wall reads as "draw the everyday
   * one there" and the editor shows as empty so it can be filled in turn.
   */
  function newSlotFromCurrent(): void {
    if (state.slots.length >= state.maxSlots) return;
    const typed = window.prompt(
      'Name for the new layout — a short word, like morning or evening:',
      '',
    );
    if (typed === null) return;
    const slot = typed.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    if (!SLOT_NAME.test(slot) || state.slots.includes(slot)) return;
    // Fresh ids, and a child re-linked to its group's fresh id (RFC 014
    // §5.1) — copied as-is it would name a group on the layout it came from.
    const minted = new Map(state.widgets.map((widget) => [widget.id, randomId()]));
    const copied: Widget[] = state.widgets.map((widget) => {
      const parent = parentIdOf(widget);
      return {
        ...widget,
        id: minted.get(widget.id) as string,
        ...(parent === undefined ? {} : { parentId: minted.get(parent) ?? parent }),
        ...(widget.config !== undefined
          ? { config: JSON.parse(JSON.stringify(widget.config)) as Record<string, unknown> }
          : {}),
      };
    });
    state.slots.push(slot);
    state.stash[canvasKey(state.orientation, slot)] = {
      aspect: state.aspect,
      widgets: copied,
      ...(state.background !== undefined ? { background: state.background } : {}),
    };
    // Never saved, so it compares against nothing: the copy is unsaved work
    // from the moment it exists, and the bar says so.
    savedSnapshot[canvasKey(state.orientation, slot)] = '';
    drawSlotTabs();
    switchCanvas(state.orientation, slot);
  }

  /**
   * Remove the named layout on screen, on the server and here.
   *
   * On the server first: a layout removed only here would come back on the
   * next load, and its schedule rows with it. The everyday layout cannot be
   * removed, so the button is hidden on it and the server's shape refuses it.
   */
  async function removeCurrentSlot(): Promise<void> {
    const slot = state.slot;
    if (slot === null) return;
    if (!window.confirm(`Remove the “${slot}” layout? Any rule showing it at certain hours goes with it.`)) return;
    try {
      const response = await fetch('admin/layout/remove-slot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ screen: state.screen, slot }),
      });
      if (!response.ok) return;
    } catch {
      return;
    }
    switchCanvas(state.orientation, null);
    state.slots = state.slots.filter((one) => one !== slot);
    for (const orientation of ['portrait', 'landscape'] as const) {
      const key = canvasKey(orientation, slot);
      delete state.stash[key];
      delete savedSnapshot[key];
      delete histories[key];
    }
    drawSlotTabs();
    markDirty();
    // The schedule rows under Wall settings were rendered with that layout on
    // offer. With nothing else unsaved, a reload is the honest refresh; with
    // edits pending it is not, and the settings form refuses a stale row by
    // name rather than losing them.
    if (!dirty) location.reload();
  }

  // ---- save -------------------------------------------------------------

  /**
   * Save one orientation's canvas. Returns the outcome so the host save bar can
   * surface a failure; success clears the dirty flag (and tells the bar).
   */
  async function postCanvas(
    orientation: 'portrait' | 'landscape',
    slot: string | null,
    aspect: number,
    widgets: readonly Widget[],
    background: Background | undefined,
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetch('admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: state.screen,
          orientation,
          // Absent for the everyday canvas, so the body an older server
          // validated is the body it still gets (RFC 014 §5.2).
          ...(slot === null ? {} : { slot }),
          // Always free-form: the "auto" stacked layout was retired. Saving a
          // canvas is what makes a display free-form, and there is no other mode.
          mode: 'freeform',
          aspect: round3(aspect),
          widgets: widgetsForSave(widgets),
          // The canvas background object, or null for none — the shape the
          // server's backgroundSchema validates. An image type with no picture
          // chosen yet is "no background", not a save the server would refuse.
          background: postedBackground(background),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        // What the server now holds. The dirty flag is derived from this, so
        // there is no second place saying whether this canvas is clean.
        savedSnapshot[canvasKey(orientation, slot)] = canvasSnapshot({ aspect, widgets, background });
        return { ok: true };
      }
      return { ok: false, message: body.message ?? 'That did not save.' };
    } catch {
      return { ok: false, message: 'Could not reach the server.' };
    }
  }

  /**
   * Save what is unsaved — the host save bar calls this.
   *
   * Both canvases, because the orientation toggle no longer writes: the one in
   * the stash is posted first and only when it differs from what the server
   * holds, so a household who arranged portrait, switched to landscape and
   * pressed Save keeps both. Its failure is reported rather than swallowed, and
   * it names which layout failed — the household is looking at the other one.
   */
  async function saveCurrent(): Promise<{ ok: boolean; message?: string }> {
    /*
     * Every stashed canvas that differs from what the server holds, then the
     * active one — the other orientation and every named layout alike (RFC
     * 014 §5.2). A canvas the server has never seen and that is still empty
     * compares equal to its saved-empty snapshot and is never posted, so a
     * layout made on portrait alone writes no landscape rows.
     */
    for (const key of Object.keys(state.stash)) {
      const canvas = state.stash[key] as Canvas;
      if (canvasSnapshot(canvas) === (savedSnapshot[key] ?? '')) continue;
      const [orientation, slot] = parseCanvasKey(key);
      const stashed = await postCanvas(orientation, slot, canvas.aspect, canvas.widgets, canvas.background);
      if (!stashed.ok) {
        markDirty();
        const name = slot === null ? orientation : `${orientation} “${slot}”`;
        return { ok: false, message: `Your ${name} layout did not save. ${stashed.message ?? ''}`.trim() };
      }
    }
    const outcome = await postCanvas(state.orientation, state.slot, state.aspect, state.widgets, state.background);
    markDirty();
    return outcome;
  }

  // Publish the bridge the page chrome drives: one sticky save bar saves the
  // layout through here and then submits the settings form. The beforeunload
  // guard lives in the chrome too, keyed on the combined dirty state.
  (window as EditorWindow).mwEditor = { saveCurrent, isDirty: () => dirty };

  // Keep the preview from being referenced-as-unused when a build tightens up.
  void previewShadow;

  /*
   * What the server holds for each canvas, as the strings dirtiness is measured
   * against. Seeded from what was rendered into the page, before anything can
   * switch orientation — a switch compares against these, and a blank one would
   * read as "everything is unsaved" on a canvas nobody has touched.
   */
  savedSnapshot[activeKey()] = activeSnapshot();
  for (const key of Object.keys(state.stash)) {
    savedSnapshot[key] = canvasSnapshot(state.stash[key] as Canvas);
  }

  // Reopen on the orientation last edited on this device — except on a panel,
  // which has exactly one and remembers nothing. The panel case is not a
  // preference: opening a landscape 800x480 panel on the wall's portrait
  // default put the drag boxes on a 9:16 canvas the device cannot draw, so
  // everything arranged there landed somewhere else on the frame. Both
  // canvases were loaded above; switching is a local swap (not dirty at boot,
  // so it saves nothing) and draws the arriving canvas itself.
  const openOn = epaperHost ? (hostOrientation ?? 'landscape') : rememberedOrientation(state.screen);
  if (openOn !== null && openOn !== undefined && openOn !== state.orientation) {
    switchOrientation(openOn);
  } else {
    draw();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
