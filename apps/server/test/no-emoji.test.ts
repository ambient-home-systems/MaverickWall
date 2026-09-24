import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No emoji in anything an e-paper panel renders — the scan, because the rule
 * is not self-enforcing.
 *
 * This used to scan the whole display bundle, the admin and every module:
 * before D6 (2026-09-24), an emoji anywhere a screen rendered broke rule
 * three, because the image ships no emoji font and an emoji set as text is a
 * third-party asset resolved on the device. D6 narrows that to the panel. A
 * browser wall now draws emoji from the curated, bundled Twemoji set under
 * `apps/server/assets/emoji/` (`apps/display/src/emoji.ts`, plan item P4.2) —
 * same-origin, the same picture on every screen, never a code point handed to
 * a device's own font. That is a rendering property, proved by
 * `browser-emoji.test.ts`, not a source-text ban: this file is no longer the
 * right place to enforce it.
 *
 * An e-paper panel is the one place the original bug still applies exactly as
 * written: its font covers ASCII only, `asciiTitle` deletes every code point
 * above 0x7E, and there is no bundled artwork for a 1-bit screen to draw
 * instead — D3 explicitly *defers* drawn black-and-white occasion motifs for
 * e-paper rather than shipping them now. So a forecast icon set as an emoji
 * character still vanishes on a panel today, which is what this scan keeps
 * catching.
 *
 * **Comments are scanned too, deliberately.** A comment is where the next one
 * gets pasted from — the `⌂` in a `display_mode` label was a fixture nobody had
 * looked at in a year — and a rule with an exemption for "it is only a comment"
 * is a rule that is one copy-and-paste from being broken in earnest.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const TREES = [
  // The e-paper renderer itself.
  'apps/server/src/epaper',
];

/**
 * Its own tests, matched by the `epaper-` prefix this project's file names
 * already use for every one of them — the fixture-blindness fault ("browser-
 * harness, browser-empty-bands and epaper-weather-widget all seeded a
 * forecast whose icon was a character") is exactly as live for the panel's
 * own tests as it ever was, so they are still in scope.
 */
function epaperTestFiles(): string[] {
  const dir = join(ROOT, 'apps/server/test');
  return readdirSync(dir)
    .filter((name) => name.startsWith('epaper-') && name.endsWith('.test.ts'))
    .map((name) => join('apps/server/test', name));
}

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

describe('no emoji reaches an e-paper panel', () => {
  it('scans the panel rasteriser and its own tests', () => {
    const hits: string[] = [];
    const files = [...TREES.flatMap(filesUnder), ...epaperTestFiles().map((p) => join(ROOT, p))];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        const found = line.match(new RegExp(EMOJI, 'gu'));
        if (found !== null) {
          hits.push(`${relative(ROOT, file)}:${index + 1}  ${found.join(' ')}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    expect(hits, `emoji in code an e-paper panel renders:\n${hits.join('\n')}`).toEqual([]);
  });

  it('is looking at something — the scan itself can go blind', () => {
    // A file list that silently resolves to nothing passes for ever, which is
    // this project's own complaint about an assertion no edit can turn red.
    const files = [...TREES.flatMap(filesUnder), ...epaperTestFiles().map((p) => join(ROOT, p))];
    expect(files.length).toBeGreaterThan(15);
    expect(epaperTestFiles().length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('render.ts'))).toBe(true);
    expect(EMOJI.test('a thermometer: \u{1F321}')).toBe(true);
    expect(EMOJI.test('a plain sentence — with an em dash, 19.4 °C and "quotes"')).toBe(false);
  });

  it('asciiTitle is still the panel\'s own guard against a device font', () => {
    // Not this scan's job any more to prove it draws nothing — the panel
    // never receives an emoji key at all (no widget honours one), so the
    // belt is asciiTitle deleting anything outside 0x00-0x7E should a stray
    // code point ever reach a title string. Read the function rather than a
    // magic number: this is the one place that number is allowed to live.
    const source = readFileSync(join(ROOT, 'apps/server/src/epaper/render.ts'), 'utf8');
    expect(source).toContain('function asciiTitle');
    expect(source).toMatch(/0x7E/);
  });
});
