/**
 * The custom-theme builder's live half.
 *
 * The form is server-rendered and saves with a plain POST — this only
 * *enhances* it, so a household with no scripting can still build and save a
 * theme. Two additions: a live preview of a real wall drawn through the display's
 * own renderer inside an **iframe**, re-themed as the colours change; and
 * non-blocking contrast guidance (`contrast-guidance.ts`, shared with the widget
 * inspector's style lane), because a wall read at ten feet is unforgiving and
 * nothing here should hard-block a household's choice.
 *
 * The preview is an iframe rather than a shadow root because the display styles
 * everything off the document root: the rem basis is
 * `html { font-size: var(--root-size, calc(100vh/100)) }`, and every layout and
 * theme rule is `:root[data-layout]` / `:root[data-theme]`. A shadow tree has no
 * `<html>` and no viewport of its own, so none of that applies and the wall
 * renders unscaled — which it did. An iframe is a real document with its own
 * viewport, so the wall sizes and lays itself out exactly as on a screen, and
 * its stylesheet is isolated from the admin page for free.
 */

import { renderFreeform } from './render.js';
import { buildModel } from './viewmodel.js';
import { applyTheme, customTokens } from './theme.js';
import { geometryFor } from './orientation.js';
import type { Manifest } from './manifest.js';
import { renderContrast } from './contrast-guidance.js';

const mount = document.getElementById('theme-editor');
if (mount !== null) init(mount);

function init(root: HTMLElement): void {
  const form = root.closest('form') ?? document.querySelector('form');
  const previewBox = document.getElementById('theme-preview');
  const contrastBox = document.getElementById('theme-contrast');
  if (form === null) return;

  // Every token control — the colour inputs and the radius / font selects, all
  // named after their `--token`.
  const tokenControls = Array.from(
    form.querySelectorAll('[name^="--"]'),
  ) as (HTMLInputElement | HTMLSelectElement)[];
  const radiusInput = form.querySelector('[name="radius"]') as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  // The shape segControl (RFC 014 §4.3) — a radio per built-in shape, plus
  // 'neutral' for none. Read like any other field: whichever is checked.
  const shapeInputs = Array.from(form.querySelectorAll('[name="shape"]')) as HTMLInputElement[];
  // The shadow segControl (P4.4): None is stored as the token's own value and
  // Soft as an absence, so the preview derives exactly what the wall will.
  const shadowInputs = Array.from(form.querySelectorAll('[name="shadows"]')) as HTMLInputElement[];

  // The iframe's <html>, once it has loaded — where the theme tokens are set so
  // they cascade through the whole preview document.
  let previewRoot: HTMLElement | undefined;

  const readBase = (): Record<string, string> => {
    const base: Record<string, string> = {};
    // An empty value (a font left on "Default") is left out, so the display's
    // own default applies rather than an empty font-family.
    for (const control of tokenControls) if (control.value !== '') base[control.name] = control.value;
    base['--radius'] = radiusInput?.value ?? '0.4rem';
    if (shadowInputs.find((input) => input.checked)?.value === 'none') base['--shadow-card'] = 'none';
    return base;
  };

  // `resolveTheme` sends 'neutral' (and an absent column) as the display's
  // 'board' sentinel — the preview has to read the same value the manifest
  // will carry, or a household would see one shape while saving another.
  const readShape = (): string => {
    const checked = shapeInputs.find((input) => input.checked);
    const value = checked?.value ?? 'neutral';
    return value === 'neutral' ? 'board' : value;
  };

  const apply = (): void => {
    const base = readBase();
    if (previewRoot !== undefined) applyTheme(previewRoot, 'custom', customTokens(base), readShape());
    if (contrastBox !== null) renderContrast(contrastBox, base);
  };

  for (const control of tokenControls) {
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  }
  radiusInput?.addEventListener('change', apply);
  for (const input of shapeInputs) input.addEventListener('change', apply);
  for (const input of shadowInputs) input.addEventListener('change', apply);

  // The preview: the real wall, drawn once, then re-themed live. A failure just
  // leaves the form fully usable without the preview.
  void (async (): Promise<void> => {
    try {
      if (previewBox === null) {
        apply();
        return;
      }
      const [manifestRes, cssRes] = await Promise.all([
        fetch('admin/layout/preview.json'),
        fetch('assets/display.css'),
      ]);
      if (!manifestRes.ok || !cssRes.ok) {
        apply();
        return;
      }
      const manifest = (await manifestRes.json()) as Manifest;
      const css = await cssRes.text();

      // Render the wall once here, then hand its static HTML to the iframe. The
      // preview has no interactions, so the markup is all it needs.
      const at = Date.now();
      const model = buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false });
      const built = document.createElement('div');
      // The wall is always free-form now; preview the portrait canvas the
      // household has (Classic, or whatever they arranged). An empty canvas
      // draws the "nothing yet" note, which is fine for a theme swatch.
      const canvas = manifest.layout?.portrait;
      renderFreeform(built, model, {
        aspect: canvas?.aspect ?? 0.5625,
        widgets: canvas?.widgets ?? [],
        ...(canvas?.background !== undefined ? { background: canvas.background } : {}),
      });

      const boxW = previewBox.getBoundingClientRect().width || 300;
      const frame = document.createElement('iframe');
      frame.title = 'Wall preview';
      frame.setAttribute('scrolling', 'no');
      // Portrait, the design's own aspect. The iframe's viewport is what the
      // display's `100vh`-based sizing reads, so this box *is* the wall.
      frame.style.cssText = `display:block;border:0;width:${boxW}px;height:${boxW * (16 / 9)}px`;
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        const wall = doc?.getElementById('wall');
        if (doc === null || doc === undefined || wall === null || wall === undefined) return;
        wall.innerHTML = built.innerHTML;

        // Set the frame up exactly as a real portrait screen does (orientation.ts):
        // the layout, the block set, the frame size and the rem basis. The CSS
        // fallbacks already point at this iframe's viewport, so this only makes
        // it identical to a wall rather than merely close.
        const g = geometryFor({ width: frame.clientWidth, height: frame.clientHeight }, 0, 'portrait');
        const html = doc.documentElement;
        html.setAttribute('data-layout', g.layout);
        html.setAttribute('data-blocks', model.blocks.join(' '));
        html.style.setProperty('--frame-w', g.frame.width);
        html.style.setProperty('--frame-h', g.frame.height);
        html.style.setProperty('--root-size', g.rootFontSize);
        previewRoot = html;
        apply();
      });
      frame.srcdoc =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<style>${css}</style></head><body><div id="wall"></div></body></html>`;
      previewBox.replaceChildren(frame);
    } catch {
      apply();
    }
  })();

  apply();
}
