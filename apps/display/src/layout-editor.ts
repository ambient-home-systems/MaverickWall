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

import { render, renderFreeform } from './render.js';
import { buildModel, type DisplayModel } from './viewmodel.js';
import { applyTheme } from './theme.js';
import { geometryFor } from './orientation.js';
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

interface Canvas {
  aspect: number;
  widgets: Widget[];
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
  { type: 'external', label: 'Module' },
];

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
  const mount = document.getElementById('layout-editor');
  if (mount === null) return;

  interface RawCanvas {
    readonly aspect?: unknown;
    readonly widgets?: unknown;
  }
  const canvasFrom = (raw: RawCanvas | undefined, fallbackAspect: number): Canvas => ({
    aspect: typeof raw?.aspect === 'number' && raw.aspect > 0 ? raw.aspect : fallbackAspect,
    widgets: Array.isArray(raw?.widgets) ? (raw.widgets as Widget[]) : [],
  });

  // The viewport this screen last reported, for the "match screen" button.
  // Editor-only, so it lives beside the state rather than in it.
  let report: { readonly w: number; readonly h: number } | undefined;

  let state: LayoutState;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as {
      readonly screen?: unknown;
      readonly mode?: unknown;
      readonly portrait?: RawCanvas;
      readonly landscape?: RawCanvas;
      readonly calendars?: unknown;
      readonly readings?: unknown;
      readonly modules?: unknown;
      readonly report?: { readonly w?: unknown; readonly h?: unknown };
    };
    const r = parsed.report;
    if (r !== undefined && typeof r.w === 'number' && typeof r.h === 'number' && r.w > 0 && r.h > 0) {
      report = { w: r.w, h: r.h };
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
  let previewWall: HTMLElement | undefined;
  // The display's stylesheet, kept for the stacked preview's iframe (below).
  let previewCss: string | undefined;

  // ---- structure, built once -------------------------------------------

  const toolbar = document.createElement('div');
  toolbar.className = 'le-toolbar';

  const onToggle = document.createElement('label');
  onToggle.className = 'le-toggle';
  const onInput = document.createElement('input');
  onInput.type = 'checkbox';
  onInput.checked = state.mode === 'freeform';
  onToggle.appendChild(onInput);
  onToggle.appendChild(document.createTextNode(' Use this layout on the wall'));

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

  const aspectSelect = document.createElement('select');
  aspectSelect.className = 'le-aspect';
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

  const palette = document.createElement('div');
  palette.className = 'le-palette';
  for (const item of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'le-add';
    button.textContent = '+ ' + item.label;
    button.addEventListener('click', () => addWidget(item.type));
    palette.appendChild(button);
  }

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'le-delete';
  deleteButton.textContent = 'Remove selected';
  deleteButton.addEventListener('click', removeSelected);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'le-save';
  saveButton.textContent = 'Save';
  saveButton.addEventListener('click', () => void save());

  const status = document.createElement('span');
  status.className = 'le-status';

  toolbar.append(onToggle, orientToggle, aspectSelect, matchButton, snapToggle, palette, deleteButton, saveButton, status);

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
  overlay.className = 'le-overlay';
  canvas.append(preview, overlay);
  stage.appendChild(canvas);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Nothing is placed yet — add a widget above. Turning the layout on with an ' +
    'empty canvas keeps the stacked layout, so the wall is never blank.';

  // The layers list — every widget, front on top, drag a row to restack, click
  // to select. It replaces the per-widget send-to-back/bring-to-front buttons.
  const layersPanel = document.createElement('div');
  layersPanel.className = 'le-layers';
  layersPanel.style.display = 'none';

  // The per-widget options, shown under the stage when a widget is selected.
  const configPanel = document.createElement('div');
  configPanel.className = 'le-config';
  configPanel.style.display = 'none';

  mount.append(toolbar, stage, layersPanel, configPanel, hint);

  // ---- the live preview ------------------------------------------------

  // Load the real manifest and the display's stylesheet, then draw the preview.
  // Both behind the session; a failure just leaves the labelled overlay.
  void (async (): Promise<void> => {
    try {
      const [manifestRes, cssRes] = await Promise.all([
        fetch(`admin/layout/preview.json${screenQuery}`),
        fetch('assets/display.css'),
      ]);
      if (!manifestRes.ok || !cssRes.ok) return;
      manifest = (await manifestRes.json()) as Manifest;
      const css = await cssRes.text();
      previewCss = css;

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
    if (model === undefined || previewWall === undefined || manifest === undefined) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // Give the display's own layout the frame it expects: no rotation, the
    // canvas exactly this box, and a rem that is one percent of its height —
    // the same relationship `orientation.ts` sets on a real wall.
    previewWall.style.width = `${rect.width}px`;
    previewWall.style.height = `${rect.height}px`;
    previewWall.style.setProperty('--frame-w', `${rect.width}px`);
    previewWall.style.setProperty('--frame-h', `${rect.height}px`);
    previewWall.style.setProperty('--root-size', `${rect.height / 100}px`);
    applyTheme(previewWall, manifest.theme.active);

    // The wall as it will actually draw. With the layout switched on, that is
    // the free-form draft; with it off, the wall draws the stacked blocks — so
    // the preview shows the stacked layout too, rather than a canvas the wall
    // would never use.
    //
    // Free-form draws straight into the shadow wall: its reused sections measure
    // themselves and scale to their box, so they are indifferent to the shadow
    // root having no root font-size of its own. The *stacked* layout is not — it
    // relies on the display's `:root`/viewport CSS (`html { font-size:
    // var(--root-size, calc(100vh/100)) }`, `:root[data-layout]`), none of which
    // matches inside a shadow tree, so it renders blown up. So the stacked branch
    // draws in an iframe — a real document — exactly as the theme builder does.
    if (state.mode === 'freeform') {
      renderFreeform(previewWall, model, {
        aspect: state.aspect,
        widgets: state.widgets.map((w) => ({ ...w })),
      });
    } else {
      renderStacked(rect);
    }
  }

  /**
   * The stacked preview, drawn in an iframe so the display's document-root CSS
   * (rem basis and `:root[...]` layout rules) applies exactly as on a screen.
   * Stacked rendering is pure CSS — it takes no measurements — so the wall can be
   * built here and its static HTML handed to the iframe.
   */
  function renderStacked(rect: DOMRect): void {
    if (model === undefined || manifest === undefined || previewWall === undefined || previewCss === undefined) {
      return;
    }
    const built = document.createElement('div');
    render(built, model);
    const html = built.innerHTML;
    const theme = manifest.theme;
    const blocks = model.blocks.join(' ');

    const frame = document.createElement('iframe');
    frame.title = 'Wall preview';
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText = `display:block;border:0;width:${rect.width}px;height:${rect.height}px`;
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      const wall = doc?.getElementById('wall');
      if (doc === null || doc === undefined || wall === null || wall === undefined) return;
      wall.innerHTML = html;
      // Set the frame up exactly as a real screen (orientation.ts), from this
      // box's own shape, so the preview reflects how the wall would lay out here.
      const g = geometryFor({ width: frame.clientWidth, height: frame.clientHeight }, 0, 'auto');
      const root = doc.documentElement;
      root.setAttribute('data-layout', g.layout);
      root.setAttribute('data-blocks', blocks);
      root.style.setProperty('--frame-w', g.frame.width);
      root.style.setProperty('--frame-h', g.frame.height);
      root.style.setProperty('--root-size', g.rootFontSize);
      applyTheme(root, theme.active, theme.activeTokens, theme.activeShape);
    });
    frame.srcdoc =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<style>${previewCss}</style></head><body><div id="wall"></div></body></html>`;
    previewWall.replaceChildren(frame);
  }

  // ---- the draggable overlay -------------------------------------------

  function markDirty(): void {
    dirty = true;
    status.textContent = 'Unsaved changes';
    status.className = 'le-status is-dirty';
  }

  function sizeCanvas(): void {
    const maxW = Math.min(stage.clientWidth || 360, 520);
    const maxH = 560;
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
      layersPanel.style.display = 'none';
      return;
    }
    layersPanel.style.display = '';
    const heading = document.createElement('div');
    heading.className = 'kick';
    heading.textContent = 'Layers';
    layersPanel.appendChild(heading);

    for (const widget of [...state.widgets].sort((a, b) => b.z - a.z)) {
      const row = document.createElement('div');
      row.className = 'le-layer' + (widget.id === selected ? ' is-selected' : '');
      row.dataset['id'] = widget.id;

      const grip = document.createElement('span');
      grip.className = 'le-layer-grip';
      grip.textContent = '⋮⋮';
      grip.addEventListener('pointerdown', (event) => startReorder(event, widget));

      const name = document.createElement('span');
      name.className = 'le-layer-name';
      name.textContent = labelFor(widget.type);

      row.append(grip, name);
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

  /** Everything: size the canvas, redraw the overlay and layers, then preview. */
  function draw(): void {
    sizeCanvas();
    drawOverlay();
    drawLayers();
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
    const modeField = cfgField('Show as');
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

  onInput.addEventListener('change', () => {
    state.mode = onInput.checked ? 'freeform' : 'auto';
    // The preview follows the switch: free-form draft on, stacked blocks off.
    renderPreview();
    markDirty();
  });
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
    if (dirty) await postCanvas(state.orientation, state.aspect, state.widgets, false);

    const leaving: Canvas = { aspect: state.aspect, widgets: state.widgets };
    state.aspect = state.stash.aspect;
    state.widgets = state.stash.widgets;
    state.stash = leaving;
    state.orientation = which;
    selected = undefined;
    dirty = false;

    // Reflect the switch in the toolbar: the active button, and the aspect select.
    for (const key of ['portrait', 'landscape'] as const) {
      orientButtons[key].classList.toggle('is-on', key === which);
    }
    syncAspectSelect();
    status.textContent = `Editing ${which}`;
    status.className = 'le-status';
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
   * Save one orientation's canvas. `announce` shows the status line — the Save
   * button announces; the auto-save on an orientation switch is quiet.
   */
  async function postCanvas(
    orientation: 'portrait' | 'landscape',
    aspect: number,
    widgets: readonly Widget[],
    announce = true,
  ): Promise<boolean> {
    if (announce) {
      saveButton.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'le-status';
    }
    try {
      const response = await fetch('admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: state.screen,
          orientation,
          mode: state.mode,
          aspect: round3(aspect),
          widgets: widgetsForSave(widgets),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        dirty = false;
        if (announce) {
          status.textContent = 'Saved. The wall updates within a minute.';
          status.className = 'le-status is-ok';
        }
        return true;
      }
      if (announce) {
        status.textContent = body.message ?? 'That did not save.';
        status.className = 'le-status is-error';
      }
      return false;
    } catch {
      if (announce) {
        status.textContent = 'Could not reach the server.';
        status.className = 'le-status is-error';
      }
      return false;
    } finally {
      if (announce) saveButton.disabled = false;
    }
  }

  /** The Save button: save the canvas being edited now. */
  async function save(): Promise<void> {
    await postCanvas(state.orientation, state.aspect, state.widgets);
  }

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Keep the preview from being referenced-as-unused when a build tightens up.
  void previewShadow;

  draw();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
