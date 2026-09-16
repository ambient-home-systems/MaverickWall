/**
 * Non-blocking contrast guidance, shared by the theme builder and the widget
 * inspector's style lane (RFC 014 §4.1).
 *
 * Warn, never block. The bars are WCAG-ish: body text wants 4.5, larger marks
 * 3. A wall is read from across a room, so a low ratio is worth flagging even
 * though the household is free to keep it — and it is flagged the same way
 * wherever colours are chosen, which is why this is one module rather than a
 * copy in each editor. The luminance arithmetic is private here on purpose:
 * `theme.ts` carries the bundle's one `contrastRatio`, held character-identical
 * to the server's by `themes.test.ts`, and this file is guidance rather than a
 * derivation — nothing here reaches the manifest or the glass.
 */

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

/** The pairs a wall's legibility hangs on, against the ground text sits on. */
const CHECKS: readonly { readonly label: string; readonly token: string; readonly min: number }[] = [
  { label: 'Body text', token: '--ink', min: 4.5 },
  { label: 'Muted text', token: '--muted', min: 3 },
  { label: 'Accent / today', token: '--accent', min: 3 },
];

/**
 * The sentences worth saying about a token set, or none.
 *
 * Pure, so the inspector's tests can ask it without a DOM; `renderContrast`
 * is the same answer drawn.
 */
export function contrastWarnings(base: Readonly<Record<string, string | undefined>>): string[] {
  const bg = base['--bg'] ?? '#000000';
  return CHECKS.flatMap((check) => {
    const fg = base[check.token];
    if (fg === undefined) return [];
    const r = ratio(fg, bg);
    return r >= check.min
      ? []
      : [`${check.label} may be hard to read at ten feet (contrast ${r.toFixed(1)}:1, aim for ${check.min}:1).`];
  });
}

export function renderContrast(box: HTMLElement, base: Readonly<Record<string, string | undefined>>): void {
  const warnings = contrastWarnings(base);
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
