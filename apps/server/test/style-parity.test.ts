import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The style lane's tables, written twice (RFC 014 §4.1).
 *
 * `apps/server/src/api/widget-style.ts` resolves a widget's lane for the
 * manifest; `apps/display/src/widget-style.ts` resolves an unsaved one for
 * the editor's live preview. The display bundle cannot import the server and
 * the server cannot import the bundle, so everything between the two
 * `style tables` markers is transcribed — the seam `epaper-ladder-parity`,
 * `tier-parity` and `calendar-view-parity` already live at — and this holds
 * the two copies to being character-identical. A rung moved on one side is
 * a preview that draws one widget while the wall draws another.
 *
 * The *derivation* is deliberately not compared here: each side resolves
 * through its own mirror (`withTints` / `customTokens`), and those two are
 * already held character-identical by `themes.test.ts`. The display bundle
 * grows no second copy of the scaffold derivation, and that file is what
 * says so.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(HERE, '..', 'src', 'api', 'widget-style.ts'), 'utf8');
const DISPLAY = readFileSync(join(HERE, '..', '..', 'display', 'src', 'widget-style.ts'), 'utf8');

const START = '// ---- style tables (parity) ----';
const END = '// ---- end style tables ----';

function tables(source: string, where: string): string {
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0 || to < 0 || to < from) throw new Error(`${where} has no style tables between the markers`);
  return source.slice(from, to + END.length);
}

describe('the style tables, on both bundles', () => {
  it('are character-identical', () => {
    expect(tables(SERVER, 'widget-style.ts (server)')).toBe(tables(DISPLAY, 'widget-style.ts (display)'));
  });

  it('carry every table the resolver reads, so a drift cannot hide outside the markers', () => {
    const block = tables(SERVER, 'server');
    for (const name of [
      'STYLE_WEIGHTS',
      'STYLE_TRACKINGS',
      'STYLE_INSET_MAX',
      'STYLE_LANE_TOKENS',
      'STYLE_WEIGHT_CSS',
      'STYLE_TRACKING_CSS',
      'STYLE_INSET_CSS',
      'STYLE_DERIVED',
    ]) {
      expect(block, `${name} sits inside the parity block`).toContain(`export const ${name}`);
    }
  });

  it('reads the display file it claims to, so a rename fails loudly', () => {
    expect(DISPLAY).toContain('export function resolveStyleTokens(');
    expect(DISPLAY).toContain("import { customTokens } from './theme.js';");
    // And the display's resolver derives through the bundle's existing
    // mirror rather than a scaffold derivation of its own.
    expect(DISPLAY).not.toContain('function scaffoldInk(');
    expect(DISPLAY).not.toContain('function contrastRatio(');
  });
});
