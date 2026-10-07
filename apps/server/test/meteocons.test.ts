import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';

/**
 * The forecast's Meteocons pictures (plan item M5.9), as files and as a route.
 *
 * The files are someone else's artwork in this repository, so what is held
 * here is what a stranger's SVG could do that nothing else on the wall may:
 * move by itself (MQ7: never SVG's own animation), style itself, run a script,
 * or reach another origin (rule three). And the set is exactly what the
 * display names — a file the wall never asks for is weight in every image, and
 * one it asks for and the image lacks is a gap on every wall.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DIR = join(HERE, '..', 'assets', 'meteocons');
const MIGRATIONS = join(HERE, '..', 'migrations');
const SETS = ['fill', 'line'] as const;

/** The files the display can name, read from its source: the server cannot import the bundle. */
function namedByTheWall(): string[] {
  const source = readFileSync(join(ROOT, 'apps', 'display', 'src', 'weather-icons.ts'), 'utf8');
  const block = (name: string): string[] => {
    // From the literal's opening bracket to its first closing one: a type
    // annotation's own `[]` sits before the `= [`, so it is skipped.
    const open = source.indexOf('= [', source.indexOf(`export const ${name}`));
    const body = source.slice(open, source.indexOf(']', open));
    return [...body.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string);
  };
  return [...block('METEOCON_FILES'), ...block('MOON_PHASES')].sort();
}

describe('the bundled pictures', () => {
  it('are exactly the files the wall names, in both sets', () => {
    const named = namedByTheWall();
    expect(named).toHaveLength(24);
    expect(named).toContain('moon-full');
    for (const set of SETS) {
      const files = readdirSync(join(DIR, set)).map((file) => file.replace(/\.svg$/, '')).sort();
      expect(files, set).toEqual(named);
    }
  });

  it('carry no motion of their own, no style, no script and nothing from another origin', () => {
    const refused: readonly [string, RegExp][] = [
      ['SMIL animation', /<animate|<set\b|<animateTransform|<animateMotion/i],
      ['a stylesheet', /<style|@keyframes|animation|transition/i],
      ['a script', /<script|\bon[a-z]+\s*=|javascript:/i],
      ['another document', /<image\b|<foreignObject|<use\b[^>]*href="(?!#)/i],
      ['another origin', /https?:\/\/(?!www\.w3\.org\/)/i],
    ];
    let checked = 0;
    for (const set of SETS) {
      for (const file of readdirSync(join(DIR, set))) {
        const svg = readFileSync(join(DIR, set, file), 'utf8');
        expect(svg.startsWith('<svg '), `${set}/${file} is an SVG`).toBe(true);
        for (const [what, pattern] of refused) {
          expect(pattern.test(svg), `${set}/${file} carries ${what}`).toBe(false);
        }
        /*
         * One inline style is drawing rather than styling, and ten of these
         * carry it: a mask's `mask-type`, which says how the mask is read and
         * moves nothing. Anything else in a `style` attribute is refused.
         */
        for (const [, value] of svg.matchAll(/style="([^"]*)"/g)) {
          expect(value, `${set}/${file} styles itself`).toMatch(/^mask-type:\s*(alpha|luminance)$/);
        }
        checked++;
      }
    }
    expect(checked).toBe(48);
  });

  it('carry their licence, with the copyright the MIT licence requires', () => {
    const licences = readFileSync(join(DIR, 'LICENSES.md'), 'utf8');
    expect(licences).toContain('Copyright (c) 2020-present Bas Milius');
    expect(licences).toContain('Permission is hereby granted, free of charge');
    expect(readFileSync(join(ROOT, 'NOTICE'), 'utf8')).toContain('apps/server/assets/meteocons/LICENSES.md');
  });
});

describe('the widget setting', () => {
  it('takes the drawn set or either Meteocons set, and refuses anything else', () => {
    for (const icons of ['drawn', 'fill', 'line']) {
      expect(widgetConfigBody.safeParse({ icons }).success, icons).toBe(true);
    }
    for (const icons of ['animated', 'Fill', '', 3]) {
      expect(widgetConfigBody.safeParse({ icons }).success, String(icons)).toBe(false);
    }
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function app() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-meteocons-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'm'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.9.4.1',
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
  });
}

describe('/assets/meteocons/', () => {
  it('serves every picture of both sets as an SVG, cached a day, byte for byte', async () => {
    const served = app();
    for (const set of SETS) {
      for (const name of namedByTheWall()) {
        const res = await served.fetch(new Request(`http://localhost/assets/meteocons/${set}/${name}.svg`));
        expect(res.status, `${set}/${name}`).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml');
        expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
        expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(DIR, set, `${name}.svg`)))).toBe(true);
      }
    }
  });

  it('serves nothing from a set it does not have, nor anything but a picture', async () => {
    const served = app();
    for (const path of [
      'animated/clear-day.svg',
      'fill/LICENSES.md',
      'fill/clear-day.png',
      'fill/..%2Fline%2Fclear-day.svg',
      'fill/.hidden.svg',
      'LICENSES.md/x.svg',
      'fill/not-a-picture.svg',
    ]) {
      const res = await served.fetch(new Request(`http://localhost/assets/meteocons/${path}`));
      expect(res.status, path).toBe(404);
    }
  });
});
