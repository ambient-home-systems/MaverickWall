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
import { applyTheme } from './theme.js';
import type { Manifest } from './manifest.js';

interface Widget {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** The widget's own options. Shape validated server-side (widgetConfigBody). */
  config?: Record<string, unknown>;
}

type Background =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'image'; image: string };

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
  // The active canvas is held flat as `aspect`/`widgets` so the whole editor
  // reads and mutates it directly; the other canvas waits in `stash` and the two
  // swap on the orientation toggle. Each is saved under its own orientation.
  aspect: number;
  widgets: Widget[];
  background?: Background | undefined;
  stash: Canvas;
  /** The calendars that exist, for the Calendar widget's "which calendars". */
  calendars: readonly { readonly id: string; readonly name: string }[];
  /** The Home Assistant reading labels resolving now, for the HA widget picker. */
  readings: readonly string[];
  /** The registered modules, for the External widget's "which module". */
  modules: readonly { readonly id: string; readonly name: string }[];
}

/** The first-party palette. No web embed is offered — the wall cannot draw one. */
const PALETTE: readonly { readonly type: string; readonly label: string }[] = [
  { type: 'clock', label: 'Clock' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'weather', label: 'Weather' },
  { type: 'homeassistant', label: 'Home Assistant' },
  { type: 'shift', label: 'Shift' },
  { type: 'countdown', label: 'Countdown' },
  { type: 'notes', label: 'Notes' },
  { type: 'todo', label: 'To-do' },
  { type: 'image', label: 'Image' },
  { type: 'external', label: 'Module' },
];

/** The editor is on the admin page, so its preview reads media behind the session. */
const EDITOR_MEDIA_BASE = 'admin/media/';

/**
 * A layers-list swatch colour per widget type, from the admin token set (so it
 * follows the admin theme). Only to tell the rows apart at a glance — no meaning
 * on the wall. Unknown types fall back to the muted token.
 */
const SWATCH: Readonly<Record<string, string>> = {
  clock: 'var(--accent)',
  calendar: 'var(--night)',
  weather: 'var(--ok)',
  homeassistant: 'var(--warn)',
  shift: 'var(--danger)',
  countdown: 'var(--accent)',
  notes: 'var(--muted)',
  todo: 'var(--night)',
  image: 'var(--ok)',
  external: 'var(--warn)',
};

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
 * The snap grid: 24 steps across each axis (a fraction of the canvas, so it is
 * the same relative grid at any resolution of the authored aspect). Fine enough
 * to place things where you mean, coarse enough to line them up.
 */
const SNAP = 1 / 24;

function labelFor(type: string): string {
  return PALETTE.find((p) => p.type === type)?.label ?? type;
}

