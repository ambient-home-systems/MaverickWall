/**
 * The template gallery's live previews — the admin's second client-side app.
 *
 * The gallery page is fully server-rendered and applying a template is a plain
 * form POST, so this script is pure enhancement: it draws each card's preview
 * through the *same* `renderFreeform` a wall uses, against the household's real
 * manifest, so a card shows what that display will actually draw. It also asks
 * the household to confirm the destructive apply/copy.
 *
 * Vanilla TS, ES2019, same-origin, shipped in the image — never loaded on a wall,
 * only on this admin page. Previews render lazily as cards scroll into view, so a
 * dozen live walls do not all render at once (the cost RFC 005 flagged).
 */

import { renderFreeform } from './render.js';
import { buildModel, localTime, type DisplayModel } from './viewmodel.js';
import { applyTheme, daytimeActive } from './theme.js';
import { PREVIEW_ROOT_CLASS, layoutPreviewRoot, previewStylesheet } from './preview-css.js';
import type { Manifest, ManifestWidget, CanvasBackground } from './manifest.js';

/**
 * A widget as a *template* ships it: a wall preview needs no id and a template
 * carries none, so the two optional keys are what separate this from the
 * manifest's own shape rather than a looser copy of it.
 */
type TemplateWidget = Omit<ManifestWidget, 'id' | 'z'> & {
  readonly id?: string;
  readonly z?: number;
};

/**
 * A template's boxes as a renderer wants them: an id and a stacking order.
 *
 * Both are minted here and thrown away with the card. This used to be a cast
 * that never happened — the wall branch declared the server's id-less template
 * widgets as `ManifestWidget` and handed them straight to `renderFreeform`,
 * which reads neither key and so never noticed. The panel branch does not have
 * that luxury: its endpoint validates through the *save* path's widget schema,
 * where both are required, so making the shape true is what makes one preview
 * work and stops the other one lying.
 */
function placed(widgets: readonly TemplateWidget[]): readonly ManifestWidget[] {
  return widgets.map((widget, index) => ({
    ...widget,
    id: widget.id ?? `tpl${index}`,
    z: typeof widget.z === 'number' ? widget.z : index,
  }));
}

interface TemplatePreview {
  readonly id: string;
  /**
   * The template's own name, as the gallery card reads it.
   *
   * Only the add-a-wall form uses it, for the theme suggestion below; a
   * gallery card already has its name typed beside it on the server.
   */
  readonly name?: string;
  readonly aspect: number;
  readonly widgets: readonly TemplateWidget[];
  /**
   * Draw the panel's *built-in* view rather than these boxes.
   *
   * A panel with no canvas draws the renderer's own layout, which no list of
   * widgets can ask for: an empty list is a canvas somebody emptied. Panel
   * cards only.
   */
  readonly builtin?: boolean;
  /** The template's designed theme and background, previewed on the card. */
  readonly theme?: string;
  readonly background?: CanvasBackground;
}
interface GalleryData {
  readonly owner: string | null;
  readonly templates: readonly TemplatePreview[];
  /**
   * An e-paper panel's preview endpoint, present only on a panel's gallery.
   *
   * A wall's card is drawn here, in the browser, through the same
   * `renderFreeform` the wall runs. A panel's cannot be: the 1-bit renderer
   * lives on the server and teaching this script a second one is the fault the
   * designer's own backdrop already had to fix — two renderers disagreeing
   * about one canvas. So a panel card posts the template's boxes to the *same*
   * endpoint the Arrange backdrop posts to and draws the frame that comes back,
   * which is the frame the device would draw.
   */
  readonly panelPreview?: string;
  /**
   * Form controls whose values ride along with every panel preview request,
   * as `name → the value that control holds` — present only on the
   * add-a-panel form, where the panel has no row to read a shape from.
   *
   * Named rather than serialised here because the endpoint's body is a schema
   * and this is a list of the fields that belong in it: the geometry, and
   * nothing else on a form that also carries a name and a starting layout.
   * Changing one of them redraws every card, because the shape of the frame is
   * exactly what they decide.
   */
  readonly panelFields?: readonly string[];
}

