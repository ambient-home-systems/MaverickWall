import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, browser, shutDownBrowser } from './browser-harness.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { WALLPAPERS, themeTone, type Wallpaper } from '../src/wallpapers.js';

/**
 * Text over a picture (plan item P6.3): the test that decides whether a
 * wallpaper ships.
 *
 * Every contrast guarantee on a wall is measured against a flat ground, and
 * nothing measures text over an image; blur stays out (Q4). What puts text
 * back on a known ground is the Soft widget ground — the theme's `--panel` at
 * 0.86 over the picture — and what a date numeral actually sits on is
 * therefore 86% panel and 14% whatever the picture is doing under that box.
 * A drawn wallpaper is held at 0.86 exactly. A photograph or painting (plan
 * item M4.5) was not drawn for this, so the wall solves its opacity from the
 * catalogue's patches, never below 0.86, and that solved opacity is what is
 * held here — `browser-wallpaper-photos.test.ts` reads it back off a wall.
 * So each shipped file is decoded, cut into blocks about the size of a
 * numeral, and its lightest and darkest blocks found; the Soft ground is
 * composited over each in sRGB, as the browser composites it; and the
 * `--ink` and `--ink-scaffold` of **every** built-in theme of the wallpaper's
 * tone are held to 4.5:1 against both. The scaffold ink is the one that
 * binds: it is the theme's demoted ink, tuned to clear 4.5:1 against the
 * theme's own `--bg` with little to spare, so a bright block under a dark
 * theme's panel, or a dark block under a light theme's white card, is exactly
 * where it dips.
 *
 * Decoded in Chromium because that is the only JPEG decoder this repository
 * has, and because the shipped bytes are the subject: the generator measured
 * its own raster, and the catalogue's colour and luminance are checked here
 * against the file the wall will actually fetch, at the size it will fetch
 * — the large file for a television, the small one for a tablet — so a
 * picture regenerated with a different grain cannot keep last week's numbers.
 * The decode of the largest file is timed too, which is the measurement P6.1
 * asked for on the largest size; it is printed, and held only to a bound
 * loose enough to be about a broken file rather than a busy runner.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'assets', 'wallpapers');
const SLOW = 240_000;
/** The Soft ground's opacity — `display.css`, `.canvas[data-ground="soft"]`. */
const SOFT = 0.86;
/** Blocks per side. At 1600px that is a 40px block: about one date numeral on a tablet. */
const BLOCKS = 40;

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const linear = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** The Soft ground at `alpha` over a picture block, as the browser composites it: in sRGB. */
const soft = (panel: Rgb, picture: Rgb, alpha = SOFT): Rgb => {
  const mix = (i: 0 | 1 | 2): number => alpha * panel[i] + (1 - alpha) * picture[i];
  return [mix(0), mix(1), mix(2)];
};

/**
 * Soft's opacity over a photograph (plan item M4.5): solved from the
 * catalogue's patches the way the wall solves it (`glass-alpha.ts`), never
 * below 0.86. Written out rather than imported, for the reason the Glass test
 * gives: a server test cannot import the display bundle, and an expectation
 * computed by the code under test agrees with it whatever it does.
 */
const MARGIN = 3;
function softAlpha(
  panel: Rgb,
  inks: readonly Rgb[],
  patches: { readonly light: string; readonly dark: string },
  floor = SOFT,
): number {
  const light = hex(patches.light).map((v) => Math.min(255, v + MARGIN)) as unknown as Rgb;
  const dark = hex(patches.dark).map((v) => Math.max(0, v - MARGIN)) as unknown as Rgb;
  const over = (alpha: number, patch: Rgb): Rgb =>
    [0, 1, 2].map((i) => alpha * (panel[i] ?? 0) + (1 - alpha) * (patch[i] ?? 0)) as unknown as Rgb;
  for (let step = 0; step <= 100; step++) {
    const alpha = step / 100;
    if ([light, dark].every((patch) => inks.every((ink) => contrast(ink, over(alpha, patch)) >= 4.5))) return Math.max(floor, alpha);
  }
  return 1;
}

/**
 * The scaffold ink of each built-in, as `theme.ts` declares it. The server's
 * `BUILTIN_THEME_TOKENS` carries only the eleven colours a style lane may
 * set, so the derived role is read off the bundle's own source here — held to
 * that file by `builtin-themes-parity.test.ts` for the colours, and read from
 * it directly for this one.
 */
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

interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly decodeMs: number;
  readonly mean: Rgb;
  readonly meanLuminance: number;
  readonly darkest: Rgb;
  readonly lightest: Rgb;
}

