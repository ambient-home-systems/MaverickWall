/**
 * One vocabulary — **Wall / Layout / Widget** — pinned by the sentences a
 * household actually reads.
 *
 * PR #146 retired *display*, *canvas*, *screen* and *block* from user-facing
 * text and made `/admin/walls` canonical. Nothing pinned it, so it drifted:
 * within one file the arrangement was called "arrangement" on the panel page,
 * "this" on the Default wall's status line and "another wall" in the template
 * gallery, while `admin.ts` two thousand lines earlier already said "the
 * Default wall's layout". That is what this file is for. It is the
 * `admin-design-system.test.ts` shape applied to writing rather than to CSS:
 * mostly an assertion about *absences*, because an absence is exactly what
 * somebody reinstates while tidying, and no typecheck has an opinion about it.
 *
 * The reading these assertions enforce is option (b) of the two the sweep
 * considered:
 *
 *   **WALL** is the physical thing on the wall — the device you pair. The
 *   shared arrangement belongs to a wall too: the **Default wall**, which is a
 *   wall with no hardware, and that is its *name*, not a description.
 *   **LAYOUT** is the arrangement of widgets. **WIDGET** is one box in it.
 *
 * So "the Default wall's layout" is right and "the Default layout" is not the
 * scheme this codebase settled on; the noun for the arrangement is *layout*
 * and never *arrangement*, *canvas* or *wall*.
 *
 * Read against a real installation with a real feed, a real paired browser
 * wall, a real e-paper panel and a real pending pairing code, then crawled —
 * a page nobody can reach from `/admin` is a page whose copy nobody proofread,
 * and a hand-written list of paths is a list that goes stale the day a screen
 * is added. Two blind spots are stated rather than papered over: the Home
 * Assistant page renders more once a connection exists (there is no fake HA
 * here), and the layout editor's inspector is drawn client-side, so its own
 * strings are read out of the bundle rather than off a page.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, type Installation } from './browser-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const SLOW = 120_000;

// ---------------------------------------------------------------------------
// Every admin page, as a household reads it
// ---------------------------------------------------------------------------

interface Rendered {
  readonly path: string;
  /** The words on the page: tags, scripts, styles and config blocks removed. */
  readonly text: string;
  /**
   * Text a person reads without it being a text node — a confirmation dialogue,
   * a tooltip, an accessible name, the grey text in an empty field. `admin.ts`
   * writes real sentences into `data-confirm`, and stripping tags would have
   * thrown every one of them away.
   */
  readonly attrs: readonly string[];
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  times: '×',
  deg: '°',
};

/**
 * Decode entities the way a parser does: **one pass, left to right.**
 *
 * That single property is what makes the double-escape assertion below mean
 * anything. `&amp;quot;` is one entity followed by four letters, so it decodes
 * to the *text* `&quot;` and a household reads markup off the page;
 * `&quot;` decodes to a quotation mark and is simply how a quote is written
 * inside an attribute. Decoding `&amp;` in its own `.replace` and then sweeping
 * again would silently repair the first case into the second.
 */
const decode = (raw: string): string =>
  raw.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return NAMED[body.toLowerCase()] ?? whole;
  });

/**
 * The words, with three things taken out.
 *
 * `<pre class="code">` is the sharp one: the e-paper page hands over an ESPHome
 * recipe verbatim, and ESPHome's own key is `display:`. That is somebody else's
 * vocabulary quoted for copy-and-paste, not this product naming an object, and
 * excluding the block is honest where allow-listing eleven lines of YAML would
 * not be.
 */
const textOf = (html: string): string =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<pre class="code">[\s\S]*?<\/pre>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const ATTRS = /(?:data-confirm|title|aria-label|placeholder|alt)="([^"]+)"/g;

let installation: Installation | undefined;
let crawled: readonly Rendered[] | undefined;
/** The crawl, memoised as a *promise* — two tests awaiting it must not install
 *  two households and race over `crawled`. */
let crawling: Promise<readonly Rendered[]> | undefined;

afterAll(async () => {
  await installation?.dispose();
});

/**
 * Crawl `/admin`, following every in-app link and every `GET` form, once.
 *
 * Any HTML answer counts, whatever its status: "That pairing code has expired"
 * is a 404 with a sentence on it, and a crawl that only kept 200s would never
 * proofread a single error page.
 */