/**
 * Choosing a starting layout *suggests* a theme, and can never choose one
 * (RFC 015 §3.1).
 *
 * Twelve of the fourteen shipped wall templates name a theme and applying one
 * writes it, so on `/admin/walls/new` the two fields are related and nothing on
 * the page said so: a household picked Sky Week, picked Panels beside it, and
 * the wall they were about to make would have come out Almanac.
 *
 * **It marks, and it never checks.** The no-script form is the specification —
 * nothing preselected, a choice still required — because a preselected card is
 * a default wearing a different hat and the household would proceed past it
 * exactly as they proceeded past the household setting this RFC retired. So
 * this writes a *word* into the suggested card and touches no radio's
 * `checked`, and a household with scripting blocked picks a template and then
 * picks a theme, which is the mandate working as stated rather than degraded.
 *
 * The suggestion is drawn from whatever template is checked when the page
 * arrives as well as on every change, because a form re-rendered at 400 comes
 * back with the household's own choices echoed into it — a suggestion that
 * only ever appeared on a click would be missing on the one render where the
 * household is being asked to look at the form again.
 *
 * It does nothing at all on a page that has one of the two fields and not the
 * other, which is every other page this script runs on.
 */
function wireThemeSuggestion(templates: readonly TemplatePreview[]): void {
  const themes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]'));
  const layouts = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="template"]'));
  if (themes.length === 0 || layouts.length === 0) return;

  const byId = new Map(templates.map((one) => [one.id, one]));
  /*
   * One slot per theme card, minted here rather than rendered by the server.
   *
   * The server's card is the *same markup* on three screens — the gallery, the
   * wall's own page and this form — and an empty element for a suggestion that
   * only this page can make would be two of those carrying furniture for a
   * behaviour they do not have.
   */
  const slots = new Map<string, HTMLElement>();
  for (const input of themes) {
    const cap = input.parentElement?.querySelector('.cap');
    if (!(cap instanceof HTMLElement)) continue;
    const slot = document.createElement('small');
    slot.className = 'tm-sugg';
    slot.hidden = true;
    cap.appendChild(slot);
    slots.set(input.value, slot);
  }

  const mark = (): void => {
    const chosen = layouts.filter((one) => one.checked)[0];
    const template = chosen === undefined ? undefined : byId.get(chosen.value);
    const theme = template?.theme;
    const name = template?.name;
    slots.forEach((slot, ref) => {
      const suggested = theme !== undefined && name !== undefined && ref === theme;
      slot.textContent = suggested ? `Suggested for ${name}` : '';
      slot.hidden = !suggested;
    });
  };

  for (const radio of layouts) radio.addEventListener('change', mark);
  mark();
}

/**
 * One browser wall's card on the Walls list, as the page describes it
 * (RFC 016 §4.1): the canvas the wall is hung for and its widgets exactly as
 * the manifest carries them — the server ran them through the manifest's own
 * placement, so the omission, the clamps and the to-do handle are already
 * applied and this script draws what it is handed.
 */
interface WallPreview {
  readonly id: string;
  readonly aspect: number;
  readonly widgets: readonly TemplateWidget[];
  readonly background?: CanvasBackground;
}

/**
 * The theme a wall is drawing *right now*, applied to its card's root.
 *
 * `main.ts` decides this on every draw — the daylight window is evaluated
 * on the wall, against the wall's own zone, and `manifest.theme.active` is
 * the theme *outside* that window rather than a value the server has already
 * resolved for this minute. A card that applied `active` alone would show a
 * wall on Almanac by day and Panels by night as Panels at noon, which is not
 * what is on the glass. So this is the wall's own arithmetic, the same three
 * arguments in the same order: the window read through `localTime` in the
 * manifest's zone, then the daytime theme, tokens and shape when it is open
 * and the active ones when it is not. A custom theme's tokens travel in the
 * same fields, so a wall wearing one is drawn in it rather than in the
 * built-in the shadow root would otherwise fall back to.
 */
