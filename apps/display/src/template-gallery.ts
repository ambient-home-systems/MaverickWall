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
import { ADMIN_WALLPAPER_BASE } from './wallpaper.js';
import { buildModel, type DisplayModel } from './viewmodel.js';
import { applyTheme } from './theme.js';
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
  readonly themeLabel?: string;
  readonly background?: CanvasBackground;
}
interface GalleryData {
  readonly owner: string | null;
  readonly templates: readonly TemplatePreview[];
  readonly customThemes?: Readonly<Record<string, { readonly tokens?: Readonly<Record<string, string>>; readonly shape: string }>>;
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
 * writes it, so on `/admin/walls/new/browser` the two fields are related and
 * nothing on the page said so: a household picked Sky Week, picked Panels
 * beside it, and the wall they were about to make would have come out Almanac.
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
function wireThemeSuggestion(templates: readonly TemplatePreview[], onChange: () => void): void {
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
    const effect = document.querySelector<HTMLElement>('[data-template-effect]');
    const selectedTheme = themes.find((one) => one.checked)?.value;
    if (effect !== null) {
      effect.textContent = selectedTheme !== undefined && theme !== undefined && selectedTheme !== theme
        ? `${name ?? 'This design'} is previewed in ${template?.themeLabel ?? theme}. Your chosen theme will be used instead; the design’s background remains. Check readability on the wall after adding it.`
        : '';
    }
  };

  const changed = (): void => { mark(); onChange(); };
  for (const radio of layouts) radio.addEventListener('change', changed);
  for (const radio of themes) radio.addEventListener('change', changed);
  mark();
}

function boot(): void {
  // Confirm the destructive forms whether or not the preview machinery runs.
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>('form[data-confirm]'))) {
    form.addEventListener('submit', (event) => {
      const message = form.dataset['confirm'];
      if (message !== undefined && message !== '' && !window.confirm(message)) event.preventDefault();
    });
  }

  const mount = document.getElementById('template-gallery');
  if (mount === null) return;

  let data: GalleryData;
  try {
    const parsed = JSON.parse(mount.dataset['json'] ?? '{}') as Partial<GalleryData>;
    data = {
      owner: typeof parsed.owner === 'string' ? parsed.owner : null,
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      ...(parsed.customThemes !== null && typeof parsed.customThemes === 'object'
        ? { customThemes: parsed.customThemes } : {}),
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
  let refreshPreview = (): void => {};
  wireThemeSuggestion(data.templates, () => refreshPreview());

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
      // On creation, only the chosen card shows the chosen wall theme. Other
      // cards remain the designs as authored; the canvas background stays in
      // the preview so a mismatch is visible before the wall is created.
      const chosenTheme = (): string | undefined => {
        const selectedDesign = document.querySelector<HTMLInputElement>('input[name="template"]:checked');
        const selectedTheme = document.querySelector<HTMLInputElement>('input[name="theme"]:checked');
        return selectedDesign?.value === template.id ? selectedTheme?.value : undefined;
      };
      const paintTheme = (): void => {
        const ref = chosenTheme() ?? template.theme ?? manifest.theme.active;
        const custom = data.customThemes?.[ref];
        applyTheme(wall, ref, custom?.tokens, custom?.shape);
      };
      paintTheme();
      thumbThemes.set(thumb, paintTheme);

      // On the admin page, so any image reads media behind the session.
      renderFreeform(wall, model, {
        aspect: template.aspect,
        widgets: placed(template.widgets),
        ...(template.background !== undefined ? { background: template.background } : {}),
      }, 'admin/media/', { wallpaperBase: ADMIN_WALLPAPER_BASE });
      // The fallback label is only for when this never runs.
      const fallback = thumb.querySelector('.tpl-fallback');
      if (fallback instanceof HTMLElement) fallback.style.display = 'none';
    };

    const thumbs = Array.from(document.querySelectorAll<HTMLElement>('.tpl-thumb[data-tpl]'));
    const thumbThemes = new Map<HTMLElement, () => void>();
    refreshPreview = (): void => { for (const paint of thumbThemes.values()) paint(); };
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
