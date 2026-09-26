#!/usr/bin/env node
/**
 * The bundled wallpapers (plan items P6.2 and P6.3), generated.
 *
 * **Generated, not licensed.** Every wallpaper is a parametric SVG drawn from
 * a seed by one of the functions below, rasterised by the bundled headless
 * Chromium and saved as **JPEG** — old kitchen iPads cannot show WebP. They
 * are this project's own work, so there is no stock-photo licence question,
 * and a wallpaper is changed by changing its seed or its drawing and running
 * this script again. The set is twenty-six across the seven categories the
 * plan names (Q10, the proposed default).
 *
 * **Every master is square and composed with nothing of interest near its
 * edges.** `cover` crops one square to a portrait wall and to a landscape one
 * — a 16:9 canvas sees the middle 56% of the height and a 9:16 canvas the
 * middle 56% of the width — so a sun, a sweep of shapes or the crest of a hill
 * sits inside the centre of the master, and only texture and ground reach the
 * corners. A wallpaper that wants the wall to look at a particular band can
 * name a focal point, which becomes the canvas's `background-position`.
 *
 * **Lean dark and low-contrast (P6.3).** Every contrast guarantee on a wall is
 * measured against a flat ground, and over a picture the widget ground puts
 * only 86% of that ground back — so the picture's lightest region (under a
 * dark theme) and darkest region (under a light one) are what a date numeral
 * ends up sitting on. `browser-wallpaper-contrast.test.ts` decodes every
 * shipped file, finds those regions and holds the matching themes' `--ink`
 * and `--ink-scaffold` to 4.5:1 through the Soft ground; a wallpaper that
 * fails does not ship. The drawings here keep their highlights to a mid tone
 * for that reason, and the fine grain over each is what makes the files cost
 * what a picture costs to decode rather than what a gradient does.
 *
 * Three files per wallpaper: 320px for the picker, and long edges of 1600 and
 * 2880 for the wall, which picks by its own pixel size. Names are
 * content-hashed so an edited picture is a new URL under the route's year-long
 * cache; `wallpapers.test.ts` holds every name to its bytes. The catalogue the
 * server reads is written by this script to `apps/server/src/wallpaper-catalogue.ts`,
 * with each picture's mean colour and mean luminance measured off the raster
 * rather than typed — the luminance is what marks a wallpaper "not for OLED
 * screens" in the picker.
 *
 *   MW_BROWSER_EXECUTABLE=/path/to/chrome node scripts/wallpapers/generate.mjs [id …]
 *
 * With ids, only those are redrawn and the rest of the catalogue is kept.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'apps', 'server', 'package.json'));
const { chromium } = require('playwright-core');

const OUT = join(root, 'apps', 'server', 'assets', 'wallpapers');
const CATALOGUE = join(root, 'apps', 'server', 'src', 'wallpaper-catalogue.ts');
const SIZES = { thumb: 320, small: 1600, large: 2880 };
/** JPEG quality: the set has to fit a 15 MB budget, and grain is what costs. */
const QUALITY = { thumb: 76, small: 80, large: 80 };

// --- A seeded random number generator -----------------------------------

/** mulberry32: small, fast, and the same sequence on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

const f = (n) => Number(n.toFixed(1));

// --- Shared drawing pieces ----------------------------------------------

/**
 * A fine grain the same at every size: fractal noise blended over the art.
 * Every wallpaper carries one, so a smooth gradient costs the wall what a
 * picture costs to decode, and so JPEG compression has something to hold on
 * to rather than banding a clean ramp.
 */
const grain = (seed, opacity, frequency = 0.9) =>
  `<filter id="grain" x="0" y="0" width="100%" height="100%">` +
  `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="${seed}" stitchTiles="stitch"/>` +
  `<feColorMatrix type="saturate" values="0"/></filter>` +
  `<rect width="1000" height="1000" filter="url(#grain)" opacity="${opacity}" style="mix-blend-mode:overlay"/>`;

/** A soft blurred blob: a glow, a cloud, a wash. */
const blur = (id, deviation) =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${deviation}"/></filter>`;