function applyWallTheme(root: HTMLElement, manifest: Manifest, at: number): void {
  const theme = manifest.theme;
  const day = daytimeActive(
    localTime(at, manifest.timezone),
    theme.daytime,
    theme.daytimeStartsAt,
    theme.daytimeEndsAt,
  );
  applyTheme(
    root,
    day && theme.daytime !== undefined ? theme.daytime : theme.active,
    day ? theme.daytimeTokens : theme.activeTokens,
    day ? theme.daytimeShape : theme.activeShape,
  );
}

/**
 * The Walls list's cards (RFC 016 phase 2): every browser wall drawn through
 * the wall's own renderer, against that wall's own manifest, in the canvas it
 * is hung for and the theme it is wearing at this minute.
 *
 * The same mechanism as the template gallery below, pointed at different
 * data — and different in the one way that costs: a gallery draws fourteen
 * templates against **one** manifest, and a Walls list cannot, because zone,
 * density and theme are per wall. So every card that scrolls into view costs
 * one `previewManifest` build on the server and one `renderFreeform` here,
 * which is why the observer is not optional: it bounds the cost to what is on
 * screen. `display.css` is fetched once and shared by every shadow root.
 *
 * Three things it must not become (§4.4). **Not live**: a card is drawn once,
 * from one manifest, and never polls — six previews polling every minute would
 * make the settings page the busiest client in the house. **Not a fallback for
 * the wall**: a fetch that fails or a render that throws leaves the card's
 * name, chip, status and control exactly as the server drew them, and the
 * well empty. **Not authoritative about colour**: the card wears what the
 * wall is wearing now, read the way the wall reads it, and nothing else.
 */
function bootWallPreviews(mount: HTMLElement): void {
  let walls: readonly WallPreview[];
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as { walls?: unknown };
    walls = Array.isArray(parsed.walls) ? (parsed.walls as WallPreview[]) : [];
  } catch {
    return; // The server-rendered cards stand on their own.
  }
  const byId = new Map(walls.map((wall) => [wall.id, wall]));
  const thumbs = Array.from(document.querySelectorAll<HTMLElement>('.wall-preview[data-wall]'));
  if (thumbs.length === 0) return;

  // The wall's stylesheet, once, for every card. A failure here is a page of
  // empty wells rather than a page of broken ones.
  const stylesheet: Promise<string | undefined> = fetch('assets/display.css')
    .then((response) => (response.ok ? response.text() : undefined))
    .catch(() => undefined);

  const draw = async (thumb: HTMLElement): Promise<void> => {
    const wall = byId.get(thumb.dataset['wall'] ?? '');
    if (wall === undefined) return;
    try {
      const [css, response] = await Promise.all([
        stylesheet,
        fetch(`admin/layout/preview.json?screen=${encodeURIComponent(wall.id)}`),
      ]);
      if (css === undefined || !response.ok) return;
      const manifest = (await response.json()) as Manifest;
      /*
       * The server's clock, not this browser's. A wall draws from a clock
       * corrected by the `x-server-time` header on every poll, so "what the
       * wall is drawing right now" — which day is today, whether an event is
       * running, whether the daylight window is open — is a fact about the
       * server's now, and the manifest carries that as `generatedAt`. A phone
       * with a wrong clock opening this page would otherwise draw every card
       * a different day from the walls it pictures; measured under the test
       * harness, whose server is pinned to eleven in the morning, the
       * browser's own clock put a wall's daytime theme on the wrong side of
       * its window.
       */
      const at = typeof manifest.generatedAt === 'number' ? manifest.generatedAt : Date.now();
      const model = buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false });

      const rect = thumb.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // Once. The observer unobserves on the first intersection, but a card
      // asked twice — a fallback path, a future caller — must not draw over
      // itself, and `attachShadow` on a host that has one throws.
      if (thumb.shadowRoot !== null) return;

      const shadow = thumb.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = previewStylesheet(css);
      const root = document.createElement('div');
      root.className = PREVIEW_ROOT_CLASS;
      // At the reference resolution and scaled down, for the reason
      // `preview-css.ts` gives at length: `rem` cannot be restored inside a
      // shadow root, so the wall is drawn where the document's own rem is
      // already one percent of the canvas height. `browser-template-card-
      // fidelity.test.ts` compares this card against the paired wall.
      layoutPreviewRoot(root, { width: rect.width, height: rect.height }, rect.width / rect.height);
      shadow.append(style, root);
      applyWallTheme(root, manifest, at);
      // On the admin page, so any image reads media behind the session.
      renderFreeform(
        root,
        model,
        {
          aspect: wall.aspect,
          widgets: placed(wall.widgets),
          ...(wall.background !== undefined ? { background: wall.background } : {}),
        },
        'admin/media/',
      );
    } catch {
      // The card keeps its name, chip, status and control; only the picture is lost.
    }
  };

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          void draw(entry.target as HTMLElement);
        }
      },
      { rootMargin: '200px' },
    );
    for (const thumb of thumbs) observer.observe(thumb);
  } else {
    for (const thumb of thumbs) void draw(thumb);
  }
}