function pages(): Promise<readonly Rendered[]> {
  if (crawling === undefined) crawling = crawl();
  return crawling;
}

async function crawl(): Promise<readonly Rendered[]> {
  const home = await install({ feed: true });
  installation = home;

  // Three things the household would have that a bare install does not, so the
  // pages that only exist for them are crawled rather than skipped: a paired
  // browser wall, an e-paper panel, and a wall part-way through pairing.
  await home.pairLink('Kitchen');
  const madePanel = await home.post('/admin/epaper', {
    name: 'Hallway tag',
    preset: 'seeed-7in5',
    rotation: '0',
  });
  expect(madePanel.status, 'the e-paper wall must be created for its pages to be crawled').toBe(200);
  const started = await fetch(`${home.base}/d/pair/device-start`, {
    method: 'POST',
    headers: { origin: home.base },
  });
  const userCode = ((await started.json()) as { userCode?: string }).userCode ?? '';
  expect(userCode, 'a pending pairing code is what makes the approve page reachable').not.toBe('');

  const seen = new Set<string>();
  const queue = ['/admin', `/admin/screens/approve?code=${encodeURIComponent(userCode)}`];
  const out: Rendered[] = [];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);

    const res = await home.call(path);
    if (!(res.headers.get('content-type') ?? '').includes('html')) continue;
    const html = await res.text();

    for (const link of html.matchAll(/(?:href|action)="([^"]*)"/g)) {
      const raw = link[1] as string;
      // Off-site, inline data, the display's own routes and the bundle's assets
      // are not admin copy. Sign-out would end the crawl on its second page.
      if (raw === '' || /^(https?:|data:|mailto:|#|assets\/|\/d\/)/.test(raw)) continue;
      const absolute = (raw.startsWith('/') ? raw : `/${raw}`).split('#')[0] as string;
      if (!absolute.startsWith('/admin') || absolute.includes('sign-out')) continue;
      if (!seen.has(absolute)) queue.push(absolute);
    }

    out.push({
      path,
      text: textOf(html),
      attrs: [...html.matchAll(ATTRS)].map((m) => decode(m[1] as string)),
    });
  }

  crawled = out;
  return out;
}

/** Every sentence on a page, wherever a person reads it from. */
const saidOn = (page: Rendered): readonly string[] => [page.text, ...page.attrs];

/**
 * Every match of `pattern` across every page, minus the phrases on `allowed`.
 *
 * The allow-list is read in **both** directions, which is what stops it being a
 * quiet repeal: a phrase nobody can defend fails as an offender, and a phrase
 * that no longer matches anything fails as a stale entry. So the list can only
 * shrink, and it cannot be padded against a future violation.
 */
function sweep(
  rendered: readonly Rendered[],
  pattern: RegExp,
  allowed: readonly string[],
): { offenders: string[]; stale: string[] } {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const page of rendered) {
    for (const said of saidOn(page)) {
      for (const hit of said.matchAll(pattern)) {
        const at = hit.index ?? 0;
        const phrase = said.slice(Math.max(0, at - 60), at + hit[0].length + 60);
        const excuse = allowed.find((ok) => phrase.includes(ok));
        if (excuse !== undefined) {
          used.add(excuse);
          continue;
        }
        offenders.push(`${page.path}: …${phrase}…`);
      }
    }
  }
  return { offenders, stale: allowed.filter((ok) => !used.has(ok)) };
}

// ---------------------------------------------------------------------------
// 1. The retired nouns
// ---------------------------------------------------------------------------

