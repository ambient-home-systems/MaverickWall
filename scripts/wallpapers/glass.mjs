/**
 * What each bundled wallpaper shows through Glass (plan item M4.2).
 *
 * Glass lays the theme's card colour over a blurred, saturated view of the
 * picture, and how much card colour it needs is decided by the picture: the
 * lowest opacity that keeps `--ink` and `--ink-scaffold` at 4.5:1 over the
 * picture's brightest and its darkest patch. Those two patches are a fact
 * about the picture, not about any theme, so they are what is measured and
 * stored; the wall solves the opacity for whatever theme it is wearing,
 * a household's own included (`glass-alpha.ts`).
 *
 * Each shipped 1600px file is decoded in Chromium — the only JPEG decoder this
 * repository has, and the one that draws the wall — then blurred and saturated
 * the way `display.css` blurs and saturates it, and cut into 40x40 blocks; the
 * lightest and darkest block colours are written to `wallpaper-glass.ts`.
 *
 * **The blur is the smallest Glass ever draws it at.** `--glass-blur` is
 * 0.6rem, and a rem is 1% of the canvas height, so on a landscape wall it is
 * 0.006 of the height; `cover` scales the square picture to the canvas width,
 * 16/9 of the height, so in the picture's own pixels the blur is
 * 0.006 x 9/16 of its side — 5.4px of a 1600px file. A portrait wall blurs
 * more, which only narrows the extremes, so the landscape figure is the one a
 * promise can be made from.
 *
 * Run `node scripts/wallpapers/glass.mjs` after `generate.mjs` has drawn new
 * pictures. `browser-wallpaper-glass.test.ts` measures the shipped files again,
 * at both sizes a wall fetches, and fails when this table has fallen behind.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'apps', 'server', 'package.json'));
const { chromium } = require('playwright-core');

const DIR = join(root, 'apps', 'server', 'assets', 'wallpapers');
const CATALOGUE = join(root, 'apps', 'server', 'src', 'wallpaper-catalogue.ts');
const OUT = join(root, 'apps', 'server', 'src', 'wallpaper-glass.ts');

/** `--glass-blur`'s share of a picture's side on a landscape wall: 0.6rem of the height, over 16/9 of it. */
export const GLASS_BLUR_SHARE = 0.006 * (9 / 16);
/** `--glass-saturate`. */
export const GLASS_SATURATE = 1.4;
export const BLOCKS = 40;

const source = readFileSync(CATALOGUE, 'utf8');
const catalogue = JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1));

const executablePath = process.env.MW_BROWSER_EXECUTABLE || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();

const table = {};
for (const wallpaper of catalogue) {
  const b64 = readFileSync(join(DIR, wallpaper.small)).toString('base64');
  table[wallpaper.id] = await page.evaluate(
    async ({ b64, blocks, share, saturate }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.filter = `blur(${share * img.naturalWidth}px) saturate(${saturate})`;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = (c) => 0.2126 * lin(c[0] / 255) + 0.7152 * lin(c[1] / 255) + 0.0722 * lin(c[2] / 255);
      const bw = canvas.width / blocks;
      const bh = canvas.height / blocks;
      let light;
      let dark;
      for (let by = 0; by < blocks; by++) {
        for (let bx = 0; bx < blocks; bx++) {
          const sum = [0, 0, 0];
          let n = 0;
          for (let y = Math.floor(by * bh); y < Math.floor((by + 1) * bh); y++) {
            for (let x = Math.floor(bx * bw); x < Math.floor((bx + 1) * bw); x++) {
              const i = (y * canvas.width + x) * 4;
              sum[0] += data[i];
              sum[1] += data[i + 1];
              sum[2] += data[i + 2];
              n++;
            }
          }
          const block = sum.map((v) => Math.round(v / n));
          if (light === undefined || lum(block) > lum(light)) light = block;
          if (dark === undefined || lum(block) < lum(dark)) dark = block;
        }
      }
      const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      return { light: hex(light), dark: hex(dark) };
    },
    { b64, blocks: BLOCKS, share: GLASS_BLUR_SHARE, saturate: GLASS_SATURATE },
  );
}
await browser.close();

const body = Object.keys(table)
  .map((id) => `  '${id}': { file: '${catalogue.find((one) => one.id === id).small}', light: '${table[id].light}', dark: '${table[id].dark}' },`)
  .join('\n');
writeFileSync(
  OUT,
  `/**
 * What each bundled wallpaper shows through Glass (plan item M4.2): its lightest
 * and darkest patch, blurred and saturated as Glass draws it. GENERATED by
 * \`scripts/wallpapers/glass.mjs\` from the shipped 1600px files — run it again
 * after the pictures change; do not edit this file. \`file\` is the content-hashed
 * name it was measured from, so \`browser-wallpaper-glass.test.ts\` knows at once
 * when a picture has been redrawn and this has not.
 */
export const WALLPAPER_GLASS: Readonly<Record<string, { readonly file: string; readonly light: string; readonly dark: string }>> = {
${body}
};
`,
);
console.log(`[glass] measured ${Object.keys(table).length} wallpapers into ${OUT}`);