/** Decode a shipped file in the browser and read its blocks. */
async function decode(page: Page, file: string): Promise<Decoded> {
  const b64 = readFileSync(join(DIR, file)).toString('base64');
  return page.evaluate(
    async ({ b64, blocks }) => {
      const started = performance.now();
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const bitmap = await createImageBitmap(img);
      const decodeMs = performance.now() - started;
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = (r: number, g: number, b: number): number => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
      const bw = canvas.width / blocks;
      const bh = canvas.height / blocks;
      const sums = new Float64Array(blocks * blocks * 3);
      const counts = new Float64Array(blocks * blocks);
      let total = [0, 0, 0];
      let totalLum = 0;
      const n = canvas.width * canvas.height;
      for (let y = 0; y < canvas.height; y += 1) {
        const by = Math.min(blocks - 1, Math.floor(y / bh));
        for (let x = 0; x < canvas.width; x += 1) {
          const i = (y * canvas.width + x) * 4;
          const r = data[i] as number;
          const g = data[i + 1] as number;
          const b = data[i + 2] as number;
          const k = by * blocks + Math.min(blocks - 1, Math.floor(x / bw));
          sums[k * 3] = (sums[k * 3] as number) + r;
          sums[k * 3 + 1] = (sums[k * 3 + 1] as number) + g;
          sums[k * 3 + 2] = (sums[k * 3 + 2] as number) + b;
          counts[k] = (counts[k] as number) + 1;
          total = [total[0] as number + r, total[1] as number + g, total[2] as number + b];
          totalLum += lum(r, g, b);
        }
      }
      let darkest: [number, number, number] = [255, 255, 255];
      let lightest: [number, number, number] = [0, 0, 0];
      let darkestLum = 2;
      let lightestLum = -1;
      for (let k = 0; k < blocks * blocks; k += 1) {
        const c = counts[k] as number;
        const block: [number, number, number] = [(sums[k * 3] as number) / c, (sums[k * 3 + 1] as number) / c, (sums[k * 3 + 2] as number) / c];
        const l = lum(block[0], block[1], block[2]);
        if (l < darkestLum) [darkestLum, darkest] = [l, block];
        if (l > lightestLum) [lightestLum, lightest] = [l, block];
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        decodeMs,
        mean: [(total[0] as number) / n, (total[1] as number) / n, (total[2] as number) / n] as [number, number, number],
        meanLuminance: totalLum / n,
        darkest,
        lightest,
      };
    },
    { b64, blocks: BLOCKS },
  );
}

/**
 * A Strong wash's thinnest point, its centre (plan item M4.7): `wash.ts`'s
 * preset, raised to what the picture's unblurred patches need where words sit
 * on the wash with no widget ground under them. Written out, as `softAlpha` is.
 */
const STRONG_CENTRE = 0.5;

let page: Page;

beforeAll(async () => {
  const context = await (await browser()).newContext();
  page = await context.newPage();
  await page.setContent('<!doctype html><title>wallpapers</title>');
}, SLOW);

afterAll(async () => {
  await page.context().close();
  await shutDownBrowser();
}, TEARDOWN);

const themesOf = (tone: Wallpaper['tone']): string[] =>
  Object.entries(BUILTIN_THEME_TOKENS)
    .filter(([, tokens]) => themeTone(tokens['--bg']) === tone)
    .map(([name]) => name);