const linear = (id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
  stops.map(([at, color, opacity]) => `<stop offset="${at}" stop-color="${color}"${opacity === undefined ? '' : ` stop-opacity="${opacity}"`}/>`).join('') +
  `</linearGradient>`;

const radial = (id, stops, cx = 0.5, cy = 0.5, r = 0.6) =>
  `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">` +
  stops.map(([at, color, opacity]) => `<stop offset="${at}" stop-color="${color}"${opacity === undefined ? '' : ` stop-opacity="${opacity}"`}/>`).join('') +
  `</radialGradient>`;

const full = (fill) => `<rect width="1000" height="1000" fill="${fill}"/>`;

/** A smooth horizon: a wavy band from the left edge to the right, filled down. */
function ridge(r, baseline, amplitude, fill, segments = 5) {
  const step = 1000 / segments;
  let d = `M-50 ${f(baseline + r.between(-amplitude, amplitude))}`;
  let x = 0;
  for (let i = 0; i <= segments; i += 1) {
    const nx = i * step;
    const ny = baseline + r.between(-amplitude, amplitude);
    const c1 = x + step * 0.4;
    const c2 = nx - step * 0.4;
    d += ` C ${f(c1)} ${f(baseline + r.between(-amplitude, amplitude))} ${f(c2)} ${f(ny)} ${f(nx)} ${f(ny)}`;
    x = nx;
  }
  d += ` L1050 1050 L-50 1050 Z`;
  return `<path d="${d}" fill="${fill}"/>`;
}

/** A soft gradient: a base ramp, one or two glows, grain. */
function gradientSky(r, base, glows, seed, grainAt = 0.35) {
  const defs =
    linear('base', base) +
    glows.map((g, i) => radial(`glow${i}`, [[0, g.color, g.opacity], [1, g.color, 0]], g.cx, g.cy, g.r)).join('');
  const body = full('url(#base)') + glows.map((_, i) => full(`url(#glow${i})`)).join('');
  return `<defs>${defs}</defs>${body}${grain(seed, grainAt)}`;
}

/** Concentric loops pushed about by noise: a contour map. */
function contours(r, ground, line, opacity, seed, count = 18, width = 1.6) {
  const cx = r.between(420, 580);
  const cy = r.between(420, 580);
  let loops = '';
  for (let i = 1; i <= count; i += 1) {
    const rx = 28 * i + r.between(-8, 8);
    const ry = 24 * i + r.between(-8, 8);
    loops += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="none" stroke="${line}" stroke-width="${width}" stroke-opacity="${opacity}"/>`;
  }
  return (
    `<defs><filter id="warp" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="3" seed="${seed}"/>` +
    `<feDisplacementMap in="SourceGraphic" scale="140" xChannelSelector="R" yChannelSelector="G"/></filter></defs>` +
    full(ground) +
    `<g filter="url(#warp)">${loops}</g>` +
    grain(seed + 3, 0.3)
  );
}

/** A leaf: two arcs meeting at a point. Rotated and scaled at the call site. */
const leaf = (x, y, size, rotate, fill, opacity) =>
  `<path transform="translate(${f(x)} ${f(y)}) rotate(${f(rotate)}) scale(${f(size / 40)})" ` +
  `d="M0 -20 C 14 -12 14 12 0 20 C -14 12 -14 -12 0 -20 Z" fill="${fill}" fill-opacity="${opacity}"/>`;

/** Points scattered without landing near one another. */
function scatter(r, count, minGap, inset = 0) {
  const points = [];
  let tries = 0;
  while (points.length < count && tries < count * 60) {
    tries += 1;
    const x = r.between(inset, 1000 - inset);
    const y = r.between(inset, 1000 - inset);
    if (points.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 > minGap * minGap)) points.push({ x, y });
  }
  return points;
}

// --- The set --------------------------------------------------------------
//
// Each entry: id, name, category (Q10), tone, the themes it is drawn for,
// an optional focal point (percent of the master, for `background-position`),
// a seed, and a drawing. Suggested themes are the built-ins of the same tone
// whose palette the picture sits well under; the picker offers a wallpaper by
// tone and names the suggestion.

const DARK_THEMES = ['panels', 'swiss'];
const LIGHT_THEMES = ['household', 'almanac', 'blueprint'];

export const WALLPAPERS = [
  // --- Soft gradients: four dark, two light ---
  {
    id: 'dusk', name: 'Dusk', category: 'gradient', tone: 'dark', themes: DARK_THEMES, seed: 7,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#12172A'], [0.55, '#1F2440'], [1, '#332A44']],
        [{ color: '#5A3F55', opacity: 0.5, cx: 0.5, cy: 0.82, r: 0.55 }],
        s,
      ),
  },
  {
    id: 'midnight', name: 'Midnight', category: 'gradient', tone: 'dark', themes: DARK_THEMES, seed: 19,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#0B0F1C'], [1, '#141A2C']],
        [{ color: '#24345C', opacity: 0.55, cx: 0.5, cy: 0.45, r: 0.5 }],
        s,
      ),
  },
  {
    id: 'ember', name: 'Ember', category: 'gradient', tone: 'dark', themes: DARK_THEMES, seed: 31,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#1A1212'], [0.6, '#2A1A16'], [1, '#3A2418']],
        [{ color: '#7A3E22', opacity: 0.45, cx: 0.5, cy: 0.6, r: 0.5 }],
        s,
      ),
  },
  {
    id: 'deep-sea', name: 'Deep sea', category: 'gradient', tone: 'dark', themes: DARK_THEMES, seed: 47,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#0A1A22'], [0.5, '#0F2A33'], [1, '#0B1E26']],
        [{ color: '#1E5C66', opacity: 0.5, cx: 0.5, cy: 0.35, r: 0.55 }],
        s,
      ),
  },
  {
    id: 'dawn-haze', name: 'Dawn haze', category: 'gradient', tone: 'light', themes: LIGHT_THEMES, seed: 53,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#E6E2EC'], [0.5, '#F0E6E2'], [1, '#EADDD2']],
        [{ color: '#F3D9C6', opacity: 0.7, cx: 0.5, cy: 0.6, r: 0.5 }],
        s,
        0.3,
      ),
  },
  {
    id: 'mist', name: 'Mist', category: 'gradient', tone: 'light', themes: LIGHT_THEMES, seed: 61,
    draw: (r, s) =>
      gradientSky(
        r,
        [[0, '#E4E8EA'], [1, '#D8DEE2']],
        [{ color: '#EEF1F2', opacity: 0.8, cx: 0.5, cy: 0.5, r: 0.5 }],
        s,
        0.3,
      ),
  },

  // --- Paper, linen and watercolour textures: four, all light ---
  {
    id: 'paper', name: 'Paper', category: 'texture', tone: 'light', themes: LIGHT_THEMES, seed: 23,
    draw: (r, s) =>
      `<defs>${radial('a', [[0, '#F3EFE6'], [1, '#E6DFD1']], 0.5, 0.45, 0.75)}</defs>` +
      full('url(#a)') +
      grain(s, 0.45, 0.8),
  },
  {
    id: 'linen', name: 'Linen', category: 'texture', tone: 'light', themes: LIGHT_THEMES, seed: 29,
    draw: (r, s) =>
      `<defs>${radial('a', [[0, '#EDE7DB'], [1, '#E0D8C8']], 0.5, 0.5, 0.8)}` +
      `<pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse">` +
      `<rect width="6" height="3" fill="#000" fill-opacity="0.035"/><rect width="3" height="6" fill="#fff" fill-opacity="0.06"/></pattern></defs>` +
      full('url(#a)') +
      full('url(#weave)') +
      grain(s, 0.4, 1.2),
  },
  {
    id: 'watercolour', name: 'Watercolour', category: 'texture', tone: 'light', themes: LIGHT_THEMES, seed: 37,
    draw: (r, s) => {
      const washes = ['#D9C7B8', '#C9CFC0', '#D4C4C9', '#C7CCD6'];
      let body = '';
      for (let i = 0; i < 7; i += 1) {
        const cx = r.between(250, 750);
        const cy = r.between(250, 750);
        body += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(r.between(140, 260))}" ry="${f(r.between(120, 220))}" fill="${r.pick(washes)}" fill-opacity="0.55" filter="url(#wash)" transform="rotate(${f(r.between(0, 180))} ${f(cx)} ${f(cy)})"/>`;
      }
      return `<defs>${blur('wash', 45)}</defs>` + full('#F1ECE3') + body + grain(s, 0.4, 0.7);
    },
  },
  {
    id: 'plaster', name: 'Plaster', category: 'texture', tone: 'light', themes: LIGHT_THEMES, seed: 41,
    draw: (r, s) =>
      `<defs><filter id="mottle" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="4" seed="${s}"/>` +
      `<feColorMatrix type="saturate" values="0"/>` +
      `<feComponentTransfer><feFuncA type="table" tableValues="0 0.22"/></feComponentTransfer></filter></defs>` +
      full('#E9E5DC') +
      `<rect width="1000" height="1000" filter="url(#mottle)" fill="#000"/>` +
      grain(s + 1, 0.35, 1.1),
  },

  // --- Contour lines: two dark, one light ---
  {
    id: 'contours', name: 'Contours', category: 'contour', tone: 'dark', themes: DARK_THEMES, seed: 71,
    draw: (r, s) => contours(r, '#161B22', '#8FA0B2', 0.32, s),
  },
  {
    id: 'charted', name: 'Charted', category: 'contour', tone: 'dark', themes: DARK_THEMES, seed: 79,
    draw: (r, s) => contours(r, '#1A1F1B', '#B9A98A', 0.28, s, 24, 1.2),
  },
  {
    id: 'survey', name: 'Survey', category: 'contour', tone: 'light', themes: LIGHT_THEMES, seed: 83,
    draw: (r, s) => contours(r, '#EEEAE1', '#6C655A', 0.28, s, 20, 1.4),
  },

  // --- Geometric: Bauhaus shapes, terrazzo, a grid ---
  {
    id: 'bauhaus', name: 'Bauhaus', category: 'geometric', tone: 'dark', themes: DARK_THEMES, seed: 89,
    draw: (r, s) => {
      const inks = ['#B0593A', '#C9A24A', '#3E6E8E', '#7A8A6A'];
      let body = '';
      // Large quiet shapes, all inside the middle of the master.
      body += `<circle cx="470" cy="520" r="190" fill="${inks[2]}" fill-opacity="0.55"/>`;
      body += `<rect x="520" y="330" width="220" height="220" fill="${inks[0]}" fill-opacity="0.55"/>`;
      body += `<path d="M300 700 A 200 200 0 0 1 500 500 L500 700 Z" fill="${inks[1]}" fill-opacity="0.5"/>`;
      body += `<rect x="560" y="600" width="150" height="40" fill="${inks[3]}" fill-opacity="0.6"/>`;
      body += `<circle cx="640" cy="720" r="42" fill="${inks[1]}" fill-opacity="0.5"/>`;
      body += `<line x1="280" y1="360" x2="420" y2="360" stroke="${inks[3]}" stroke-width="6" stroke-opacity="0.6"/>`;
      return full('#1A1B1F') + body + grain(s, 0.35);
    },
  },
  {
    id: 'terrazzo', name: 'Terrazzo', category: 'geometric', tone: 'light', themes: LIGHT_THEMES, seed: 97,
    draw: (r, s) => {
      const chips = ['#C9B8A8', '#A8B4B0', '#BDB0B8', '#B3B9C4', '#D0C4A9'];
      let body = '';
      for (const p of scatter(r, 140, 46)) {
        const n = r.int(4, 6);
        const size = r.between(9, 24);
        let d = '';
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * Math.PI * 2 + r.between(-0.3, 0.3);
          const rad = size * r.between(0.6, 1);
          d += `${i === 0 ? 'M' : 'L'}${f(p.x + Math.cos(a) * rad)} ${f(p.y + Math.sin(a) * rad)}`;
        }
        body += `<path d="${d}Z" fill="${r.pick(chips)}" fill-opacity="0.85"/>`;
      }
      return full('#ECE8E0') + body + grain(s, 0.3, 1.1);
    },
  },
  {
    id: 'grid', name: 'Grid', category: 'geometric', tone: 'dark', themes: DARK_THEMES, seed: 101,
    draw: (r, s) => {
      let body = '';
      for (let i = 0; i <= 1000; i += 50) {
        body += `<line x1="${i}" y1="0" x2="${i}" y2="1000" stroke="#8B93A0" stroke-width="1" stroke-opacity="0.22"/>`;
        body += `<line x1="0" y1="${i}" x2="1000" y2="${i}" stroke="#8B93A0" stroke-width="1" stroke-opacity="0.22"/>`;
      }
      for (const p of scatter(r, 9, 120, 250)) {
        const x = Math.floor(p.x / 50) * 50;
        const y = Math.floor(p.y / 50) * 50;
        body += `<rect x="${x}" y="${y}" width="50" height="50" fill="#5C93E0" fill-opacity="${f(r.between(0.12, 0.28))}"/>`;
      }
      return full('#14171D') + body + grain(s, 0.3);
    },
  },

  // --- Landscapes: layered hills, dunes, a dawn sky, a dusk sky ---
  {
    id: 'hills', name: 'Hills', category: 'landscape', tone: 'dark', themes: DARK_THEMES, focal: { x: 50, y: 58 }, seed: 11,
    draw: (r, s) =>
      `<defs>${linear('sky', [[0, '#15201F'], [1, '#22322E']])}</defs>` +
      full('url(#sky)') +
      ridge(r, 540, 30, '#1F312C') +
      ridge(r, 650, 24, '#1A2A26') +
      ridge(r, 760, 20, '#152320') +
      ridge(r, 870, 14, '#111C1A') +
      grain(s, 0.4),
  },
  {
    id: 'dunes', name: 'Dunes', category: 'landscape', tone: 'light', themes: LIGHT_THEMES, focal: { x: 50, y: 58 }, seed: 13,
    draw: (r, s) =>
      `<defs>${linear('sky', [[0, '#EDE6DA'], [1, '#E6DCCB']])}</defs>` +
      full('url(#sky)') +
      ridge(r, 520, 36, '#E2D5C0', 3) +
      ridge(r, 640, 30, '#DED1BB', 3) +
      ridge(r, 760, 24, '#D9CAB2', 3) +
      ridge(r, 880, 18, '#D4C4A9', 3) +
      grain(s, 0.35),
  },
  {
    id: 'dawn-sky', name: 'Dawn sky', category: 'landscape', tone: 'light', themes: LIGHT_THEMES, seed: 17,
    draw: (r, s) => {
      let clouds = '';
      for (let i = 0; i < 6; i += 1) {
        const cx = r.between(300, 700);
        const cy = r.between(300, 620);
        clouds += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(r.between(120, 220))}" ry="${f(r.between(28, 56))}" fill="#F6EEE6" fill-opacity="0.7" filter="url(#cloud)"/>`;
      }
      return (
        `<defs>${linear('sky', [[0, '#D9DCE6'], [0.55, '#EADFD8'], [1, '#EFD9C4']])}` +
        radial('sun', [[0, '#F7E3C2', 0.9], [1, '#F7E3C2', 0]], 0.5, 0.66, 0.35) +
        blur('cloud', 22) +
        `</defs>` +
        full('url(#sky)') +
        full('url(#sun)') +
        clouds +
        grain(s, 0.3)
      );
    },
  },
  {
    id: 'dusk-sky', name: 'Dusk sky', category: 'landscape', tone: 'dark', themes: DARK_THEMES, focal: { x: 50, y: 55 }, seed: 43,
    draw: (r, s) => {
      let stars = '';
      for (const p of scatter(r, 60, 30)) {
        if (p.y > 560) continue;
        stars += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(r.between(0.8, 1.8))}" fill="#DCD6E4" fill-opacity="${f(r.between(0.3, 0.7))}"/>`;
      }
      return (
        `<defs>${linear('sky', [[0, '#0E1020'], [0.5, '#1F1B36'], [0.78, '#4A2E3E'], [1, '#2A1C24']])}` +
        radial('glow', [[0, '#8A4A3E', 0.5], [1, '#8A4A3E', 0]], 0.5, 0.78, 0.4) +
        `</defs>` +
        full('url(#sky)') +
        full('url(#glow)') +
        stars +
        ridge(r, 790, 22, '#110E16', 4) +
        ridge(r, 880, 12, '#0C0A10', 4) +
        grain(s, 0.4)
      );
    },
  },

  // --- Seasonal: autumn, winter, spring, summer ---
  {
    id: 'autumn', name: 'Autumn', category: 'seasonal', tone: 'dark', themes: DARK_THEMES, seed: 59,
    draw: (r, s) => {
      const inks = ['#A0522D', '#B8742F', '#8A5A2A', '#6E4A2E', '#9C6B36'];
      let body = '';
      for (const p of scatter(r, 70, 62)) {
        body += leaf(p.x, p.y, r.between(28, 52), r.between(0, 360), r.pick(inks), r.between(0.35, 0.6));
      }
      return `<defs>${radial('g', [[0, '#26201A'], [1, '#17130F']], 0.5, 0.5, 0.75)}</defs>` + full('url(#g)') + body + grain(s, 0.35);
    },
  },
  {
    id: 'winter', name: 'Winter', category: 'seasonal', tone: 'light', themes: LIGHT_THEMES, focal: { x: 50, y: 56 }, seed: 67,
    draw: (r, s) => {
      let flakes = '';
      for (const p of scatter(r, 90, 40)) {
        flakes += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(r.between(1.5, 4))}" fill="#FFFFFF" fill-opacity="${f(r.between(0.35, 0.7))}"/>`;
      }
      return (
        `<defs>${linear('sky', [[0, '#DCE3EA'], [1, '#E9EEF2']])}</defs>` +
        full('url(#sky)') +
        ridge(r, 600, 26, '#E3E9EE', 4) +
        ridge(r, 720, 22, '#DCE4EA', 4) +
        ridge(r, 840, 16, '#D3DDE5', 4) +
        flakes +
        grain(s, 0.3)
      );
    },
  },
  {
    id: 'spring', name: 'Spring', category: 'seasonal', tone: 'light', themes: LIGHT_THEMES, seed: 73,
    draw: (r, s) => {
      const petals = ['#E8C4CC', '#D9B9C6', '#C9D3B8', '#E3CFB6'];
      let body = '';
      for (const p of scatter(r, 60, 66, 60)) {
        const size = r.between(9, 18);
        const fill = r.pick(petals);
        for (let i = 0; i < 5; i += 1) {
          const a = (i / 5) * 360 + r.between(-8, 8);
          body += `<ellipse cx="${f(p.x)}" cy="${f(p.y - size)}" rx="${f(size * 0.45)}" ry="${f(size)}" fill="${fill}" fill-opacity="0.8" transform="rotate(${f(a)} ${f(p.x)} ${f(p.y)})"/>`;
        }
        body += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(size * 0.3)}" fill="#D9C07A" fill-opacity="0.8"/>`;
      }
      return `<defs>${radial('g', [[0, '#F2EFE6'], [1, '#E7E5D8']], 0.5, 0.5, 0.75)}</defs>` + full('url(#g)') + body + grain(s, 0.3);
    },
  },
  {
    id: 'summer', name: 'Summer', category: 'seasonal', tone: 'dark', themes: DARK_THEMES, seed: 103,
    draw: (r, s) => {
      let waves = '';
      for (let i = 0; i < 9; i += 1) {
        const y = 560 + i * 44;
        let d = `M-50 ${y}`;
        for (let x = 0; x <= 1000; x += 125) d += ` q 62 ${f(r.between(-14, -6))} 125 0`;
        waves += `<path d="${d}" fill="none" stroke="#3B8A96" stroke-width="2.5" stroke-opacity="${f(0.45 - i * 0.035)}"/>`;
      }
      return (
        `<defs>${linear('sky', [[0, '#0F2A3A'], [0.5, '#12384A'], [1, '#0B2430']])}` +
        radial('sun', [[0, '#C98A3C', 0.55], [1, '#C98A3C', 0]], 0.5, 0.46, 0.3) +
        `</defs>` +
        full('url(#sky)') +
        full('url(#sun)') +
        `<circle cx="500" cy="460" r="58" fill="#C98A3C" fill-opacity="0.5"/>` +
        waves +
        grain(s, 0.35)
      );
    },
  },

  // --- Fun: confetti, a night sky ---
  {
    id: 'confetti', name: 'Confetti', category: 'fun', tone: 'dark', themes: DARK_THEMES, seed: 107,
    draw: (r, s) => {
      const inks = ['#C9A24A', '#B0593A', '#5C93E0', '#35916A', '#B56A9A'];
      let body = '';
      for (const p of scatter(r, 160, 40)) {
        const w = r.between(8, 16);
        const h = r.between(14, 26);
        body += `<rect x="${f(p.x - w / 2)}" y="${f(p.y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="2" fill="${r.pick(inks)}" fill-opacity="${f(r.between(0.35, 0.65))}" transform="rotate(${f(r.between(0, 180))} ${f(p.x)} ${f(p.y)})"/>`;
      }
      return `<defs>${radial('g', [[0, '#1C1A24'], [1, '#12111A']], 0.5, 0.5, 0.75)}</defs>` + full('url(#g)') + body + grain(s, 0.35);
    },
  },
  {
    id: 'night-sky', name: 'Night sky', category: 'fun', tone: 'dark', themes: DARK_THEMES, seed: 109,
    draw: (r, s) => {
      let stars = '';
      for (const p of scatter(r, 220, 18)) {
        stars += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(r.between(0.7, 2.2))}" fill="#E8E4F0" fill-opacity="${f(r.between(0.3, 0.85))}"/>`;
      }
      return (
        `<defs>${linear('sky', [[0, '#080B18'], [1, '#111830']], 0, 0, 1, 1)}` +
        linear('band', [[0, '#3A4270', 0], [0.5, '#3A4270', 0.45], [1, '#3A4270', 0]], 0, 0, 1, 0) +
        blur('soft', 60) +
        `</defs>` +
        full('url(#sky)') +
        `<rect x="-100" y="380" width="1200" height="240" fill="url(#band)" filter="url(#soft)" transform="rotate(-28 500 500)"/>` +
        stars +
        grain(s, 0.3)
      );
    },
  },
];

