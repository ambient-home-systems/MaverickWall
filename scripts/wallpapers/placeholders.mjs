#!/usr/bin/env node
/**
 * The three placeholder wallpapers (plan item P6.1), rasterised to JPEG.
 *
 * **A stand-in for S23's generator, not the set.** P6.2 is a seeded generator
 * of about twenty-six wallpapers; this draws three, one per case the picker has
 * to be tested against (two dark, one light), so the fourth background kind can
 * be driven end to end before the set exists. S23 replaces this file with
 * `scripts/wallpapers/generate.mjs` and may keep or drop these ids — a stored
 * id the catalogue no longer names is dropped by `parseBackground`, and the
 * canvas falls back to its theme's ground (rule nine).
 *
 * Each wallpaper is a square SVG, drawn by the bundled headless Chromium at the
 * three sizes the catalogue carries and saved as **JPEG** (old kitchen iPads
 * cannot show WebP). Square and with nothing near the edges, so `cover` crops
 * one master cleanly to portrait and landscape. A fine grain is laid over each
 * so the files cost what a real picture costs to decode — a smooth gradient
 * compresses to almost nothing and would flatter the measurement P6.1 asks for.
 *
 * File names are content-hashed, so an edited picture is a new URL and the
 * route's year-long immutable cache stays honest; `wallpapers.test.ts` holds
 * every name in `apps/server/src/wallpapers.ts` to the bytes on disk.
 *
 *   MW_BROWSER_EXECUTABLE=/path/to/chrome node scripts/wallpapers/placeholders.mjs
 *
 * prints the catalogue entries to paste into `wallpapers.ts`.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'apps', 'server', 'package.json'));
const { chromium } = require('playwright-core');

const OUT = join(root, 'apps', 'server', 'assets', 'wallpapers');
const SIZES = { thumb: 320, small: 1600, large: 2880 };

/** A grain the same at every size: a turbulence filter blended over the art. */
const grain = (seed, opacity) =>
  `<filter id="g" x="0" y="0" width="100%" height="100%">` +
  `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed}" stitchTiles="stitch"/>` +
  `<feColorMatrix type="saturate" values="0"/></filter>` +
  `<rect width="1000" height="1000" filter="url(#g)" opacity="${opacity}" style="mix-blend-mode:overlay"/>`;

const WALLPAPERS = [
  {
    id: 'dusk',
    name: 'Dusk',
    tone: 'dark',
    color: '#1C2233',
    svg:
      `<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#141A2A"/><stop offset="0.6" stop-color="#252B45"/>` +
      `<stop offset="1" stop-color="#3A2E48"/></linearGradient>` +
      `<radialGradient id="b" cx="0.5" cy="0.85" r="0.6">` +
      `<stop offset="0" stop-color="#5A3F55" stop-opacity="0.55"/><stop offset="1" stop-color="#5A3F55" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<rect width="1000" height="1000" fill="url(#a)"/><rect width="1000" height="1000" fill="url(#b)"/>` +
      grain(7, 0.5),
  },
  {
    id: 'hills',
    name: 'Hills',
    tone: 'dark',
    color: '#1A2A28',
    svg:
      `<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#15201F"/><stop offset="1" stop-color="#23332F"/></linearGradient></defs>` +
      `<rect width="1000" height="1000" fill="url(#a)"/>` +
      `<path d="M0 560 C 180 500 320 540 500 520 S 820 470 1000 520 V1000 H0Z" fill="#1F302C"/>` +
      `<path d="M0 660 C 200 610 380 650 560 630 S 860 600 1000 640 V1000 H0Z" fill="#1A2926"/>` +
      `<path d="M0 770 C 220 730 420 760 600 745 S 880 720 1000 750 V1000 H0Z" fill="#152220"/>` +
      grain(11, 0.45),
  },
  {
    id: 'paper',
    name: 'Paper',
    tone: 'light',
    color: '#EFEAE0',
    svg:
      `<defs><radialGradient id="a" cx="0.5" cy="0.45" r="0.75">` +
      `<stop offset="0" stop-color="#F5F1E8"/><stop offset="1" stop-color="#E7E0D2"/></radialGradient></defs>` +
      `<rect width="1000" height="1000" fill="url(#a)"/>` +
      grain(23, 0.5),
  },
];

const executablePath = process.env.MW_BROWSER_EXECUTABLE || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
mkdirSync(OUT, { recursive: true });
// Every generated JPEG is replaced, and only those: the licence file stays.
for (const name of readdirSync(OUT)) if (name.endsWith('.jpg')) rmSync(join(OUT, name));

const entries = [];
for (const wallpaper of WALLPAPERS) {
  const files = {};
  for (const [size, px] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:${wallpaper.color}}svg{display:block}</style>` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="${px}" height="${px}">` +
        `${wallpaper.svg}</svg>`,
    );
    const body = await page.screenshot({ type: 'jpeg', quality: size === 'thumb' ? 78 : 84 });
    await page.close();
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    const file = `${wallpaper.id}-${px}.${hash}.jpg`;
    writeFileSync(join(OUT, file), body);
    files[size] = file;
    process.stderr.write(`${file}  ${body.length} bytes\n`);
  }
  entries.push({ id: wallpaper.id, name: wallpaper.name, tone: wallpaper.tone, color: wallpaper.color, ...files });
}
await browser.close();
process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
