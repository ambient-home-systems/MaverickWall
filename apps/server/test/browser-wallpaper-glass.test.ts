import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, browser, shutDownBrowser } from './browser-harness.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { WALLPAPER_GLASS } from '../src/wallpaper-glass.js';
import { WALLPAPERS, themeTone } from '../src/wallpapers.js';

/**
 * Glass over a bundled wallpaper (plan item M4.2): the test that holds the
 * catalogue's Glass backdrops to the shipped files and to the 4.5:1 promise.
 *
 * Each wallpaper's file is decoded in Chromium, blurred and saturated as
 * Glass draws it where it blurs least — a landscape wall — and cut into 40x40
 * blocks, at **both** sizes a wall fetches. Not compared level for level with
 * the table: the generator's Chromium and this one blur the same file a few
 * levels apart, which is what the solver's margin absorbs, so the table is
 * held to the file it names and the promise is held to what this browser shows. Then, for every built-in theme of
 * the picture's tone, the opacity is solved from the catalogue's backdrop the
 * way the wall solves it, and both inks are held to 4.5:1 over the card colour
 * at that opacity composited on the lightest and darkest block **each file
 * actually shows** — so a regenerated picture, or a large file that differs
 * from the small one it was measured from, cannot keep last week's numbers.
 *
 * The solver here is written out rather than imported: a server test cannot
 * import the display bundle, and an expectation computed by the code under
 * test would agree with it whatever it did. The opacities are printed, which
 * is the table M4.3's decision is taken from.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'assets', 'wallpapers');
const SLOW = 300_000;
const BLOCKS = 40;
/** `--glass-blur` (0.6rem) on a landscape wall, as a share of the picture's side. */
const SHARE = 0.006 * (9 / 16);
const SATURATE = 1.4;

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const linear = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (panel: Rgb, alpha: number, patch: Rgb): Rgb =>
  [0, 1, 2].map((i) => Math.round(alpha * (panel[i] ?? 0) + (1 - alpha) * (patch[i] ?? 0))) as unknown as Rgb;
const holds = (panel: Rgb, inks: readonly Rgb[], alpha: number, patches: readonly Rgb[]): boolean =>
  patches.every((patch) => inks.every((ink) => contrast(ink, over(panel, alpha, patch)) >= 4.5));
/** `GLASS_MARGIN` in `glass-alpha.ts`: the patches pushed apart by three levels before solving. */
const MARGIN = 3;
const solve = (panel: Rgb, inks: readonly Rgb[], [light, dark]: readonly Rgb[]): number => {
  const widened = [
    (light ?? [0, 0, 0]).map((v) => Math.min(255, v + MARGIN)) as unknown as Rgb,
    (dark ?? [0, 0, 0]).map((v) => Math.max(0, v - MARGIN)) as unknown as Rgb,
  ];
  for (let step = 0; step <= 100; step++) if (holds(panel, inks, step / 100, widened)) return step / 100;
  return 1;
};

/** The scaffold ink of each built-in, as `theme.ts` declares it (the contrast gate's reading). */
function scaffoldInks(): Record<string, string> {
  const source = readFileSync(join(HERE, '..', '..', 'display', 'src', 'theme.ts'), 'utf8');
  const out: Record<string, string> = {};
  for (const [name, tokens] of Object.entries(BUILTIN_THEME_TOKENS)) {
    const at = source.indexOf(`'--bg': '${tokens['--bg']}'`);
    const scaffold = /'--ink-scaffold': '(#[0-9A-Fa-f]{6})'/.exec(source.slice(at))?.[1];
    if (at < 0 || scaffold === undefined) throw new Error(`theme.ts declares no --ink-scaffold for ${name}`);
    out[name] = scaffold;
  }
  return out;
}

