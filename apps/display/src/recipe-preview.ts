/**
 * A recipe's preview on the recipe page, drawn by the wall's own renderer (plan
 * item M7.10).
 *
 * The server runs the recipe on the answer the author pasted and hands this
 * script the panel it built; this draws that panel as a Module widget, through
 * the same `renderFreeform` a wall uses, against the household's own theme and
 * clock. So what the page shows is what a wall would draw from that answer —
 * the tier the box chooses, the rows it gives up, a countdown's words — rather
 * than a second renderer's opinion of it.
 *
 * It is drawn twice, in two boxes a household commonly gives a module, because
 * a widget reads its own box and chooses a form: a recipe that reads well in a
 * third of a television can give up most of its rows in a strip.
 *
 * Pure enhancement: the server has already written the panel out as JSON
 * beside the mount, so a page without this script still says what was built.
 */

import { renderFreeform } from './render.js';
import { buildModel } from './viewmodel.js';
import { applyTheme } from './theme.js';
import { ADMIN_WALLPAPER_BASE } from './wallpaper.js';
import { useAdminIconBase } from './weather-icons.js';
import { PREVIEW_ROOT_CLASS, layoutPreviewRoot, previewStylesheet } from './preview-css.js';
import type { Manifest } from './manifest.js';

useAdminIconBase();

/** The module id the preview's widget names; the panel goes in under its key. */
const PREVIEW_MODULE = 'recipe-preview';

/**
 * The two boxes: a wall's aspect and where on it the widget sits. Each preview
 * shows only the box, at the wall's own proportions, so its type is the share
 * of the wall it would be.
 */
export const PREVIEW_BOXES: readonly {
  readonly key: string;
  readonly aspect: number;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}[] = [
  { key: 'third', aspect: 16 / 9, box: { x: 0.64, y: 0.04, w: 0.33, h: 0.5 } },
  { key: 'strip', aspect: 9 / 16, box: { x: 0.04, y: 0.72, w: 0.92, h: 0.14 } },
];

function boot(): void {
  const mounts = Array.from(document.querySelectorAll<HTMLElement>('[data-recipe-preview]'));
  if (mounts.length === 0) return;
  const source = document.getElementById('recipe-preview-panel');
  let panel: unknown;
  try {
    panel = JSON.parse(source?.textContent ?? 'null');
  } catch {
    return;
  }
  if (panel === null) return;

  void (async (): Promise<void> => {
    let manifest: Manifest;
    let css: string;
    try {
      const [manifestRes, cssRes] = await Promise.all([fetch('admin/layout/preview.json'), fetch('assets/display.css')]);
      if (!manifestRes.ok || !cssRes.ok) return;
      manifest = (await manifestRes.json()) as Manifest;
      css = await cssRes.text();
    } catch {
      return; // The panel's JSON is already on the page.
    }
    const withPanel: Manifest = {
      ...manifest,
      panels: { ...(manifest.panels ?? {}), [`ext:${PREVIEW_MODULE}`]: panel },
    };
    const at = Date.now();
    const model = buildModel({ manifest: withPanel, now: at, lastConfirmedAt: at, offline: false });

    for (const mount of mounts) {
      const spec = PREVIEW_BOXES.find((entry) => entry.key === mount.dataset['recipePreview']);
      if (spec === undefined) continue;
      const rect = mount.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const shadow = mount.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = previewStylesheet(css);
      const wall = document.createElement('div');
      wall.className = PREVIEW_ROOT_CLASS;
      // The whole wall, sized so the widget's box fills the mount, then moved
      // so the box is what shows: the mount clips the rest.
      const { x, y, w, h } = spec.box;
      layoutPreviewRoot(wall, { width: rect.width / w, height: rect.height / h }, spec.aspect);
      const scale = rect.height / h / (parseFloat(wall.style.height) || 1);
      const refW = parseFloat(wall.style.width) || 0;
      const refH = parseFloat(wall.style.height) || 0;
      wall.style.transform = `translate(${-x * refW * scale}px, ${-y * refH * scale}px) scale(${scale})`;
      shadow.append(style, wall);
      applyTheme(wall, manifest.theme.active, manifest.theme.activeTokens, manifest.theme.activeShape);
      renderFreeform(
        wall,
        model,
        {
          aspect: spec.aspect,
          widgets: [{ id: 'recipe', type: 'external', x, y, w, h, z: 0, config: { module: PREVIEW_MODULE } }],
        },
        'admin/media/',
        { wallpaperBase: ADMIN_WALLPAPER_BASE },
      );
      mount.dataset['drawn'] = 'true';
    }
  })();
}

boot();