function randomId(): string {
  // Enough not to collide across a household's handful of widgets. Not a secret.
  return 'w' + Math.random().toString(36).slice(2, 10);
}

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

  // The viewport this screen last reported, for the "match screen" button.
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

  let state: LayoutState;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as {
      readonly screen?: unknown;
      readonly kind?: unknown;
      readonly mode?: unknown;
      readonly portrait?: RawCanvas;
      readonly landscape?: RawCanvas;
      readonly calendars?: unknown;
      readonly readings?: unknown;
      readonly modules?: unknown;
      readonly report?: { readonly w?: unknown; readonly h?: unknown };
      readonly orientation?: unknown;
      readonly panel?: { readonly width?: unknown; readonly height?: unknown };
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
    // Start on portrait; landscape waits in the stash (RFC 005). 9:16 and 16:9
    // are the per-orientation defaults when a canvas has no aspect yet.
    const portrait = canvasFrom(parsed.portrait, 0.5625);
    const landscape = canvasFrom(parsed.landscape, 1.7778);
    state = {
      screen: typeof parsed.screen === 'string' ? parsed.screen : null,
      mode: parsed.mode === 'freeform' ? 'freeform' : 'auto',
      orientation: 'portrait',
      aspect: portrait.aspect,
      widgets: portrait.widgets,
      ...(portrait.background !== undefined ? { background: portrait.background } : {}),
      stash: landscape,
      calendars: Array.isArray(parsed.calendars) ? (parsed.calendars as LayoutState['calendars']) : [],
      readings: Array.isArray(parsed.readings) ? (parsed.readings as string[]) : [],
      modules: Array.isArray(parsed.modules) ? (parsed.modules as LayoutState['modules']) : [],
    };
  } catch {
    state = {
      screen: null, mode: 'auto', orientation: 'portrait', aspect: 0.5625, widgets: [],
      stash: { aspect: 1.7778, widgets: [] },
      calendars: [], readings: [], modules: [],
    };
  }

  // The wall being edited, as a query for the per-wall endpoints.
  const screenQuery = state.screen === null ? '' : `?screen=${encodeURIComponent(state.screen)}`;

  let selected: string | undefined;
  let dirty = false;
  // Whether the anchored Layers popover is open. UI-only; not saved.
  let layersOpen = false;
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
  // Snap to the grid while dragging. An editor affordance only — the stored
  // coordinates stay fractional, so snapping changes where a widget lands, never
  // how it is saved.
  let snap = false;
  const snapv = (n: number): number => (snap ? round3(Math.round(n / SNAP) * SNAP) : round3(n));

  // The live preview, once it has loaded. Until then the overlay draws with
  // labels, which is a fine fallback and the whole editor if the fetch fails.
  let model: DisplayModel | undefined;
  let manifest: Manifest | undefined;
  let previewShadow: ShadowRoot | undefined;
  // The e-paper designer's backdrop: the panel's own 1-bit frame, fetched from
  // the server for whatever is on the canvas now. Kept as an <img> rather than
  // a second renderer in this bundle — see `renderEpaperPreview`.
  let epaperImage: HTMLImageElement | undefined;
  let epaperObjectUrl: string | undefined;
  let epaperTimer: number | undefined;
  let epaperPending = false;
  let previewWall: HTMLElement | undefined;

  // ---- structure, built once -------------------------------------------

  const toolbar = document.createElement('div');
  toolbar.className = 'le-toolbar';

  // Portrait | Landscape — which of the display's two canvases is being edited.
  const orientToggle = document.createElement('div');
  orientToggle.className = 'le-orient';
  const orientButtons: Record<'portrait' | 'landscape', HTMLButtonElement> = {
    portrait: document.createElement('button'),
    landscape: document.createElement('button'),
  };
  for (const which of ['portrait', 'landscape'] as const) {
    const button = orientButtons[which];
    button.type = 'button';
    button.textContent = which === 'portrait' ? 'Portrait' : 'Landscape';
    button.className = 'le-orient-btn' + (state.orientation === which ? ' is-on' : '');
    button.addEventListener('click', () => void switchOrientation(which));
    orientToggle.appendChild(button);
  }

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
    const size = panelSize === undefined ? '' : `${panelSize.w}\u00d7${panelSize.h} \u00b7 `;
    panelChip.textContent = `${size}${hostOrientation === 'portrait' ? 'portrait' : 'landscape'}`;
  } else {
    panelChip.style.display = 'none';
  }

  const aspectSelect = document.createElement('select');
  aspectSelect.className = 'le-aspect';
  if (epaperHost) aspectSelect.style.display = 'none';
  for (const a of ASPECTS) {
    const opt = document.createElement('option');
    opt.value = String(a.value);
    opt.textContent = a.label;
    if (Math.abs(a.value - state.aspect) < 0.01) opt.selected = true;
    aspectSelect.appendChild(opt);
  }

  // "Match screen" — set the active canvas's aspect to this screen's real
  // reported size, for the orientation being edited. Only a paired screen that
  // has checked in reports one; the shared Default has no single size to match.
  const matchButton = document.createElement('button');
  matchButton.type = 'button';
  matchButton.className = 'le-add';
  if (report !== undefined) {
    const big = Math.max(report.w, report.h);
    const small = Math.min(report.w, report.h);
    matchButton.textContent = `Match screen (${report.w}×${report.h})`;
    matchButton.addEventListener('click', () => {
      // Wide for landscape, tall for portrait, from the same reported pixels.
      state.aspect = round3(state.orientation === 'landscape' ? big / small : small / big);
      syncAspectSelect();
      draw();
      markDirty();
    });
  } else {
    matchButton.style.display = 'none';
  }

  const snapToggle = document.createElement('label');
  snapToggle.className = 'le-toggle';
  const snapInput = document.createElement('input');
  snapInput.type = 'checkbox';
  snapInput.checked = snap;
  snapToggle.appendChild(snapInput);
  snapToggle.appendChild(document.createTextNode(' Snap to grid'));

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
  palette.appendChild(addWidgetButton);

  const modal = document.createElement('div');
  modal.className = 'le-modal';
  modal.hidden = true;
  const openAddModal = (): void => {
    modal.hidden = false;
  };
  const closeAddModal = (): void => {
    modal.hidden = true;
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
      addWidget(item.type);
      closeAddModal();
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

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'le-delete';
  deleteButton.textContent = 'Remove selected';
  deleteButton.addEventListener('click', removeSelected);

  // The toolbar's right cluster: a spacer pushes Template / Reset / Layers to the
  // end (the reference layout). Template and Reset are ordinary admin actions —
  // a link to the gallery and a POST to reset — built here so the whole toolbar
  // is one row. The editor is admin-only, so pointing at admin routes is in
  // keeping with the endpoints it already calls.
  const toolSpacer = document.createElement('span');
  toolSpacer.className = 'le-tool-spacer';

  const templateLink = document.createElement('a');
  templateLink.className = 'le-tool-link';
  templateLink.href = `admin/displays/${detailSeg}/gallery`;
  templateLink.textContent = 'Template';

  const resetForm = document.createElement('form');
  resetForm.className = 'le-reset-form';
  resetForm.method = 'post';
  resetForm.action = `admin/displays/${detailSeg}/reset-layout`;
  resetForm.addEventListener('submit', (event) => {
    const question = epaperHost
      ? 'Reset this panel to its built-in layout? Your current arrangement is removed.'
      : 'Reset this display to the Classic layout? Your current arrangement is replaced.';
    if (!window.confirm(question)) {
      event.preventDefault();
    }
  });
  const resetButton = document.createElement('button');
  resetButton.type = 'submit';
  resetButton.className = 'le-tool-btn';
  resetButton.textContent = 'Reset';
  resetForm.appendChild(resetButton);

  // Layers: a toggle that opens an anchored popover (built below). Anchored to
  // the toolbar, never <body>, so it cannot float over the settings pane.
  const layersButton = document.createElement('button');
  layersButton.type = 'button';
  layersButton.className = 'le-layers-btn';
  layersButton.textContent = 'Layers';

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
  };
  layersButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setLayersOpen(!layersOpen);
  });
  // Click outside the popover (and off its button) closes it; so does Escape.
  document.addEventListener('click', (event) => {
    if (!layersOpen) return;
    const target = event.target as Node;
    if (!layersPopover.contains(target) && target !== layersButton) setLayersOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layersOpen) setLayersOpen(false);
  });

  toolbar.append(
    orientToggle,
    panelChip,
    palette,
    aspectSelect,
    matchButton,
    snapToggle,
    deleteButton,
    toolSpacer,
    templateLink,
    resetForm,
    layersButton,
    layersPopover,
  );

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
  // What an empty canvas actually means, which differs by screen kind — and on
  // neither kind is it "blank". The old wording promised the stacked layout,
  // which was retired with the auto mode in 0.27.0.
  hint.textContent = epaperHost
    ? 'Nothing is placed yet — add a widget above. Until you do, this panel ' +
      'draws its built-in layout, which is what the preview shows.'
    : 'Nothing is placed yet — add a widget above. Until you do, the wall ' +
      'shows a short note in place of a layout rather than going blank.';

  // The canvas background control (RFC 005 Phase 3): none, a solid colour, or a
  // gradient. Per canvas, so it swaps with the orientation like the widgets do.
  const backgroundPanel = document.createElement('div');
  backgroundPanel.className = 'le-bg';

  // The layers list — every widget, front on top, drag a row to restack, click
  // to select — lives in the anchored popover built in the toolbar above, not
  // as an inline panel here.

  // The per-widget options, shown under the stage when a widget is selected.
  const configPanel = document.createElement('div');
  configPanel.className = 'le-config';
  configPanel.style.display = 'none';

  mount.append(toolbar, backgroundPanel, stage, configPanel, hint, modal);

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
      styleEl.textContent = css;
      const wall = document.createElement('div');
      wall.className = 'preview-wall';
      shadow.append(styleEl, wall);
      previewShadow = shadow;
      previewWall = wall;

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
    if (model === undefined || previewWall === undefined || manifest === undefined) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // Render at a reference resolution, then scale the whole wall down to this
    // box with a transform — rather than rendering it at the box's own small
    // pixel size.
    //
    // Why: the reused sections (weather, the agenda, the shift badge…) size
    // their type in `rem`. On a real wall `orientation.ts` sets the document
    // root's font-size to --root-size (one percent of the canvas height), so a
    // rem tracks the canvas and `fitToBox` grows or shrinks each section to fill
    // its box in proportion. Inside this preview the wall lives in a shadow root,
    // and `rem` always resolves against the *document* root — the admin page's
    // 16px — which the display's own `html { font-size: … }` rule cannot touch
    // (a shadow root has no <html>). Rendered at the box's small pixel size, then,
    // every rem-based section came out huge next to its box, so fit-to-fill hit
    // its readable floor and clipped: the preview disagreed with the wall it is
    // meant to mirror. Rendering at the resolution where the document's own rem
    // *is* one percent of the canvas height (height = rem × 100) restores the
    // wall's proportion, and the transform is visual only — `fitToBox` measures
    // untransformed layout sizes, so the fit is computed exactly as on a wall.
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const refH = rootPx * 100;
    const refW = refH * state.aspect;
    previewWall.style.width = `${refW}px`;
    previewWall.style.height = `${refH}px`;
    previewWall.style.setProperty('--frame-w', `${refW}px`);
    previewWall.style.setProperty('--frame-h', `${refH}px`);
    previewWall.style.setProperty('--root-size', `${rootPx}px`);
    // Taken out of flow so its full-resolution layout box cannot push the shadow
    // host around; the transform then fits it exactly to this box (both share the
    // canvas aspect, so width and height scale by the same factor).
    previewWall.style.position = 'absolute';
    previewWall.style.top = '0';
    previewWall.style.left = '0';
    previewWall.style.transformOrigin = 'top left';
    previewWall.style.transform = `scale(${rect.height / refH})`;
    applyTheme(previewWall, manifest.theme.active);

    // The wall as it will actually draw — always free-form now. It draws straight
    // into the shadow wall: the reused sections measure themselves and scale to
    // their box, so they are indifferent to the shadow root having no root
    // font-size of its own.
    renderFreeform(previewWall, model, {
      aspect: state.aspect,
      widgets: state.widgets.map((w) => ({ ...w })),
      ...(state.background !== undefined ? { background: state.background } : {}),
    }, EDITOR_MEDIA_BASE);
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
        body: JSON.stringify({ widgets: widgetsForSave(state.widgets) }),
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

  function markDirty(): void {
    setDirty(true);
  }

  function sizeCanvas(): void {
    // A bigger canvas: the editor is the main surface now, so give it more room
    // to drag in than the old inline-below-the-settings size. The left pane is
    // sticky, so cap the height to the viewport too — a tall portrait canvas
    // must not run off the bottom and take the preview out of view.
    const maxW = Math.min(stage.clientWidth || 360, 720);
    const maxH = Math.min(720, Math.max(360, window.innerHeight - 220));
    let w = maxW;
    let h = w / state.aspect;
    if (h > maxH) {
      h = maxH;
      w = h * state.aspect;
    }
    canvas.style.width = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(h)}px`;
  }

  /** Rebuild the overlay boxes from state. Cheap — a box is a div and a label. */
  function drawOverlay(): void {
    overlay.textContent = '';
    const ordered = [...state.widgets].sort((a, b) => a.z - b.z);
    for (const widget of ordered) overlay.appendChild(overlayNode(widget));
    hint.style.display = state.widgets.length === 0 ? '' : 'none';
    deleteButton.disabled = selected === undefined;
    renderConfigPanel();
  }

  function overlayNode(widget: Widget): HTMLElement {
    const box = document.createElement('div');
    box.className = 'le-widget' + (widget.id === selected ? ' is-selected' : '');
    box.dataset['id'] = widget.id;
    positionBox(box, widget);
    box.style.zIndex = String(widget.z);

    const label = document.createElement('span');
    label.className = 'le-widget-label';
    label.textContent = labelFor(widget.type);
    box.appendChild(label);

    const handle = document.createElement('span');
    handle.className = 'le-handle';
    box.appendChild(handle);

    box.addEventListener('pointerdown', (event) => startDrag(event, widget, box, false));
    handle.addEventListener('pointerdown', (event) => startDrag(event, widget, box, true));
    return box;
  }

  function positionBox(box: HTMLElement, widget: Widget): void {
    box.style.left = `${widget.x * 100}%`;
    box.style.top = `${widget.y * 100}%`;
    box.style.width = `${widget.w * 100}%`;
    box.style.height = `${widget.h * 100}%`;
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

    for (const widget of [...state.widgets].sort((a, b) => b.z - a.z)) {
      const row = document.createElement('div');
      row.className = 'le-layer' + (widget.id === selected ? ' is-selected' : '');
      row.dataset['id'] = widget.id;

      const grip = document.createElement('span');
      grip.className = 'le-layer-grip';
      grip.textContent = '⋮⋮';
      grip.addEventListener('pointerdown', (event) => startReorder(event, widget));

      const swatch = document.createElement('span');
      swatch.className = 'le-layer-swatch';
      swatch.style.background = SWATCH[widget.type] ?? 'var(--muted)';

      const name = document.createElement('span');
      name.className = 'le-layer-name';
      name.textContent = labelFor(widget.type);

      row.append(grip, swatch, name);
      row.addEventListener('click', () => {
        selected = widget.id;
        drawOverlay();
        drawLayers();
      });
      layersPanel.appendChild(row);
    }
  }

  /**
   * Drag a layer row to restack. The dragged row follows the pointer; the row it
   * is over decides the new order, and z is reassigned from the list on release
   * so the canvas stacking matches the list. Pointer-based, like the canvas drag,
   * for the same reason — a synthetic pointer and a drag that leaves the row.
   */
  function startReorder(event: PointerEvent, widget: Widget): void {
    event.preventDefault();
    event.stopPropagation();
    // Front-first working order of ids.
    let order = [...state.widgets].sort((a, b) => b.z - a.z).map((w) => w.id);

    const move = (moveEvent: PointerEvent): void => {
      const rows = Array.from(layersPanel.querySelectorAll<HTMLElement>('.le-layer'));
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
      selected = widget.id;
      drawLayers();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draw();
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
      input.addEventListener('change', () => { onChange(input.value); renderPreview(); markDirty(); });
      return input;
    };

    const bg = state.background;
    if (bg?.type === 'image') {
      backgroundPanel.appendChild(
        mediaPicker(bg.image === '' ? undefined : bg.image, (name) => {
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
        const n = Math.round(Number(angle.value));
        bg.angle = Number.isFinite(n) ? ((n % 360) + 360) % 360 : 180;
        renderPreview();
        markDirty();
      });
      backgroundPanel.appendChild(angle);
    }
  }

  /** Everything: size the canvas, redraw the overlay, layers and background, then preview. */
  function draw(): void {
    sizeCanvas();
    drawOverlay();
    drawLayers();
    drawBackgroundPanel();
    renderPreview();
  }

  // ---- per-widget config ------------------------------------------------

  /** Merge one option into the selected widget's config, dropping empties. */
  function setConfig(widget: Widget, key: string, value: unknown): void {
    const cfg: Record<string, unknown> = { ...(widget.config ?? {}) };
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (empty) delete cfg[key];
    else cfg[key] = value;
    if (Object.keys(cfg).length > 0) widget.config = cfg;
    else delete widget.config;
    markDirty();
    renderPreview();
  }

  function cfgField(label: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'le-cfg-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    return wrap;
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

  function renderConfigPanel(): void {
    configPanel.textContent = '';
    const widget = state.widgets.find((w) => w.id === selected);
    if (widget === undefined) {
      configPanel.style.display = 'none';
      return;
    }
    configPanel.style.display = '';
    const title = document.createElement('div');
    title.className = 'kick';
    title.textContent = labelFor(widget.type) + ' options';
    configPanel.appendChild(title);

    // Layering moved to the Layers list below the canvas (drag a row to
    // restack); the per-widget front/back buttons it replaces are gone.
    const cfg = widget.config ?? {};
    if (widget.type === 'calendar') buildCalendarConfig(widget, cfg);
    else if (widget.type === 'homeassistant') buildHaConfig(widget, cfg);
    else if (widget.type === 'countdown') buildCountdownConfig(widget, cfg);
    else if (widget.type === 'external') buildExternalConfig(widget, cfg);
    else if (widget.type === 'notes') buildNotesConfig(widget, cfg);
    else if (widget.type === 'todo') buildTodoConfig(widget, cfg);
    else if (widget.type === 'image') buildImageConfig(widget, cfg);
    // Every widget gets the Format section — it is all box-level.
    buildFormatConfig(widget, cfg);
  }

  function buildExternalConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('Module');
    if (state.modules.length === 0) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'No modules yet — add one on the Add-ons screen first.';
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

  function buildTodoConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const field = cfgField('Items (one per line)');
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
  }

  function optionSelect(
    options: readonly (readonly [string, string])[],
    current: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const select = document.createElement('select');
    for (const [value, label] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function toggle(label: string, on: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'le-cfg-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(' ' + label));
    return wrap;
  }

  function buildFormatConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const heading = document.createElement('div');
    heading.className = 'kick';
    heading.style.marginTop = '18px';
    heading.textContent = 'Format';
    configPanel.appendChild(heading);

    // Title — countdown sets its own label in Settings (the same `title` key),
    // so offering it again here would be two fields for one value.
    if (widget.type !== 'countdown') {
      const titleField = cfgField('Title');
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.maxLength = 60;
      titleInput.placeholder = 'e.g. This week';
      titleInput.value = typeof cfg['title'] === 'string' ? (cfg['title'] as string) : '';
      titleInput.addEventListener('change', () => setConfig(widget, 'title', titleInput.value.trim()));
      titleField.appendChild(titleInput);
      configPanel.appendChild(titleField);
      configPanel.appendChild(
        toggle('Show title on the wall', cfg['showTitle'] === true, (checked) =>
          setConfig(widget, 'showTitle', checked ? true : undefined),
        ),
      );
    }

    // Alignment — 'left' is the default, stored as an absence.
    const alignField = cfgField('Text alignment');
    alignField.appendChild(
      optionSelect(
        [
          ['left', 'Left'],
          ['center', 'Centre'],
          ['right', 'Right'],
        ],
        typeof cfg['align'] === 'string' ? (cfg['align'] as string) : 'left',
        (value) => setConfig(widget, 'align', value === 'left' ? undefined : value),
      ),
    );
    configPanel.appendChild(alignField);

    // Background
    const hasBg = typeof cfg['background'] === 'string';
    configPanel.appendChild(
      toggle('Give it a background', hasBg, (checked) => {
        setConfig(widget, 'background', checked ? '#111820' : undefined);
        if (!checked) setConfig(widget, 'opacity', undefined);
        renderConfigPanel();
      }),
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

    // Corners — 'square' is the default.
    const cornersField = cfgField('Corners');
    cornersField.appendChild(
      optionSelect(
        [
          ['square', 'Square'],
          ['rounded', 'Rounded'],
        ],
        typeof cfg['corners'] === 'string' ? (cfg['corners'] as string) : 'square',
        (value) => setConfig(widget, 'corners', value === 'square' ? undefined : value),
      ),
    );
    configPanel.appendChild(cornersField);

    configPanel.appendChild(
      toggle('Drop shadow', cfg['shadow'] === true, (checked) =>
        setConfig(widget, 'shadow', checked ? true : undefined),
      ),
    );
  }

  function buildCalendarConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const currentMode = typeof cfg['mode'] === 'string' ? (cfg['mode'] as string) : 'month';
    const modeField = cfgField('Style');
    const modeSelect = document.createElement('select');
    for (const [value, label] of [
      ['month', 'Month grid'],
      ['week', 'Week columns'],
      ['list', 'Upcoming list'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (currentMode === value) opt.selected = true;
      modeSelect.appendChild(opt);
    }
    modeSelect.addEventListener('change', () => {
      // 'month' is the default, so it is stored as an absence rather than a key.
      setConfig(widget, 'mode', modeSelect.value === 'month' ? undefined : modeSelect.value);
      renderConfigPanel();
    });
    modeField.appendChild(modeSelect);
    configPanel.appendChild(modeField);

    // Month cells: quiet dots, or Skylight-style labelled event pills.
    if (currentMode === 'month') {
      const eventsField = cfgField('Events in a day');
      eventsField.appendChild(
        optionSelect(
          [
            ['dots', 'Dots'],
            ['pills', 'Labelled pills'],
          ],
          cfg['cellEvents'] === 'pills' ? 'pills' : 'dots',
          (value) => setConfig(widget, 'cellEvents', value === 'pills' ? 'pills' : undefined),
        ),
      );
      configPanel.appendChild(eventsField);
    }

    // Which calendars to show — for the week columns and the agenda, where
    // filtering means something; the month grid is a whole month at a glance.
    if (currentMode === 'week') {
      const which = cfgField('Calendars to show');
      which.appendChild(
        checkList(
          state.calendars.map((c) => ({ value: c.id, label: c.name })),
          Array.isArray(cfg['calendars']) ? (cfg['calendars'] as string[]) : [],
          (values) => setConfig(widget, 'calendars', values),
          'No calendars yet — add one on the Calendars screen.',
        ),
      );
      configPanel.appendChild(which);
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'None ticked shows them all.';
      configPanel.appendChild(note);
    }

    // Filtering plus a count for the list — the agenda.
    if (currentMode === 'list') {
      const which = cfgField('Calendars to show');
      which.appendChild(
        checkList(
          state.calendars.map((c) => ({ value: c.id, label: c.name })),
          Array.isArray(cfg['calendars']) ? (cfg['calendars'] as string[]) : [],
          (values) => setConfig(widget, 'calendars', values),
          'No calendars yet — add one on the Calendars screen.',
        ),
      );
      configPanel.appendChild(which);
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'None ticked shows them all.';
      configPanel.appendChild(note);

      const countField = cfgField('How many events');
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
        toggle('Show the forecast', cfg['showWeather'] === true, (checked) =>
          setConfig(widget, 'showWeather', checked ? true : undefined),
        ),
      );
    }
  }

  function buildHaConfig(widget: Widget, cfg: Record<string, unknown>): void {
    const which = cfgField('Readings to show');
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
    configPanel.appendChild(note);
  }

  // ---- pointer interaction ---------------------------------------------

  function startDrag(event: PointerEvent, widget: Widget, box: HTMLElement, resizing: boolean): void {
    event.preventDefault();
    event.stopPropagation();
    selected = widget.id;
    widget.z = Math.max(0, ...state.widgets.map((w) => w.z)) + 1;
    box.style.zIndex = String(widget.z);
    for (const other of overlay.querySelectorAll('.le-widget')) other.classList.remove('is-selected');
    box.classList.add('is-selected');
    deleteButton.disabled = false;
    renderConfigPanel();
    drawLayers();

    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

    /*
     * Move and up on the window, not the box — a drag routinely leaves the box,
     * and pointer capture throws on the synthetic pointer a test dispatches.
     *
     * Only the dragged box's position is updated here, not the whole overlay
     * and certainly not the preview: re-rendering a month grid on every pointer
     * move would judder. The preview catches up once, on release.
     */
    const move = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      if (resizing) {
        widget.w = snapv(Math.min(1 - widget.x, Math.max(0.05, origin.w + dx)));
        widget.h = snapv(Math.min(1 - widget.y, Math.max(0.05, origin.h + dy)));
      } else {
        widget.x = snapv(clamp01(Math.min(1 - widget.w, origin.x + dx)));
        widget.y = snapv(clamp01(Math.min(1 - widget.h, origin.y + dy)));
      }
      positionBox(box, widget);
      markDirty();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      renderPreview();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- mutations --------------------------------------------------------

  function addWidget(type: string): void {
    const z = Math.max(0, ...state.widgets.map((w) => w.z), 0) + 1;
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
    selected = state.widgets[state.widgets.length - 1]!.id;
    draw();
    markDirty();
  }

  function removeSelected(): void {
    if (selected === undefined) return;
    state.widgets = state.widgets.filter((w) => w.id !== selected);
    selected = undefined;
    draw();
    markDirty();
  }

  aspectSelect.addEventListener('change', () => {
    state.aspect = Number(aspectSelect.value) || 0.5625;
    draw();
    markDirty();
  });
  snapInput.addEventListener('change', () => {
    snap = snapInput.checked;
    // The grid is drawn on the overlay only while snapping, as a placement aid;
    // it is not part of the wall. Sizes are a percentage of the canvas, so the
    // lines fall exactly on the snap steps at any canvas size.
    overlay.classList.toggle('is-snapping', snap);
    overlay.style.backgroundSize = snap ? `${SNAP * 100}% ${SNAP * 100}%` : '';
  });
  // A pointer on the empty canvas clears the selection.
  overlay.addEventListener('pointerdown', () => {
    selected = undefined;
    for (const other of overlay.querySelectorAll('.le-widget')) other.classList.remove('is-selected');
    deleteButton.disabled = true;
    renderConfigPanel();
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
   * Swap the active canvas for the other orientation's.
   *
   * The canvas you leave is saved first if it has unsaved changes, so a
   * household that arranges portrait, flips to landscape and arranges that loses
   * neither — each orientation is its own row set on the server (RFC 005). The
   * active canvas lives flat in `aspect`/`widgets`; the other waits in `stash`,
   * and this is the one place they trade.
   */
  async function switchOrientation(which: 'portrait' | 'landscape'): Promise<void> {
    if (which === state.orientation) return;
    if (dirty) await postCanvas(state.orientation, state.aspect, state.widgets, state.background);

    const leaving: Canvas = {
      aspect: state.aspect,
      widgets: state.widgets,
      ...(state.background !== undefined ? { background: state.background } : {}),
    };
    state.aspect = state.stash.aspect;
    state.widgets = state.stash.widgets;
    state.background = state.stash.background;
    state.stash = leaving;
    state.orientation = which;
    rememberOrientation(state.screen, which);
    selected = undefined;
    // The leaving canvas was saved above if it was dirty; the arriving one is
    // clean until touched. Tell the save bar.
    setDirty(false);

    // Reflect the switch in the toolbar: the active button, and the aspect select.
    for (const key of ['portrait', 'landscape'] as const) {
      orientButtons[key].classList.toggle('is-on', key === which);
    }
    syncAspectSelect();
    draw();
  }

  // ---- save -------------------------------------------------------------

  /** The widgets, sorted back-to-front and clamped, as the server wants them. */
  function widgetsForSave(widgets: readonly Widget[]): unknown[] {
    return [...widgets]
      .sort((a, b) => a.z - b.z)
      .map((w, index) => ({
        id: w.id,
        type: w.type,
        x: round3(clamp01(w.x)),
        y: round3(clamp01(w.y)),
        w: round3(Math.max(0.05, Math.min(1, w.w))),
        h: round3(Math.max(0.05, Math.min(1, w.h))),
        z: index,
        // Only when it holds something, so an untouched widget stores no config
        // row and the server sees a clean absence rather than `{}`.
        ...(w.config !== undefined && Object.keys(w.config).length > 0 ? { config: w.config } : {}),
      }));
  }

  /**
   * Save one orientation's canvas. Returns the outcome so the host save bar can
   * surface a failure; success clears the dirty flag (and tells the bar).
   */
  async function postCanvas(
    orientation: 'portrait' | 'landscape',
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
          // Always free-form: the "auto" stacked layout was retired. Saving a
          // canvas is what makes a display free-form, and there is no other mode.
          mode: 'freeform',
          aspect: round3(aspect),
          widgets: widgetsForSave(widgets),
          // The canvas background object, or null for none — the shape the
          // server's backgroundSchema validates. An image type with no picture
          // chosen yet is "no background", not a save the server would refuse.
          background:
            background !== undefined && !(background.type === 'image' && background.image === '')
              ? background
              : null,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        setDirty(false);
        return { ok: true };
      }
      return { ok: false, message: body.message ?? 'That did not save.' };
    } catch {
      return { ok: false, message: 'Could not reach the server.' };
    }
  }

  /** Save the canvas being edited now — the host save bar calls this. */
  async function saveCurrent(): Promise<{ ok: boolean; message?: string }> {
    return postCanvas(state.orientation, state.aspect, state.widgets, state.background);
  }

  // Publish the bridge the page chrome drives: one sticky save bar saves the
  // layout through here and then submits the settings form. The beforeunload
  // guard lives in the chrome too, keyed on the combined dirty state.
  (window as EditorWindow).mwEditor = { saveCurrent, isDirty: () => dirty };

  // Keep the preview from being referenced-as-unused when a build tightens up.
  void previewShadow;

  // Reopen on the orientation last edited on this device — except on a panel,
  // which has exactly one and remembers nothing. The panel case is not a
  // preference: opening a landscape 800x480 panel on the wall's portrait
  // default put the drag boxes on a 9:16 canvas the device cannot draw, so
  // everything arranged there landed somewhere else on the frame. Both
  // canvases were loaded above; switching is a local swap (not dirty at boot,
  // so it saves nothing) and draws the arriving canvas itself.
  const openOn = epaperHost ? (hostOrientation ?? 'landscape') : rememberedOrientation(state.screen);
  if (openOn !== null && openOn !== undefined && openOn !== state.orientation) {
    void switchOrientation(openOn);
  } else {
    draw();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