/** A shipped file as Glass shows it: blurred, saturated, its lightest and darkest block. */
async function measure(page: Page, file: string): Promise<{ light: Rgb; dark: Rgb }> {
  const b64 = readFileSync(join(DIR, file)).toString('base64');
  return page.evaluate(
    async ({ b64, blocks, share, saturate }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      // A picture narrower than 16:9 is scaled to the wall's width and one
      // wider to its height, as `glass.mjs` measures it (plan item M4.5).
      ctx.filter = `blur(${Math.min(share * img.naturalWidth, share * (16 / 9) * img.naturalHeight)}px) saturate(${saturate})`;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = (c: number[]): number => 0.2126 * lin((c[0] ?? 0) / 255) + 0.7152 * lin((c[1] ?? 0) / 255) + 0.0722 * lin((c[2] ?? 0) / 255);
      const bw = canvas.width / blocks;
      const bh = canvas.height / blocks;
      let light: number[] | undefined;
      let dark: number[] | undefined;
      for (let by = 0; by < blocks; by++) {
        for (let bx = 0; bx < blocks; bx++) {
          const sum = [0, 0, 0];
          let n = 0;
          for (let y = Math.floor(by * bh); y < Math.floor((by + 1) * bh); y++) {
            for (let x = Math.floor(bx * bw); x < Math.floor((bx + 1) * bw); x++) {
              const i = (y * canvas.width + x) * 4;
              sum[0] = (sum[0] ?? 0) + (data[i] ?? 0);
              sum[1] = (sum[1] ?? 0) + (data[i + 1] ?? 0);
              sum[2] = (sum[2] ?? 0) + (data[i + 2] ?? 0);
              n++;
            }
          }
          const block = sum.map((v) => Math.round(v / n));
          if (light === undefined || lum(block) > lum(light)) light = block;
          if (dark === undefined || lum(block) < lum(dark)) dark = block;
        }
      }
      return { light: (light ?? [0, 0, 0]) as unknown as Rgb, dark: (dark ?? [0, 0, 0]) as unknown as Rgb };
    },
    { b64, blocks: BLOCKS, share: SHARE, saturate: SATURATE },
  );
}

let page: Page;
beforeAll(async () => {
  page = await (await (await browser()).newContext()).newPage();
}, SLOW);
afterAll(async () => {
  await shutDownBrowser();
}, TEARDOWN);

describe('Glass over the bundled wallpapers', () => {
  it(
    'has a backdrop for every picture, matching its file, under which every theme of its tone keeps 4.5:1',
    async () => {
      const scaffold = scaffoldInks();
      const alphas: Record<string, number[]> = {};
      expect(Object.keys(WALLPAPER_GLASS).sort()).toEqual(WALLPAPERS.map((one) => one.id).sort());
      for (const wallpaper of WALLPAPERS) {
        const stored = wallpaper.glass;
        expect(stored, `${wallpaper.id} has no Glass backdrop`).toBeDefined();
        const backdrop = [hex(stored?.light ?? '#000000'), hex(stored?.dark ?? '#000000')];
        const small = await measure(page, wallpaper.small);
        const large = await measure(page, wallpaper.large);
        // Measured from the file the wall fetches today: a redrawn picture has a new name.
        expect(WALLPAPER_GLASS[wallpaper.id]?.file, `${wallpaper.id} has been redrawn since its Glass backdrop was measured`).toBe(wallpaper.small);
        for (const [name, tokens] of Object.entries(BUILTIN_THEME_TOKENS)) {
          if (themeTone(tokens['--bg'] ?? '') !== wallpaper.tone) continue;
          const panel = hex(tokens['--panel'] ?? '#000000');
          const inks = [hex(tokens['--ink'] ?? '#000000'), hex(scaffold[name] ?? '#000000')];
          const alpha = solve(panel, inks, backdrop);
          (alphas[name] ??= []).push(alpha);
          for (const [size, file] of [
            ['small', small],
            ['large', large],
          ] as const) {
            expect(
              holds(panel, inks, alpha, [file.light, file.dark]),
              `${wallpaper.id} on ${name} at ${alpha}: the ${size} file shows a patch under 4.5:1`,
            ).toBe(true);
          }
        }
      }
      const line = Object.entries(alphas)
        .map(([name, list]) => {
          const sorted = [...list].sort((a, b) => a - b);
          return `${name} ${sorted[0]}–${sorted[sorted.length - 1]} (median ${sorted[Math.floor(sorted.length / 2)]}, ${list.filter((a) => a < 0.86).length}/${list.length} under Soft)`;
        })
        .join('; ');
      process.stdout.write(`[glass] opacity by theme: ${line}\n`);
    },
    SLOW,
  );
});