describe('every wallpaper, decoded from the bytes it ships', () => {
  const scaffold = scaffoldInks();
  /** Soft's opacity by theme over every picture, printed once the set has run. */
  const alphas: Record<string, number[]> = {};
  /** A Strong wash's centre by theme over every picture (M4.7). */
  const washes: Record<string, number[]> = {};
  afterAll(() => {
    process.stdout.write(
      `[wash] Strong's centre by theme: ${Object.entries(washes)
        .map(([name, list]) => `${name} ${Math.min(...list)}–${Math.max(...list)}`)
        .join('; ')}\n`,
    );
    const line = Object.entries(alphas)
      .map(([name, list]) => `${name} ${Math.min(...list)}–${Math.max(...list)} (${list.filter((a) => a > SOFT).length}/${list.length} above 0.86)`)
      .join('; ');
    process.stdout.write(`[soft] opacity by theme: ${line}\n`);
  });

  it.each(WALLPAPERS.map((w) => [w.id, w] as const))(
    '%s keeps --ink and --ink-scaffold at 4.5:1 through the Soft ground, on every theme of its tone',
    async (_, wallpaper) => {
      const themes = themesOf(wallpaper.tone);
      expect(themes.length, `no built-in is ${wallpaper.tone}`).toBeGreaterThan(0);
      for (const [size, file] of [['large', wallpaper.large], ['small', wallpaper.small]] as const) {
        const decoded = await decode(page, file);
        // The file is the size its name says, square, and the catalogue's
        // measured colour and luminance are this file's: within the JPEG's own
        // rounding of a mean, so a regenerated picture cannot keep old numbers.
        // A drawn wallpaper is square; a photograph keeps its own shape, at the
        // same long edge (plan item M4.5).
        const edge = size === 'large' ? 2880 : 1600;
        if (wallpaper.credit === undefined) expect([decoded.width, decoded.height], file).toEqual([edge, edge]);
        else expect(Math.max(decoded.width, decoded.height), file).toBe(edge);
        expect(Math.abs(decoded.meanLuminance - wallpaper.luminance), `${file} luminance`).toBeLessThan(0.02);
        const catalogued = hex(wallpaper.color);
        for (let i = 0; i < 3; i += 1) expect(Math.abs((decoded.mean[i] as number) - (catalogued[i] as number)), `${file} colour`).toBeLessThan(6);
        for (const theme of themes) {
          const tokens = BUILTIN_THEME_TOKENS[theme as keyof typeof BUILTIN_THEME_TOKENS];
          const panel = hex(tokens['--panel']);
          const inks = { '--ink': hex(tokens['--ink']), '--ink-scaffold': hex(scaffold[theme] as string) };
          // A drawn wallpaper is held at Soft's fixed 0.86; a photograph at the
          // opacity the wall solves from its catalogue patches, against what
          // each file actually shows.
          const alpha = wallpaper.soft === undefined ? SOFT : softAlpha(panel, Object.values(inks), wallpaper.soft);
          if (size === 'small') (alphas[theme] ??= []).push(alpha);
          for (const [role, ink] of Object.entries(inks)) {
            for (const [where, block] of [['darkest', decoded.darkest], ['lightest', decoded.lightest]] as const) {
              const ground = soft(panel, block, alpha);
              const ratio = contrast(ink, ground);
              expect(
                ratio,
                `${wallpaper.id} (${size}): ${theme}'s ${role} over its Soft ground at ${alpha} on the picture's ${where} block ` +
                  `rgb(${block.map(Math.round).join(', ')}) reads ${ratio.toFixed(2)}:1`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
          /*
           * And with no widget ground at all, under a Strong wash (plan item
           * M4.7): the words sit on the wash itself, whose thinnest point is
           * its centre, so that centre — solved from the picture's unblurred
           * patches, never below the preset — is what has to hold over what
           * each file actually shows. The text shadow (M4.8) is not counted.
           */
          expect(wallpaper.bare, `${wallpaper.id} carries no unblurred patches to solve a wash from`).toBeDefined();
          const centre = softAlpha(panel, Object.values(inks), wallpaper.bare!, STRONG_CENTRE);
          if (size === 'small') (washes[theme] ??= []).push(centre);
          for (const [role, ink] of Object.entries(inks)) {
            for (const [where, block] of [['darkest', decoded.darkest], ['lightest', decoded.lightest]] as const) {
              const ratio = contrast(ink, soft(panel, block, centre));
              expect(
                ratio,
                `${wallpaper.id} (${size}): ${theme}'s ${role} on a Strong wash at ${centre} with no ground, over the ` +
                  `picture's ${where} block rgb(${block.map(Math.round).join(', ')}), reads ${ratio.toFixed(2)}:1`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    },
    SLOW,
  );

  it(
    'decodes its largest file in the time a fifteen-second tick can spare',
    async () => {
      // The measurement P6.1 asked for, on the largest size: an old tablet
      // decodes the picture once and draws it from its cache on every tick
      // (`browser-wallpaper.test.ts` holds the "once"), so what a decode costs
      // is paid at boot and after a memory squeeze. Printed every run; the
      // bound is loose enough to be about a broken file rather than a runner.
      const largest = [...WALLPAPERS].sort((a, b) => readFileSync(join(DIR, b.large)).length - readFileSync(join(DIR, a.large)).length)[0];
      if (largest === undefined) throw new Error('no wallpapers');
      const runs: number[] = [];
      for (let i = 0; i < 3; i += 1) runs.push((await decode(page, largest.large)).decodeMs);
      const best = Math.min(...runs);
      process.stdout.write(
        `[wallpapers] decode of ${largest.large} (${readFileSync(join(DIR, largest.large)).length} bytes): ` +
          `${runs.map((ms) => ms.toFixed(0)).join(', ')} ms\n`,
      );
      expect(best).toBeLessThan(2_000);
    },
    SLOW,
  );
});
