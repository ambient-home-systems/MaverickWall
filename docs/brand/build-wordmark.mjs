import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/*
  Regenerates the wordmark and the lockups:

      node docs/brand/build-wordmark.mjs

  The letterforms live here rather than as path data in the SVGs, so a spacing
  or a stem can be argued about against something readable. The output is
  committed — nothing in the build or the image runs this.
*/

/*
  A condensed geometric display alphabet, drawn rather than set.

  Cap height 64, stem 11, and every corner that would be a curve in a
  humanist face is cut at 45 degrees instead. That is one decision applied
  everywhere (C, R), which is what stops it reading as failed curves.
*/

const GLYPHS = {
  M: { w: 52, d: 'M0 64 V0 H23 L26 11 L29 0 H52 V64 H41 V0 H40 L26 52 L12 0 H11 V64 Z' },
  A: { w: 46, d: 'M0 64 L16 0 H30 L46 64 H35 L31 47 H15 L11 64 Z M23 17 L28 36 H18 Z' },
  V: { w: 46, d: 'M0 0 H11 L23 47 L35 0 H46 L28 64 H18 Z' },
  E: { w: 40, d: 'M0 0 H40 V11 H11 V26 H34 V37 H11 V53 H40 V64 H0 Z' },
  R: {
    w: 44,
    d: 'M0 0 H33 L44 11 V28 L36 39 L44 64 H32 L24 39 H11 V64 H0 Z '
     + 'M11 11 V28 H28 L33 23 V16 L28 11 Z',
  },
  I: { w: 11, d: 'M0 0 H11 V64 H0 Z' },
  C: {
    w: 44,
    d: 'M12 0 H32 L44 12 V19 H33 V16 L28 11 H16 L11 16 V48 L16 53 H28 L33 48 V45 H44 V52 '
     + 'L32 64 H12 L0 52 V12 Z',
  },
  K: { w: 47, d: 'M0 0 H11 V27 L33 0 H46 L26 32 L47 64 H34 L11 48 V64 H0 Z' },
  W: { w: 66, d: 'M0 0 H11 L20 45 L28 8 H38 L46 45 L55 0 H66 L52 64 H40 L33 26 L26 64 H14 Z' },
  L: { w: 38, d: 'M0 0 H11 V53 H38 V64 H0 Z' },
};

const TRACK = 7;
const SPACE = 22;

/*
  Kerns for the pairs that leave a hole at cap height: a diagonal beside a
  vertical, or two L's, where even tracking reads as a word break.
*/
const KERN = { WA: -6, AL: -4, LL: -3, AV: -3, VE: -3 };

function word(text) {
  let x = 0;
  const parts = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ') { x += SPACE; continue; }
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    x += KERN[text.slice(i - 1, i + 1)] ?? 0;
    parts.push(`<path d="${g.d}" transform="translate(${x} 0)"/>`);
    x += g.w + TRACK;
  }
  return { width: x - TRACK, body: parts.join('') };
}

const ACCENT = 'var(--mw-accent, #E8A33D)';
const NEUTRAL = 'var(--mw-neutral, #6B7684)';
const INK = 'var(--mw-ink, #E9EEF4)';

/* The mark, in the same units, so a lockup is one coordinate system. */
const MARK = `
    <g fill="${NEUTRAL}" fill-opacity=".34">
      <rect x="8" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="22" y="15" width="6" height="6" rx="1"/><rect x="29" y="15" width="6" height="6" rx="1"/><rect x="36" y="15" width="6" height="6" rx="1"/><rect x="43" y="15" width="6" height="6" rx="1"/><rect x="50" y="15" width="6" height="6" rx="1"/>
      <rect x="8" y="22" width="6" height="6" rx="1"/><rect x="15" y="22" width="6" height="6" rx="1"/><rect x="22" y="22" width="6" height="6" rx="1"/><rect x="29" y="22" width="6" height="6" rx="1"/><rect x="36" y="22" width="6" height="6" rx="1"/><rect x="43" y="22" width="6" height="6" rx="1"/><rect x="50" y="22" width="6" height="6" rx="1"/>
      <rect x="8" y="29" width="6" height="6" rx="1"/><rect x="15" y="29" width="6" height="6" rx="1"/><rect x="22" y="29" width="6" height="6" rx="1"/><rect x="36" y="29" width="6" height="6" rx="1"/><rect x="43" y="29" width="6" height="6" rx="1"/><rect x="50" y="29" width="6" height="6" rx="1"/>
      <rect x="8" y="36" width="6" height="6" rx="1"/><rect x="15" y="36" width="6" height="6" rx="1"/><rect x="22" y="36" width="6" height="6" rx="1"/><rect x="29" y="36" width="6" height="6" rx="1"/><rect x="36" y="36" width="6" height="6" rx="1"/><rect x="43" y="36" width="6" height="6" rx="1"/><rect x="50" y="36" width="6" height="6" rx="1"/>
      <rect x="8" y="43" width="6" height="6" rx="1"/><rect x="15" y="43" width="6" height="6" rx="1"/><rect x="22" y="43" width="6" height="6" rx="1"/><rect x="29" y="43" width="6" height="6" rx="1"/><rect x="36" y="43" width="6" height="6" rx="1"/><rect x="43" y="43" width="6" height="6" rx="1"/><rect x="50" y="43" width="6" height="6" rx="1"/>
    </g>
    <rect x="29" y="29" width="6" height="6" rx="1" fill="${ACCENT}"/>`;

const out = dirname(fileURLToPath(import.meta.url));
mkdirSync(`${out}/wordmark`, { recursive: true });

/* ---- one-line wordmark ---- */
const mav = word('MAVERICK');
const wal = word('WALL');
const line = word('MAVERICK WALL');

writeFileSync(`${out}/wordmark/wordmark.svg`,
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${line.width} 64" width="${line.width}" height="64" role="img" aria-label="Maverick Wall">
  <!-- Outlined, so it renders identically on a machine with no fonts installed. -->
  <g fill="${INK}" fill-rule="evenodd">${line.body}</g>
</svg>
`);

/* ----
   Lockups are bound to the mark's INK box, not its padded icon box, and the
   mark is scaled so its ink height equals the cap height. Dropped in at its
   icon size the grid reads a size smaller than the type beside it.
   ---- */
const INK_X = 8, INK_Y = 15, INK_W = 48, INK_H = 34;

function lockup(cap, lines, lead) {
  const k = (cap * lines.length + lead * (lines.length - 1)) / INK_H;
  const s = cap / 64;
  const markW = INK_W * k;
  const gap = Math.round(cap * 0.55);
  const x = markW + gap;
  const h = INK_H * k;
  const w = Math.round(x + Math.max(...lines.map((l) => l.width)) * s);
  const text = lines
    .map((l, i) =>
      `<g transform="translate(${x.toFixed(2)} ${(i * (cap + lead)).toFixed(2)}) scale(${s.toFixed(5)})">${l.body}</g>`)
    .join('\n    ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h.toFixed(2)}" width="${w}" height="${h.toFixed(2)}" role="img" aria-label="Maverick Wall">
  <g transform="scale(${k.toFixed(5)}) translate(${-INK_X} ${-INK_Y})">${MARK}
  </g>
  <g fill="${INK}" fill-rule="evenodd">
    ${text}
  </g>
</svg>
`;
}

writeFileSync(`${out}/wordmark/lockup-horizontal.svg`, lockup(44, [line], 0));
writeFileSync(`${out}/wordmark/lockup-stacked.svg`, lockup(26, [mav, wal], 8));

console.log('wordmark', line.width, 'maverick', mav.width, 'wall', wal.width);
