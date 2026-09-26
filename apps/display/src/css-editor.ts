/**
 * The wall's Custom CSS page, live (RFC 014 §7).
 *
 * The form is server-rendered and saves with a plain POST — this only
 * *enhances* it, the way `theme-editor.ts` enhances the theme builder, so a
 * household with no scripting can still write and save. Two additions: the
 * sanitiser's sentence beside each field as it is typed, and a preview of this
 * wall drawn through the display's own renderer inside an **iframe**, with the
 * household's rules inserted through the CSSOM exactly as the wall inserts
 * them (`custom-css.ts`, the same module) — after every rule of the wall's own
 * stylesheet, one rule at a time, refused ones dropped.
 *
 * Nothing here parses CSS or decides what is allowed. The fields go to
 * `/admin/walls/:id/css/check`, which runs the one sanitiser the save runs
 * and answers per field; what comes back is what the preview is handed. Two
 * checkers would be two answers to "what will the wall draw", and that is the
 * fault every parity test in this repository exists to prevent.
 *
 * The preview is an iframe rather than a shadow root for the reason the theme
 * builder's is: the display sizes and lays itself out off the document root,
 * and only a real document has one. The wall is rendered *into* that document
 * rather than copied in as markup, so the density tiers measure their boxes
 * under `display.css` and pick the forms the wall would.
 */

import { renderFreeform } from './render.js';
import { ADMIN_WALLPAPER_BASE } from './wallpaper.js';
import { buildModel } from './viewmodel.js';
import { applyTheme } from './theme.js';
import { geometryFor } from './orientation.js';
import type { Manifest, ManifestWidget } from './manifest.js';
import { createCustomCssSheet, customCssBlocks, type CustomCssSheet } from './custom-css.js';

const mount = document.getElementById('css-editor');
if (mount !== null) init(mount);

/** What the check endpoint says about one field. */
interface Checked {
  readonly ok: boolean;
  readonly css?: string;
  readonly sentence?: string;
}

function init(root: HTMLElement): void {
  const screen = root.dataset['screen'] ?? '';
  const form = root.closest('form');
  const previewBox = document.getElementById('css-preview');
  if (form === null || screen === '') return;

  const fields = Array.from(form.querySelectorAll('textarea[name^="css_"]')) as HTMLTextAreaElement[];
  const noteFor = (name: string): HTMLElement | null =>
    form.querySelector(`[data-css-live="${name.replace(/"/g, '\\"')}"]`);

  // The preview's document, once it has drawn: its sheet, and the boxes on it.
  let sheet: CustomCssSheet | undefined;
  let drawn: readonly ManifestWidget[] = [];
  // The last answer per field, so the preview can be re-applied whole.
  const answers = new Map<string, Checked>();

  const applyToPreview = (): void => {
    if (sheet === undefined) return;
    const wall = answers.get('css_wall');
    sheet.apply(
      customCssBlocks(
        wall?.ok === true ? wall.css : undefined,
        drawn.map((widget) => {
          const answer = answers.get(`css_w_${widget.id}`);
          return { customCss: answer?.ok === true ? answer.css : undefined };
        }),
      ),
    );
  };

  const showAnswers = (): void => {
    for (const field of fields) {
      const note = noteFor(field.name);
      if (note === null) continue;
      const answer = answers.get(field.name);
      if (answer === undefined || answer.ok) {
        note.textContent = '';
        note.hidden = true;
        field.removeAttribute('aria-invalid');
      } else {
        note.textContent = answer.sentence ?? 'This could not be read.';
        note.hidden = false;
        field.setAttribute('aria-invalid', 'true');
      }
    }
  };

  // Debounced, and the last request wins: an answer to an older keystroke
  // must not land after the answer to a newer one.
  let timer: number | undefined;
  let sequence = 0;
  const check = (): void => {
    const blocks: Record<string, string> = {};
    for (const field of fields) blocks[field.name] = field.value;
    const mine = ++sequence;
    void fetch(`admin/walls/${encodeURIComponent(screen)}/css/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ blocks }),
    })
      .then(async (response) => {
        if (mine !== sequence || !response.ok) return;
        const body = (await response.json()) as { blocks?: Record<string, Checked> };
        for (const [name, answer] of Object.entries(body.blocks ?? {})) answers.set(name, answer);
        showAnswers();
        applyToPreview();
      })
      .catch(() => {
        // Unreachable for a moment. The sentences stay as they were; Save
        // still answers with the same sanitiser.
      });
  };
  const scheduleCheck = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(check, 300);
  };
  for (const field of fields) field.addEventListener('input', scheduleCheck);

  // The preview: this wall, drawn once into an iframe, then re-styled live.
  // A failure leaves the form fully usable without it.
  void (async (): Promise<void> => {
    try {
      if (previewBox === null) {
        check();
        return;
      }
      const [manifestRes, cssRes] = await Promise.all([
        fetch(`admin/layout/preview.json?screen=${encodeURIComponent(screen)}`),
        fetch('assets/display.css'),
      ]);
      if (!manifestRes.ok || !cssRes.ok) {
        check();
        return;
      }
      const manifest = (await manifestRes.json()) as Manifest;
      const css = await cssRes.text();

      // Whichever orientation the household has arranged, portrait first.
      const portrait = manifest.layout?.portrait;
      const landscape = manifest.layout?.landscape;
      const usePortrait = (portrait?.widgets?.length ?? 0) > 0 || (landscape?.widgets?.length ?? 0) === 0;
      const canvas = usePortrait ? portrait : landscape;
      const orientation = usePortrait ? 'portrait' : 'landscape';
      const aspect = canvas?.aspect ?? (usePortrait ? 0.5625 : 1.7778);
      drawn = canvas?.widgets ?? [];

      const boxW = previewBox.getBoundingClientRect().width || 300;
      const frame = document.createElement('iframe');
      frame.title = 'Wall preview';
      frame.setAttribute('scrolling', 'no');
      frame.style.cssText = `display:block;border:0;width:${boxW}px;height:${Math.round(boxW / aspect)}px`;
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        const wall = doc?.getElementById('wall');
        if (doc === null || doc === undefined || wall === null || wall === undefined) return;

        // Set the frame up as a real wall does (orientation.ts): the layout,
        // the frame size and the rem basis, then the theme with its tokens.
        const g = geometryFor({ width: frame.clientWidth, height: frame.clientHeight }, 0, orientation);
        const html = doc.documentElement;
        html.setAttribute('data-layout', g.layout);
        html.style.setProperty('--frame-w', g.frame.width);
        html.style.setProperty('--frame-h', g.frame.height);
        html.style.setProperty('--root-size', g.rootFontSize);
        applyTheme(
          html,
          manifest.theme.active,
          manifest.theme.activeTokens,
          manifest.theme.activeShape,
          manifest.screen?.eink === true,
        );

        const at = Date.now();
        const model = buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false });
        html.setAttribute('data-blocks', model.blocks.join(' '));
        // Into the iframe's own document, so every measurement the renderer
        // takes is taken under display.css rather than under the admin's.
        renderFreeform(wall, model, {
          aspect,
          widgets: drawn,
          ...(canvas?.background !== undefined ? { background: canvas.background } : {}),
        }, undefined, { wallpaperBase: ADMIN_WALLPAPER_BASE });

        // The household's rules, through the same door the wall uses.
        sheet = createCustomCssSheet(() => doc.styleSheets[0] ?? undefined);
        check();
      });
      frame.srcdoc =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<style>${css}</style></head><body><div id="wall"></div></body></html>`;
      previewBox.replaceChildren(frame);
    } catch {
      check();
    }
  })();
}
