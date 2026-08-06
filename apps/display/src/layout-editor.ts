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
}

interface LayoutState {
  /** The wall this canvas is for: a screen id, or null for the shared default. */
  screen: string | null;
  mode: 'auto' | 'freeform';
  aspect: number;
  widgets: Widget[];
}

/** The first-party palette. No web embed is offered — the wall cannot draw one. */
const PALETTE: readonly { readonly type: string; readonly label: string }[] = [
  { type: 'clock', label: 'Clock' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'weather', label: 'Weather' },
  { type: 'homeassistant', label: 'Home Assistant' },
  { type: 'shift', label: 'Shift' },
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

  let state: LayoutState;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as Partial<LayoutState>;
    state = {
      screen: typeof parsed.screen === 'string' ? parsed.screen : null,
      mode: parsed.mode === 'freeform' ? 'freeform' : 'auto',
      aspect: typeof parsed.aspect === 'number' && parsed.aspect > 0 ? parsed.aspect : 0.5625,
      widgets: Array.isArray(parsed.widgets) ? (parsed.widgets as Widget[]) : [],
    };
  } catch {
    state = { screen: null, mode: 'auto', aspect: 0.5625, widgets: [] };
  }

  // The wall being edited, as a query for the per-wall endpoints.
  const screenQuery = state.screen === null ? '' : `?screen=${encodeURIComponent(state.screen)}`;

  let selected: string | undefined;
  let dirty = false;

  // The live preview, once it has loaded. Until then the overlay draws with
  // labels, which is a fine fallback and the whole editor if the fetch fails.
  let model: DisplayModel | undefined;
  let manifest: Manifest | undefined;
  let previewShadow: ShadowRoot | undefined;
  let previewWall: HTMLElement | undefined;

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

  const aspectSelect = document.createElement('select');
  aspectSelect.className = 'le-aspect';
  for (const a of ASPECTS) {
    const opt = document.createElement('option');
    opt.value = String(a.value);
    opt.textContent = a.label;
    if (Math.abs(a.value - state.aspect) < 0.01) opt.selected = true;
    aspectSelect.appendChild(opt);
  }

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

  toolbar.append(onToggle, aspectSelect, palette, deleteButton, saveButton, status);

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

  mount.append(toolbar, stage, hint);

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

    // The draft, drawn by the very renderer a wall uses.
    renderFreeform(previewWall, model, {
      aspect: state.aspect,
      widgets: state.widgets.map((w) => ({ ...w })),
    });
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

  /** Everything: size the canvas, redraw the overlay, then the live preview. */
  function draw(): void {
    sizeCanvas();
    drawOverlay();
    renderPreview();
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
        widget.w = round3(Math.min(1 - widget.x, Math.max(0.05, origin.w + dx)));
        widget.h = round3(Math.min(1 - widget.y, Math.max(0.05, origin.h + dy)));
      } else {
        widget.x = round3(clamp01(Math.min(1 - widget.w, origin.x + dx)));
        widget.y = round3(clamp01(Math.min(1 - widget.h, origin.y + dy)));
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
    markDirty();
  });
  aspectSelect.addEventListener('change', () => {
    state.aspect = Number(aspectSelect.value) || 0.5625;
    draw();
    markDirty();
  });
  // A pointer on the empty canvas clears the selection.
  overlay.addEventListener('pointerdown', () => {
    selected = undefined;
    for (const other of overlay.querySelectorAll('.le-widget')) other.classList.remove('is-selected');
    deleteButton.disabled = true;
  });
  window.addEventListener('resize', draw);

  // ---- save -------------------------------------------------------------

  async function save(): Promise<void> {
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    status.className = 'le-status';
    try {
      const response = await fetch('admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: state.screen,
          mode: state.mode,
          aspect: round3(state.aspect),
          widgets: state.widgets.map((w, index) => ({
            id: w.id,
            type: w.type,
            x: round3(clamp01(w.x)),
            y: round3(clamp01(w.y)),
            w: round3(Math.max(0.05, Math.min(1, w.w))),
            h: round3(Math.max(0.05, Math.min(1, w.h))),
            z: index,
          })),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (response.ok) {
        dirty = false;
        status.textContent = 'Saved. The wall updates within a minute.';
        status.className = 'le-status is-ok';
      } else {
        status.textContent = body.message ?? 'That did not save.';
        status.className = 'le-status is-error';
      }
    } catch {
      status.textContent = 'Could not reach the server.';
      status.className = 'le-status is-error';
    } finally {
      saveButton.disabled = false;
    }
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
