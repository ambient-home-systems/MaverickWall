/**
 * The custom-theme builder's live half.
 *
 * The form is server-rendered and saves with a plain POST — this only
 * *enhances* it, so a household with no scripting can still build and save a
 * theme. Two additions: a live preview of a real wall drawn through the display's
 * own renderer inside a shadow root (the same technique the layout editor uses,
 * so the CSS never leaks into the admin page), re-themed as the colours change;
 * and non-blocking contrast guidance, because a wall read at ten feet is
 * unforgiving and nothing here should hard-block a household's choice.
 */

import { render } from './render.js';
import { buildModel } from './viewmodel.js';
import { applyTheme, customTokens } from './theme.js';
import type { Manifest } from './manifest.js';

const mount = document.getElementById('theme-editor');
if (mount !== null) init(mount);

function init(root: HTMLElement): void {
  const form = root.closest('form') ?? document.querySelector('form');
  const previewBox = document.getElementById('theme-preview');
  const contrastBox = document.getElementById('theme-contrast');
  if (form === null) return;

  const colourInputs = Array.from(
    form.querySelectorAll('input[name^="--"]'),
  ) as HTMLInputElement[];
  const radiusInput = form.querySelector('[name="radius"]') as
    | HTMLInputElement
    | HTMLSelectElement
    | null;

  let previewWall: HTMLElement | undefined;

  const readBase = (): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const input of colourInputs) base[input.name] = input.value;
    base['--radius'] = radiusInput?.value ?? '0.4rem';
    return base;
  };

  const apply = (): void => {
    const base = readBase();
    if (previewWall !== undefined) applyTheme(previewWall, 'custom', customTokens(base), 'board');
    if (contrastBox !== null) renderContrast(contrastBox, base);
  };

  for (const input of colourInputs) input.addEventListener('input', apply);
  radiusInput?.addEventListener('change', apply);

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

      const shadow = previewBox.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = css;
      const wall = document.createElement('div');
      wall.className = 'preview-wall';
      shadow.append(styleEl, wall);
      previewWall = wall;

      const box = previewBox.getBoundingClientRect();
      const w = box.width > 0 ? box.width : 300;
      const h = w * (16 / 9); // portrait, the design's own aspect
      wall.style.width = `${w}px`;
      wall.style.height = `${h}px`;
      wall.style.setProperty('--frame-w', `${w}px`);
      wall.style.setProperty('--frame-h', `${h}px`);
      wall.style.setProperty('--root-size', `${h / 100}px`);

      const at = Date.now();
      render(wall, buildModel({ manifest, now: at, lastConfirmedAt: at, offline: false }));
      apply();
    } catch {
      apply();
    }
  })();

  apply();
}

// ---- Contrast guidance (WCAG relative luminance) ----------------------------

function parseHex(value: string): [number, number, number] | undefined {
  const hex = value.trim().replace('#', '');
  if (hex.length !== 6) return undefined;
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return undefined;
  // eslint-disable-next-line no-bitwise
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === undefined) return 0;
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function ratio(a: string, b: string): number {
  const la = luminance(a) + 0.05;
  const lb = luminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/**
 * Warn, never block. The bars are WCAG-ish: body text wants 4.5, larger marks
 * 3. A wall is read from across a room, so a low ratio is worth flagging even
 * though the household is free to keep it.
 */
function renderContrast(box: HTMLElement, base: Record<string, string>): void {
  const bg = base['--bg'] ?? '#000000';
  const checks: { label: string; token: string; min: number }[] = [
    { label: 'Body text', token: '--ink', min: 4.5 },
    { label: 'Muted text', token: '--muted', min: 3 },
    { label: 'Accent / today', token: '--accent', min: 3 },
  ];
  const warnings = checks.flatMap((check) => {
    const fg = base[check.token];
    if (fg === undefined) return [];
    const r = ratio(fg, bg);
    return r >= check.min
      ? []
      : [`${check.label} may be hard to read at ten feet (contrast ${r.toFixed(1)}:1, aim for ${check.min}:1).`];
  });

  box.textContent = '';
  if (warnings.length === 0) {
    const ok = document.createElement('p');
    ok.className = 'hint';
    ok.textContent = 'Contrast looks readable from across a room.';
    box.append(ok);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'error';
  const strong = document.createElement('strong');
  strong.textContent = 'Readability';
  const list = document.createElement('ul');
  list.style.margin = '.3rem 0 0';
  list.style.paddingLeft = '1.1rem';
  for (const warning of warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    list.append(li);
  }
  wrap.append(strong, list);
  box.append(wrap);
}
