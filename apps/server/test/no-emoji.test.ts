import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No emoji in anything a screen renders — the scan, because the rule is not
 * self-enforcing.
 *
 * The image ships no emoji font, so an emoji is a **third-party asset resolved
 * on the device**: rule three broken in the one way nothing in this repository
 * can see, since no code here fetches it. A tablet draws its vendor's
 * full-colour cartoon into five hand-tuned monochromatic themes, the tablet
 * beside it draws a different vendor's, and an e-paper panel draws nothing at
 * all because `asciiTitle` deletes every code point above 0x7E. That is how the
 * forecast strip on a panel came to have a hole where the weather goes and no
 * test anywhere noticed: the widget drew inside its box, did not throw and
 * produced ink.
 *
 * **Comments are scanned too, deliberately.** A comment is where the next one
 * gets pasted from — the `⌂` in a `display_mode` label was a fixture nobody had
 * looked at in a year — and a rule with an exemption for "it is only a comment"
 * is a rule that is one copy-and-paste from being broken in earnest.
 *
 * The trees are the ones a screen reads from: the whole display bundle, the
 * server-rendered admin (its pages are a screen too, and its store cards carry
 * marks that reach a panel), the e-paper rasteriser, and every module — which
 * is where all four of the mappings this replaced lived.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const TREES = [
  'apps/display/src',
  'apps/display/test',
  'apps/server/src/http',
  'apps/server/src/epaper',
  'apps/server/src/modules',
  'apps/server/src/catalog',
  'apps/server/src/glyphs.ts',
  // The test trees too, because a *fixture* with an emoji in it is how this
  // fault survived: `browser-harness`, `browser-empty-bands` and
  // `epaper-weather-widget` all seeded a forecast whose icon was a character,
  // so every test that measured a forecast strip was measuring one with no
  // icon in it at all. The test that cannot see the bug is the bug.
  'apps/server/test',
];

/**
 * The one exemption, named rather than pattern-matched.
 *
 * `keyring.test.ts` encrypts and decrypts arbitrary Unicode on purpose — that
 * is a test about *bytes*, and stripping the emoji out of it would weaken it to
 * make a different rule pass. An exemption list of one, in the open, is honest;
 * a clever regular expression that happens to spare it is not.
 */
const EXEMPT = ['apps/server/test/keyring.test.ts'];

/**
 * The ranges, roughly.
 *
 * Pictographs, the miscellaneous-symbols and dingbats blocks the older weather
 * and warning characters live in, arrows-and-symbols, and the variation
 * selector that turns a text symbol into a colour one. Deliberately *not* every
 * non-ASCII code point: this repository is written in English prose with em
 * dashes, degree signs and typographic quotes in it, and a scan that failed on
 * those would be turned off within a week.
 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

function filesUnder(path: string): string[] {
  const full = join(ROOT, path);
  const stat = statSync(full);
  if (stat.isFile()) return [full];
  const out: string[] = [];
  for (const name of readdirSync(full)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const child = join(full, name);
    if (statSync(child).isDirectory()) out.push(...filesUnder(join(path, name)));
    else if (/\.(ts|css|html|js|mjs)$/.test(name)) out.push(child);
  }
  return out;
}

describe('no emoji reaches a screen', () => {
  it('scans the display, the admin, the rasteriser and every module', () => {
    const hits: string[] = [];
    for (const tree of TREES) {
      for (const file of filesUnder(tree)) {
        if (EXEMPT.some((name) => relative(ROOT, file) === name)) continue;
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, index) => {
          const found = line.match(new RegExp(EMOJI, 'gu'));
          if (found !== null) {
            hits.push(`${relative(ROOT, file)}:${index + 1}  ${found.join(' ')}  ${line.trim().slice(0, 70)}`);
          }
        });
      }
    }
    expect(hits, `emoji in code a screen renders:\n${hits.join('\n')}`).toEqual([]);
  });

  it('is looking at something — the scan itself can go blind', () => {
    // A file list that silently resolves to nothing passes for ever, which is
    // this project's own complaint about an assertion no edit can turn red.
    const files = TREES.flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(40);
    // The exemption has to point at something, or it is a comment.
    expect(files.map((f) => relative(ROOT, f))).toContain(EXEMPT[0]);
    expect(files.some((f) => f.endsWith('render.ts'))).toBe(true);
    expect(EMOJI.test('a thermometer: \u{1F321}')).toBe(true);
    expect(EMOJI.test('a plain sentence — with an em dash, 19.4 °C and "quotes"')).toBe(false);
  });
});