// --- Rendering ------------------------------------------------------------

const only = new Set(process.argv.slice(2));
const executablePath = process.env.MW_BROWSER_EXECUTABLE || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
mkdirSync(OUT, { recursive: true });

/** The catalogue as it stands, so a partial run keeps what it did not redraw. */
const kept = new Map();
if (only.size > 0 && existsSync(CATALOGUE)) {
  const json = /\/\* catalogue \*\/ (\[[\s\S]*?\]) as const;/.exec(readFileSync(CATALOGUE, 'utf8'))?.[1];
  if (json) for (const entry of JSON.parse(json)) kept.set(entry.id, entry);
}

/**
 * The picture's mean colour and mean relative luminance, measured off the
 * rendered raster rather than typed: the colour is the picker's tile while
 * the thumbnail loads, and the luminance is what marks a wallpaper "not for
 * OLED screens".
 */
async function measure(page, bytes) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 200, 200);
    const { data } = ctx.getImageData(0, 0, 200, 200);
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    let r = 0, g = 0, bl = 0, lum = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; bl += data[i + 2];
      lum += 0.2126 * lin(data[i] / 255) + 0.7152 * lin(data[i + 1] / 255) + 0.0722 * lin(data[i + 2] / 255);
    }
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0').toUpperCase();
    return { color: `#${hex(r)}${hex(g)}${hex(bl)}`, luminance: Number((lum / n).toFixed(3)) };
  }, bytes.toString('base64'));
}

