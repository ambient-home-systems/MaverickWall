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
  A geometric display alphabet, drawn rather than set.

  Cap height 64, stem 11. The bowls are true circles and the apexes are real
  points: an earlier cut chamfered every curve at 45 degrees, and the whole
  wordmark read as a typeface with its curves sliced off rather than as one
  that was drawn that way. Flat-cut apexes on the A, V and W did the same
  thing. Where a stroke ends in the open — the C's terminals — it is cut on
  the vertical, which is the geometric convention and reads as a decision.
*/

const GLYPHS = {
  /*
    The M is 64 wide, and that is the whole of it working.

    At 52 the two 11-unit stems leave 30 for the middle V, and two arms of the
    same weight ate 22 of that — so the V came out a near-solid triangle with a
    token nick in the top edge, and the letter read as filled in and chopped
    off. Three things buy the counter back, and it needed all three:

      - width, because the notch falls at (W/2 - 12 - arm)/(W/2 - 12) of the
        vertex, which is 21% of it at W=52 and 55% at W=64;
      - arms of 9 against stems of 11, which is the ordinary compensation for a
        diagonal reading heavier than a vertical at the same measure;
      - the vertex on the baseline rather than short of it. Stopping at y=60
        left the counters closed at the bottom as well as pinched at the top,
        which is most of what "cut off" was describing.

    Stems at 0..11 and 53..64; the V's outer edges spring one unit inside the
    stems' inner edges, so the counters never pinch to a hairline join.
  */
  M: { w: 64, d: 'M0 64 V0 H21 L32 35.2 L43 0 H64 V64 H53 V0 H52 L32 64 L12 0 H11 V64 Z' },

  /* Pointed apex; the counter closes where the two inner edges meet at y=30.6. */
  A: { w: 46, d: 'M0 64 L23 0 L46 64 H35 L31.77 55 H14.23 L11 64 Z M23 30.6 L27.8 44 H18.2 Z' },

  V: { w: 46, d: 'M0 0 H11 L23 33.4 L35 0 H46 L23 64 Z' },

  E: { w: 40, d: 'M0 0 H40 V11 H11 V26 H34 V37 H11 V53 H40 V64 H0 Z' },

  /* A true semicircular bowl (r 17 outer, 6 inner — an 11 stroke) and a
     straight leg off its join. */
  R: {
    w: 48,
    d: 'M0 0 H31 A17 17 0 0 1 31 34 H24 L48 64 H35 L16 36 H11 V64 H0 Z '
     + 'M11 11 H31 A6 6 0 0 1 31 23 H11 Z',
  },

  I: { w: 11, d: 'M0 0 H11 V64 H0 Z' },

  /* One circle, r 29 outer and 18 inner, opened by a vertical cut at x=43. */
  C: { w: 58, d: 'M43 6.6 A29 29 0 1 0 43 57.4 V43.3 A18 18 0 1 1 43 20.7 Z' },

  K: { w: 47, d: 'M0 0 H11 V27 L33 0 H46 L26 32 L47 64 H34 L11 48 V64 H0 Z' },

  W: { w: 66, d: 'M0 0 H11 L20 45 L28 8 H38 L46 45 L55 0 H66 L46 64 L33 26 L20 64 Z' },

  L: { w: 38, d: 'M0 0 H11 V53 H38 V64 H0 Z' },
};

const TRACK = 7;
const SPACE = 22;

/*
  Kerns for the pairs that leave a hole at cap height: a diagonal beside a
  vertical, or two L's, where even tracking reads as a word break.
*/
const KERN = { WA: -6, AL: -4, LL: -3, AV: -3, VE: -3, IC: -2, CK: -6, MA: -3 };

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
