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
import { buildModel, type DisplayModel } from './viewmodel.js';
import { applyTheme } from './theme.js';
import type { Manifest, ManifestWidget, CanvasBackground } from './manifest.js';

interface TemplatePreview {
  readonly id: string;
  readonly aspect: number;
  readonly widgets: readonly ManifestWidget[];
  /** The template's designed theme and background, previewed on the card. */
  readonly theme?: string;
  readonly background?: CanvasBackground;
}
interface GalleryData {
  readonly owner: string | null;
  readonly templates: readonly TemplatePreview[];
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
    };
  } catch {
    return; // The server-rendered cards and fallbacks stand on their own.
  }
  const byId = new Map(data.templates.map((t) => [t.id, t]));
  const screenQuery = data.owner === null ? '' : `?screen=${encodeURIComponent(data.owner)}`;

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
      style.textContent = css;
      const wall = document.createElement('div');
      wall.className = 'preview-wall';
      // The frame the wall's own layout expects: no rotation, this box exactly,
      // and one rem worth one percent of its height — the relation orientation.ts
      // sets on a real screen. Free-form sections measure and scale to their box,
      // so they are indifferent to the shadow root having no root font-size.
      wall.style.width = `${rect.width}px`;
      wall.style.height = `${rect.height}px`;
      wall.style.setProperty('--frame-w', `${rect.width}px`);
      wall.style.setProperty('--frame-h', `${rect.height}px`);
      wall.style.setProperty('--root-size', `${rect.height / 100}px`);
      shadow.append(style, wall);
      // The template's own theme, so the card shows the look applying it gives —
      // not the household's current theme (RFC 005 3c).
      applyTheme(wall, template.theme ?? manifest.theme.active);

      // On the admin page, so any image reads media behind the session.
      renderFreeform(wall, model, {
        aspect: template.aspect,
        widgets: template.widgets,
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