const entries = [];
for (const wallpaper of WALLPAPERS) {
  if (only.size > 0 && !only.has(wallpaper.id)) {
    const previous = kept.get(wallpaper.id);
    if (previous === undefined) throw new Error(`${wallpaper.id} is not in the catalogue yet; run without ids`);
    entries.push(previous);
    continue;
  }
  const files = {};
  let stats;
  for (const [size, px] of Object.entries(SIZES)) {
    const r = rng(wallpaper.seed);
    const svg = wallpaper.draw(r, wallpaper.seed);
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:#000}svg{display:block}</style>` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="${px}" height="${px}">${svg}</svg>`,
    );
    const body = await page.screenshot({ type: 'jpeg', quality: QUALITY[size] });
    if (size === 'small') stats = await measure(page, body);
    await page.close();
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    const file = `${wallpaper.id}-${px}.${hash}.jpg`;
    writeFileSync(join(OUT, file), body);
    files[size] = file;
    process.stderr.write(`${file}  ${body.length} bytes\n`);
  }
  entries.push({
    id: wallpaper.id,
    name: wallpaper.name,
    category: wallpaper.category,
    tone: wallpaper.tone,
    themes: wallpaper.themes,
    ...(wallpaper.focal ? { focal: wallpaper.focal } : {}),
    color: stats.color,
    luminance: stats.luminance,
    ...files,
  });
}
await browser.close();

// Every generated JPEG the catalogue no longer names is removed, and only
// those: the licence file stays.
const named = new Set(entries.flatMap((e) => [e.thumb, e.small, e.large]));
for (const name of readdirSync(OUT)) if (name.endsWith('.jpg') && !named.has(name)) rmSync(join(OUT, name));

writeFileSync(
  CATALOGUE,
  `/**\n * The wallpaper catalogue (plan item P6.2). GENERATED by\n * \`scripts/wallpapers/generate.mjs\` — edit the drawing or the seed there and\n * run it again; do not edit this file.\n *\n * Every colour and luminance here was measured off the rendered picture, and\n * every file name is the sha256 of the bytes it names.\n */\nexport const WALLPAPER_CATALOGUE = /* catalogue */ ${JSON.stringify(entries, null, 2)} as const;\n`,
);
const total = readdirSync(OUT).reduce((sum, name) => sum + readFileSync(join(OUT, name)).length, 0);
process.stderr.write(`${entries.length} wallpapers, ${(total / 1024 / 1024).toFixed(2)} MB\n`);
