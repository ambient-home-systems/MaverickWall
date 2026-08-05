/**
 * The free-form layout editor — the admin's one client-side app.
 *
 * Vanilla TS, no framework, ES2019, same-origin: it ships in the image and
 * loads only on the admin Layout page, never on a wall. The server rendered the
 * shell and the current layout as JSON; this makes it a canvas you drag on and
 * a Save that posts the result back.
 *
 * Coordinates are fractions of the canvas throughout, the same as the manifest,
 * so what is dragged here is what the wall draws. The canvas on screen is only
 * a scaled preview of that fraction space — the maths is all 0..1.
 */

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
  // Enough to not collide across a household's handful of widgets. Not a secret.
  return 'w' + Math.random().toString(36).slice(2, 10);
}

function boot(): void {
  const mount = document.getElementById('layout-editor');
  if (mount === null) return;

  let state: LayoutState;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as Partial<LayoutState>;
    state = {
      mode: parsed.mode === 'freeform' ? 'freeform' : 'auto',
      aspect: typeof parsed.aspect === 'number' && parsed.aspect > 0 ? parsed.aspect : 0.5625,
      widgets: Array.isArray(parsed.widgets) ? (parsed.widgets as Widget[]) : [],
    };
  } catch {
    state = { mode: 'auto', aspect: 0.5625, widgets: [] };
  }

  let selected: string | undefined;
  let dirty = false;

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

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'le-save';
  saveButton.textContent = 'Save';
  saveButton.addEventListener('click', () => void save());

  const status = document.createElement('span');
  status.className = 'le-status';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'le-delete';
  deleteButton.textContent = 'Remove selected';
  deleteButton.addEventListener('click', removeSelected);

  toolbar.append(onToggle, aspectSelect, palette, deleteButton, saveButton, status);

  const stage = document.createElement('div');
  stage.className = 'le-stage';
  const canvas = document.createElement('div');
  canvas.className = 'le-canvas';
  stage.appendChild(canvas);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Nothing is placed yet — add a widget above. Turning the layout on with an ' +
    'empty canvas keeps the stacked layout, so the wall is never blank.';

  mount.append(toolbar, stage, hint);

  // ---- render from state -----------------------------------------------

  function markDirty(): void {
    dirty = true;
    status.textContent = 'Unsaved changes';
    status.className = 'le-status is-dirty';
  }

  function sizeCanvas(): void {
    // The stage caps the width; the canvas takes the aspect from there.
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

  function draw(): void {
    sizeCanvas();
    canvas.textContent = '';
    const ordered = [...state.widgets].sort((a, b) => a.z - b.z);
    for (const widget of ordered) canvas.appendChild(widgetNode(widget));
    hint.style.display = state.widgets.length === 0 ? '' : 'none';
    deleteButton.disabled = selected === undefined;
  }

  function widgetNode(widget: Widget): HTMLElement {
    const box = document.createElement('div');
    box.className = 'le-widget' + (widget.id === selected ? ' is-selected' : '');
    box.style.left = `${widget.x * 100}%`;
    box.style.top = `${widget.y * 100}%`;
    box.style.width = `${widget.w * 100}%`;
    box.style.height = `${widget.h * 100}%`;
    box.style.zIndex = String(widget.z);

    const label = document.createElement('span');
    label.className = 'le-widget-label';
    label.textContent = labelFor(widget.type);
    box.appendChild(label);

    const handle = document.createElement('span');
    handle.className = 'le-handle';
    box.appendChild(handle);

    box.addEventListener('pointerdown', (event) => startDrag(event, widget, false));
    handle.addEventListener('pointerdown', (event) => startDrag(event, widget, true));
    return box;
  }

  // ---- pointer interaction ---------------------------------------------

  function startDrag(event: PointerEvent, widget: Widget, resizing: boolean): void {
    event.preventDefault();
    event.stopPropagation();
    selected = widget.id;
    // Bring the just-touched widget to the front, so a drag is never hidden.
    widget.z = Math.max(0, ...state.widgets.map((w) => w.z)) + 1;

    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };

    /*
     * Move and up on the window, not the box.
     *
     * A drag routinely leaves the box it started on, and a listener on the box
     * would then stop hearing the pointer. Pointer capture is the usual fix but
     * it throws on a pointer id the browser has not seen — which is every
     * synthetic one a test dispatches — so the window is both more robust in
     * use and testable without a real mouse.
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
      draw();
      markDirty();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    draw();
  }

  // ---- mutations --------------------------------------------------------

  function addWidget(type: string): void {
    const z = Math.max(0, ...state.widgets.map((w) => w.z), 0) + 1;
    // A little offset per add, so a second widget does not land exactly on the
    // first and hide it.
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
  // A click on the empty canvas clears the selection.
  canvas.addEventListener('pointerdown', () => {
    selected = undefined;
    draw();
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

  // Warn before leaving with unsaved changes — a dragged-out layout lost to a
  // stray click is a real annoyance.
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  draw();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