describe('the admin, read out loud', () => {
  it(
    'reaches the pages this is about',
    async () => {
      // An assertion over an empty crawl is an assertion about nothing, and a
      // crawl that quietly stops at the nav would pass every test below.
      const seen = (await pages()).map((p) => (p.path.split('?')[0] ?? p.path) as string);
      for (const required of [
        '/admin',
        '/admin/walls',
        '/admin/walls/default',
        '/admin/calendars',
        '/admin/epaper',
        '/admin/screens/approve',
        '/admin/system',
      ]) {
        expect(seen, `the crawl never reached ${required}`).toContain(required);
      }
      // The two pages the vocabulary is really about, whose ids are minted.
      expect(
        seen.filter((p) => /^\/admin\/walls\/[0-9a-f]{8,}$/.test(p)).length,
        'a paired wall’s own page',
      ).toBeGreaterThan(0);
      expect(
        seen.filter((p) => /^\/admin\/epaper\/[0-9a-f]{8,}\/design$/.test(p)).length,
        'the e-paper panel’s design page',
      ).toBeGreaterThan(0);
      expect(seen.length, `too few pages to be a sweep: ${seen.length}`).toBeGreaterThan(25);
    },
    SLOW,
  );

  it(
    'calls no object a display, a canvas, a screen or a block',
    async () => {
      /*
       * The four nouns PR #146 retired. They are still everywhere *inside* the
       * product — the `screens` table, `/admin/displays/...` as a route, a
       * `.le-canvas` class — and that is deliberate and out of scope here.
       * This is about what a household reads.
       */
      const RETIRED = /\b(displays?|canvas|canvases|screens?|blocks?)\b/gi;

      /*
       * Legitimate uses, allow-listed by the sentence rather than by weakening
       * the match — the point of the list is that it can only shrink, and that
       * every entry has to be defended by somebody adding it. It is empty: the
       * sweep left nothing behind, and the ESPHome recipe (`display:` is their
       * key, not ours) is excluded structurally by `textOf` rather than by a
       * phrase.
       */
      const ALLOWED: readonly string[] = [];

      const { offenders, stale } = sweep(await pages(), RETIRED, ALLOWED);
      expect(
        offenders,
        `a retired noun is back (allow-list: ${ALLOWED.length} entries):\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale, `allow-list entries that match nothing any more: ${stale.join(', ')}`).toEqual(
        [],
      );
    },
    SLOW,
  );

  // -------------------------------------------------------------------------
  // 2. One noun for the arrangement
  // -------------------------------------------------------------------------

  it(
    'has one word for the arrangement of widgets, and it is “layout”',
    async () => {
      /*
       * "Arrangement" is not a retired noun — it is a *fourth* one, which is
       * worse, because it reads well enough that nobody objects to it. The
       * e-paper page offered "Its own arrangement", "The Default wall's
       * arrangement" and "Kitchen's arrangement" under a `<select>` whose own
       * label was **Layout**.
       */
      const rendered = await pages();
      const { offenders } = sweep(rendered, /\barrangements?\b/gi, []);
      let layouts = 0;
      for (const page of rendered) {
        for (const said of saidOn(page)) layouts += [...said.matchAll(/\blayouts?\b/gi)].length;
      }
      expect(offenders, `a second word for a layout:\n  ${offenders.join('\n  ')}`).toEqual([]);
      // Passing over an admin that never says "layout" would be no guarantee.
      expect(layouts, 'the admin must actually use the word it settled on').toBeGreaterThan(20);
    },
    SLOW,
  );

  it(
    'says “per cent of the layout”, not of the canvas, in the widget inspector',
    async () => {
      /*
       * The one piece of user-facing writing the crawl cannot see: the
       * inspector is built client-side, so its accessible names never appear in
       * any page's HTML. Read out of the bundle's source, the way
       * `epaper-ladder-parity.test.ts` reads two files rather than trusting one.
       */
      const src = join(HERE, '..', '..', 'display', 'src');
      const editor = readFileSync(join(src, 'layout-editor.ts'), 'utf8');
      const labels = [...editor.matchAll(/setAttribute\('aria-label', `([^`]+)`\)/g)].map(
        (m) => m[1] as string,
      );
      expect(labels.length, 'no accessible names found — has the call moved?').toBeGreaterThan(0);

      /*
       * The boxes' own names are composed in `omission.ts` now, not at the
       * `setAttribute` call, so the scan above no longer sees them — and a
       * regular expression that silently stops matching is how a guard passes
       * over the thing it was written for. Every template literal in that
       * module is a sentence a household reads (the flag on a box, the
       * inspector's note, the box's accessible name), so all of them count.
       * Comments go first: their prose is about the canvas, which is one of
       * the retired nouns.
       */
      const omission = readFileSync(join(src, 'omission.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const sentences = [...omission.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
      expect(sentences.length, 'omission.ts composes no sentences — has it moved?').toBeGreaterThan(3);
      labels.push(...sentences);
      for (const label of labels) {
        expect(label, 'a retired noun in an accessible name').not.toMatch(
          /\b(canvas|screen|display|block)\b/i,
        );
      }
    },
    SLOW,
  );

  it(
    'escapes nothing twice, so no page reads its own markup out loud',
    async () => {
      /*
       * Not a vocabulary fault, and found the way all of these were — by
       * reading the pages out loud. The panel page's layout hint was written
       * with an HTML entity for its ampersand, which is right in the raw markup
       * the rest of that function emits and wrong here: `fieldWrap` escapes
       * every hint it is given, so it reached the glass as the five characters
       * "&amp;" and a household read "black &amp; white". Invisible in the
       * source, invisible to a typecheck, and visible only on a rendered page —
       * which is what this file already has thirty-odd of.
       */
      const offenders: string[] = [];
      for (const page of await pages()) {
        for (const said of saidOn(page)) {
          for (const hit of said.matchAll(/&(?:amp|lt|gt|quot|#\d+);/g)) {
            const at = hit.index ?? 0;
            offenders.push(`${page.path}: …${said.slice(Math.max(0, at - 60), at + 60)}…`);
          }
        }
      }
      expect(offenders, `escaped twice, so it reads as markup:\n  ${offenders.join('\n  ')}`).toEqual(
        [],
      );
    },
    SLOW,
  );

  // -------------------------------------------------------------------------
  // 3. The shared default is a wall, and that is its name
  // -------------------------------------------------------------------------

  it(
    'names the shared default “Default wall” wherever it names it',
    async () => {
      /*
       * This is the half of reading (b) that the Walls list got wrong: the card
       * said "Default" and the page it opened was headed "Default wall", so the
       * one object a household meets before they own any hardware had two
       * names. Capital D only — "Household default" and "Shared default" are
       * adjectives about inheritance, not names.
       */
      const ALLOWED: readonly string[] = [
        // The theme editor's three font pickers open on "Default", meaning the
        // theme's own face rather than any wall. Named by the option that
        // follows it, so reordering that list retires the entry rather than
        // quietly widening it.
        'Default Inter',
      ];
      const { offenders, stale } = sweep(await pages(), /\bDefault\b(?! wall)/g, ALLOWED);
      expect(
        offenders,
        `“Default” standing alone as a name (allow-list: ${ALLOWED.length} entries):\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale, `allow-list entries that match nothing any more: ${stale.join(', ')}`).toEqual(
        [],
      );

      // And the name is actually used, rather than the rule passing over a
      // Walls list that has stopped mentioning the shared default at all.
      const list = (await pages()).find((p) => p.path === '/admin/walls');
      expect(list?.text, 'the Walls list must name the Default wall').toContain('Default wall');
    },
    SLOW,
  );

  // -------------------------------------------------------------------------
  // 4. The one place the device's noun is kept, and why
  // -------------------------------------------------------------------------

  it(
    'lets the save bar name what it saves: a wall on a wall’s page, a layout on a panel’s',
    async () => {
      /*
       * The deliberate exception, pinned so that reading it as drift and
       * "fixing" it turns something red. A wall's page saves the layout **and**
       * every settings category in one action (`display-editor.ts` posts the
       * canvas through the editor's bridge, then submits the settings form), so
       * "Save wall" names the object that owns both. The e-paper design page
       * has no settings form beside the canvas — there the same bar saves the
       * layout and nothing else, so it says so.
       */
      await pages();
      const of = (path: string): Rendered =>
        (crawled as readonly Rendered[]).find((p) => p.path === path) as Rendered;

      const walked = (crawled as readonly Rendered[]).map((p) => p.path);
      const paired = walked.find((p) => /^\/admin\/walls\/[0-9a-f]{8,}$/.test(p));
      const design = walked.find((p) => /^\/admin\/epaper\/[0-9a-f]{8,}\/design$/.test(p));
      expect(paired, 'no paired wall page was crawled').toBeDefined();
      expect(design, 'no panel design page was crawled').toBeDefined();

      for (const path of ['/admin/walls/default', paired as string]) {
        expect(of(path).text, `${path} saves the wall`).toContain('Save wall');
        expect(of(path).text, `${path} does not save a layout alone`).not.toContain('Save layout');
      }
      expect(of(design as string).text, 'the panel design page saves the layout').toContain(
        'Save layout',
      );
      expect(
        of(design as string).text,
        'a panel has no settings form beside its layout',
      ).not.toContain('Save wall');
    },
    SLOW,
  );
});