function boot(): void {
  // Confirm the destructive forms whether or not the preview machinery runs.
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>('form[data-confirm]'))) {
    form.addEventListener('submit', (event) => {
      const message = form.dataset['confirm'];
      if (message !== undefined && message !== '' && !window.confirm(message)) event.preventDefault();
    });
  }

  // The Walls list's cards (RFC 016 phase 2): a second mount, and the gallery
  // path below is untouched by it — a page carries one or the other.
  const wallsMount = document.getElementById('wall-previews');
  if (wallsMount !== null) {
    bootWallPreviews(wallsMount);
    return;
  }

  const mount = document.getElementById('template-gallery');
  if (mount === null) return;

  let data: GalleryData;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as Partial<GalleryData>;
    data = {
      owner: typeof parsed.owner === 'string' ? parsed.owner : null,
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      ...(typeof parsed.panelPreview === 'string' ? { panelPreview: parsed.panelPreview } : {}),
      ...(Array.isArray(parsed.panelFields) ? { panelFields: parsed.panelFields } : {}),
    };
  } catch {
    return; // The server-rendered cards and fallbacks stand on their own.
  }
  const byId = new Map(data.templates.map((t) => [t.id, t]));
  const screenQuery = data.owner === null ? '' : `?screen=${encodeURIComponent(data.owner)}`;

  // Before the panel branch returns, because it is the same page's other field
  // rather than anything to do with previews — and a panel has no theme, so on
  // a panel's form there are no theme cards and this is a no-op.
  wireThemeSuggestion(data.templates);

  /*
   * A panel's cards: one real frame each, from the renderer the device runs.
   *
   * Lazily, like the wall's, and one request at a time rather than five at
   * once — each is a full render of the household's manifest and a panel's
   * gallery is the one page that would fire them all on load. A failed request
   * leaves the card's labelled fallback exactly as a failed wall preview does:
   * a preview is never load-bearing, and the apply form beneath it works with
   * no script at all.
   */
  const panelPreview = data.panelPreview;
  if (panelPreview !== undefined) {
    /*
     * The shape the frame is drawn at, read off the form each time rather than
     * captured once: on the add-a-panel form the household picks the panel and
     * its rotation *while* looking at these cards, and a card still showing the
     * previous shape is the thing a preview exists to stop.
     */
    const shape = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const name of data.panelFields ?? []) {
        const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="${name}"]`,
        );
        if (control !== null) out[name] = control.value;
      }
      return out;
    };
    const drawInk = async (thumb: HTMLElement): Promise<void> => {
      const template = byId.get(thumb.dataset['tpl'] ?? '');
      if (template === undefined) return;
      try {
        const response = await fetch(panelPreview, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            template.builtin === true
              ? { ...shape(), builtin: true, widgets: [] }
              : { ...shape(), widgets: placed(template.widgets) },
          ),
        });
        if (!response.ok) return;
        const image = document.createElement('img');
        image.className = 'tpl-ink';
        image.alt = '';
        image.src = URL.createObjectURL(await response.blob());
        // The previous frame, when this is a redraw after the shape changed.
        // Revoked as it goes: a household flipping through the panel list would
        // otherwise leave one decoded PNG per card per change in memory.
        for (const stale of Array.from(thumb.querySelectorAll('img.tpl-ink'))) {
          URL.revokeObjectURL((stale as HTMLImageElement).src);
          stale.remove();
        }
        thumb.appendChild(image);
        const fallback = thumb.querySelector('.tpl-fallback');
        if (fallback instanceof HTMLElement) fallback.style.display = 'none';
      } catch {
        // Keep the labelled fallback.
      }
    };
    const queue: HTMLElement[] = [];
    let running = false;
    const pump = async (): Promise<void> => {
      if (running) return;
      running = true;
      let next = queue.shift();
      while (next !== undefined) {
        await drawInk(next);
        next = queue.shift();
      }
      running = false;
    };
    const want = (thumb: HTMLElement): void => {
      // Once: two changes in a row while the queue is draining would otherwise
      // render the same card twice and throw the first frame away.
      if (!queue.includes(thumb)) queue.push(thumb);
      void pump();
    };
    const inkThumbs = Array.from(document.querySelectorAll<HTMLElement>('.tpl-thumb[data-tpl]'));
    /*
     * A shape change redraws every card that has one, in the same one-at-a-time
     * queue — cards that have not been drawn yet are simply drawn at the new
     * shape when they scroll into view, so nothing has to be un-queued.
     */
    for (const name of data.panelFields ?? []) {
      const control = document.querySelector(`[name="${name}"]`);
      control?.addEventListener('change', () => {
        for (const thumb of inkThumbs) {
          if (thumb.querySelector('.tpl-ink') !== null) want(thumb);
        }
      });
    }
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            want(entry.target as HTMLElement);
          }
        },
        { rootMargin: '200px' },
      );
      for (const thumb of inkThumbs) observer.observe(thumb);
    } else {
      for (const thumb of inkThumbs) want(thumb);
    }
    return;
  }

  // Load the real manifest and the wall's stylesheet once, then draw previews.
  void (async (): Promise<void> => {
    let model: DisplayModel;
    let manifest: Manifest;
    let css: string;
    try {
      const [manifestRes, cssRes] = await Promise.all([
        fetch(`admin/layout/preview.json${screenQuery}`),
        fetch('assets/display.css'),
      ]);
      if (!manifestRes.ok || !cssRes.ok) return;
      manifest = (await manifestRes.json()) as Manifest;
      css = await cssRes.text();
      const at = Date.now();
      model = buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false });
    } catch {
      return; // Leave the labelled fallbacks; a preview is never load-bearing.
    }

    const drawThumb = (thumb: HTMLElement): void => {
      const template = byId.get(thumb.dataset['tpl'] ?? '');
      if (template === undefined) return;
      const rect = thumb.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const shadow = thumb.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = previewStylesheet(css);
      const wall = document.createElement('div');
      wall.className = PREVIEW_ROOT_CLASS;
      /*
       * Drawn at a reference resolution and scaled down to this box, rather
       * than drawn at the box's own small pixel size. The arithmetic and the
       * whole argument for it are in `preview-css.ts`, shared with the layout
       * editor's live canvas — which had the identical fault, and which this
       * page's cards must agree with in any case.
       */
      layoutPreviewRoot(wall, { width: rect.width, height: rect.height }, rect.width / rect.height);
      shadow.append(style, wall);
      // The template's own theme, so the card shows the look applying it gives —
      // not the household's current theme (RFC 005 3c).
      applyTheme(wall, template.theme ?? manifest.theme.active);

      // On the admin page, so any image reads media behind the session.
      renderFreeform(wall, model, {
        aspect: template.aspect,
        widgets: placed(template.widgets),
        ...(template.background !== undefined ? { background: template.background } : {}),
      }, 'admin/media/');
      // The fallback label is only for when this never runs.
      const fallback = thumb.querySelector('.tpl-fallback');
      if (fallback instanceof HTMLElement) fallback.style.display = 'none';
    };

    const thumbs = Array.from(document.querySelectorAll<HTMLElement>('.tpl-thumb[data-tpl]'));
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          drawThumb(entry.target as HTMLElement);
        }
      }, { rootMargin: '200px' });
      for (const thumb of thumbs) observer.observe(thumb);
    } else {
      for (const thumb of thumbs) drawThumb(thumb);
    }
  })();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
