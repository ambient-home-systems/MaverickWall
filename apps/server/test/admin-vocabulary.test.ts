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
 * is added. One blind spot is stated rather than papered over: the layout
 * editor's inspector is drawn client-side, so its own strings are read out of
 * the bundle rather than off a page. There used to be a second — the Home
 * Assistant screens render more once a connection exists, and there was no
 * fake house here — which P2.2 closed by connecting one, having first read
 * every Home Assistant page in its unconnected branch.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

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
  await closeFakeHomeAssistants();
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

  // Four things the household would have that a bare install does not, so the
  // pages that only exist for them are crawled rather than skipped: a paired
  // browser wall, an e-paper panel, a wall part-way through pairing, and a
  // custom theme.
  //
  // The theme is the newest of the four and it is here because of what it
  // makes reachable rather than because a household would have one: the Edit
  // and Remove controls on a theme card exist only for a custom theme, and the
  // remove *confirmation* is the page that told a household their walls would
  // "switch to Board" for releases after Board stopped existing (RFC 015 §2.1).
  // Without one seeded, that sentence is on no page this crawl can see — which
  // is this file's own stated blind spot, a conditional section, and the
  // reason the retired-name assertions below would otherwise pass over the
  // very fault they were written for.
  const madeWall = await home.post('/admin/screens', { name: 'Kitchen', theme: 'panels' });
  expect(madeWall.status, 'the wall must be created for its pages to be crawled').toBe(303);
  /*
   * Two more walls, both revoked, and the Kitchen one above never paired
   * (RFC 016 phase 1). The Walls list draws three things conditionally — the
   * not-yet-paired card's control, the revoked disclosure, and the two Forget
   * confirmations it leads to, of which "Forget all" needs two revoked walls
   * to be offered at all — and this file's own stated blind spot is a
   * conditional section its harness never seeds. Revoked through the real
   * route rather than a column write, so the row is what a household's is.
   */
  for (const name of ['Old hall', 'Older hall']) {
    const made = await home.post('/admin/screens', { name, theme: 'panels' });
    expect(made.status, `${name} must be created before it can be unpaired`).toBe(303);
    const id = /\/admin\/walls\/([^/]+)\/pair/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
    const revoked = await home.post(`/admin/screens/${id}/revoke`, {});
    expect(revoked.status, `${name} must be unpaired for the disclosure to be crawled`).toBe(302);
  }
  const madePanel = await home.post('/admin/epaper', {
    name: 'Hallway tag',
    preset: 'seeed-7in5',
    rotation: '0',
  });
  expect(madePanel.status, 'the e-paper wall must be created for its pages to be crawled').toBe(303);
  // Where each POST redirects to: the page that shows the link or URL once.
  // Nothing links to these, so they are queued by hand — and crawled twice,
  // because the second visit is a different page (the "already shown" one)
  // with sentences of its own to proofread.
  const shownOnce = [madeWall, madePanel].map((made) => made.headers.get('location') ?? '');
  expect(shownOnce.every((path) => path.startsWith('/admin/'))).toBe(true);
  /*
   * A second, disposable panel, removed immediately — the only way the
   * confirmation strip's "e-paper wall removed." (P1.5's first occurrence of
   * "eInk") is ever shown, and the crawl otherwise never removes anything.
   * `Hallway tag` above is untouched, so the panel the save-bar assertion
   * below reads from still has its own layout rather than nothing to crawl.
   */
  const madeSpare = await home.post('/admin/epaper', {
    name: 'Spare panel',
    preset: 'seeed-7in5',
    rotation: '0',
  });
  const spareId = /\/admin\/epaper\/([^/]+)\/url/.exec(madeSpare.headers.get('location') ?? '')?.[1];
  expect(spareId, 'the spare panel must exist to be removed').not.toBeUndefined();
  const removed = await home.post(`/admin/epaper/${spareId ?? ''}/revoke`, {});
  expect(removed.status, 'the spare panel must actually be removed for its confirmation to be crawled').toBe(
    302,
  );
  const removedPath = removed.headers.get('location') ?? '';
  expect(removedPath, 'the removal must land on a page carrying the confirmation').toContain(
    'saved=epaper-screen-removed',
  );
  /*
   * A CalDAV account, written straight into the database rather than added
   * through its own form (RFC 013 §6.2.1).
   *
   * The section that draws it is conditional — no accounts, no section — so
   * without this the copy on it is never proofread by this crawl, which is the
   * same blind spot this file already states for the Home Assistant page. It is
   * seeded rather than added because adding one means a live CalDAV server, and
   * what is under test here is the *sentences*, not the discovery.
   *
   * A calendar hangs off it, and a failing one, because the account card says
   * different things in each state and only a card with both can proofread
   * both.
   */
  const stamp = home.now();
  home.db
    .prepare(
      `INSERT INTO caldav_accounts
         (id, server_url_encrypted, server_host, username, password_encrypted,
          principal_url, home_set_url, confirmed_host, created_at, updated_at)
       VALUES ('vocab-acct', 'mw1:sealed', 'caldav.icloud.example', 'jane@icloud.example',
               'mw1:sealed', '/principals/jane/', '/calendars/jane/',
               'p42-caldav.icloud.example', ?, ?)`,
    )
    .run(stamp, stamp);
  home.db
    .prepare(
      `INSERT INTO calendar_sources
         (id, name, kind, caldav_account_id, url_encrypted, color, last_error, created_at, updated_at)
       VALUES ('vocab-cal', 'Home', 'caldav', 'vocab-acct', 'mw1:sealed', '#AA3311', NULL, ?, ?)`,
    )
    .run(stamp, stamp);

  const madeTheme = await home.post('/admin/themes', {
    name: 'Sea glass',
    '--bg': '#101418',
    '--panel': '#1b2028',
    '--rule': '#2a333f',
    '--ink': '#e9eef4',
    '--muted': '#9ba7b4',
    '--faint': '#68727e',
    '--accent': '#e0a33e',
    '--s-day': '#e0a33e',
    '--s-night': '#4c7fd1',
    '--s-break': '#35916a',
    '--s-straight': '#6b7684',
    radius: '0.4rem',
  });
  expect(madeTheme.status, 'the theme must be created for its own pages to be crawled').toBe(302);
  /*
   * And the wall wears it, because the confirmation has two branches and only
   * one of them names a theme: an unused theme's removal reads "Nothing is
   * using it right now." A theme nobody is wearing makes that page reachable
   * and its sentence invisible, which is a crawl that looks like it covers the
   * fault and does not.
   */
  const themeId = (
    home.db.prepare('SELECT id FROM themes LIMIT 1').get() as { id: string } | undefined
  )?.id;
  expect(themeId, 'the theme must be stored for a wall to wear it').not.toBeUndefined();
  const wallId = /\/admin\/walls\/([^/]+)\/pair/.exec(madeWall.headers.get('location') ?? '')?.[1];
  expect(wallId, 'the wall must exist for it to wear the theme').not.toBeUndefined();
  const worn = await home.post(`/admin/screens/${wallId ?? ''}`, {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: `custom:${themeId ?? ''}`,
  });
  expect(worn.status, 'the wall must actually be wearing the theme').toBe(302);

  const started = await fetch(`${home.base}/d/pair/device-start`, {
    method: 'POST',
    headers: { origin: home.base },
  });
  const userCode = ((await started.json()) as { userCode?: string }).userCode ?? '';
  expect(userCode, 'a pending pairing code is what makes the approve page reachable').not.toBe('');

  /*
   * P2.1's add pages each have a branch a household meets only before anybody
   * is in the house — step one of a rotation says "add someone first" instead
   * of drawing its form — and People and Chores draw an empty state then and
   * cards after. Those are read here, before one person is added, and then the
   * crawl below reads the other branch: a crawl of an empty household would
   * never have seen the rotation form at all, and one of a full household
   * never the sentence that stands in for it.
   */
  const beforeAnybody: Rendered[] = [];
  for (const path of ['/admin/shifts/new', '/admin/people', '/admin/chores', '/admin/shifts']) {
    const html = await (await home.call(path)).text();
    beforeAnybody.push({
      path: `${path}#before-anybody`,
      text: textOf(html),
      attrs: [...html.matchAll(ATTRS)].map((m) => decode(m[1] as string)),
    });
  }
  const person = await home.post('/admin/people', { name: 'Sam', color: '#4C7FD1' });
  expect(person.status, 'a person makes the rotation form drawable').toBe(302);

  /*
   * A real fake house, so the Home Assistant add pages P2.1 made draw their
   * forms (P2.2's brief: the crawl must reach every new add page, conditional
   * sections included). Before it, this file's header named the Home
   * Assistant screens as a blind spot — "there is no fake HA here" — and every
   * one of the four add pages would have been read only in its "not connected
   * yet" branch, the one branch with no form on it. The unconnected branch of
   * each of the nine pages is read first, as the empty household's pages are
   * above, so connecting does not trade one blind spot for the other.
   */
  for (const path of [
    '/admin/home-assistant',
    '/admin/home-assistant/connection',
    '/admin/home-assistant/readings',
    '/admin/home-assistant/readings/new',
    '/admin/home-assistant/calendars',
    '/admin/home-assistant/calendars/new',
    '/admin/home-assistant/lists',
    '/admin/home-assistant/lists/new',
    '/admin/home-assistant/alerts',
    '/admin/home-assistant/alerts/new',
  ]) {
    const html = await (await home.call(path)).text();
    beforeAnybody.push({
      path: `${path}#before-connecting`,
      text: textOf(html),
      attrs: [...html.matchAll(ATTRS)].map((m) => decode(m[1] as string)),
    });
  }
  const house = await fakeHomeAssistant();
  const connected = await home.post('/admin/home-assistant/connect', {
    base_url: house.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
  expect(connected.status, 'the fake house must connect for the add forms to be drawn').toBe(302);

  const seen = new Set<string>();
  const queue = [
    '/admin',
    `/admin/screens/approve?code=${encodeURIComponent(userCode)}`,
    ...shownOnce,
    ...shownOnce,
    removedPath,
  ];
  const out: Rendered[] = [...beforeAnybody];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    // A once-only page is visited exactly twice — the showing, then the page
    // that says it has been shown — and `seen` would otherwise stop at one.
    const revisit = shownOnce.includes(path) && seen.has(path) && !seen.has(`${path}#again`);
    if (seen.has(path) && !revisit) continue;
    seen.add(revisit ? `${path}#again` : path);

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
        '/admin/walls/new',
        // The two add pages behind the Walls chooser (P2.2). `/admin/epaper`
        // is a redirect to the second now, so it is not a page this reads.
        '/admin/walls/new/browser',
        '/admin/walls/new/epaper',
        '/admin/calendars',
        '/admin/screens/approve',
        '/admin/system',
        /*
         * The Home Assistant hub and all five of its children (RFC 014 §8).
         *
         * This is the crawler's own path list rather than a new sweep, and it
         * is the assertion that the hub's five rows are drawn on a household
         * that has never connected — this fixture never connects one, so a row
         * gated on `connected` would leave all five routes with nothing
         * linking to them and the sweep would quietly cover five fewer screens
         * than it thinks it does. A test getting weaker with nothing failing.
         */
        '/admin/home-assistant',
        '/admin/home-assistant/connection',
        '/admin/home-assistant/readings',
        '/admin/home-assistant/calendars',
        '/admin/home-assistant/lists',
        '/admin/home-assistant/alerts',
        // And the four add pages behind them (P2.1), with a house connected so
        // each one draws its form rather than "not connected yet".
        '/admin/home-assistant/readings/new',
        '/admin/home-assistant/calendars/new',
        '/admin/home-assistant/lists/new',
        '/admin/home-assistant/alerts/new',
        // The gallery, and the builder behind it. Both carry theme names.
        '/admin/themes',
        '/admin/themes/new',
        /*
         * Every add page P2.1 made, each reached the only way a household
         * reaches it: from its list's app-bar "Add …", and for calendars from
         * the chooser behind that. None is linked from the navigation, so a
         * list that lost its action would take its add page out of this sweep
         * silently — which is why they are named.
         */
        '/admin/calendars/new',
        '/admin/calendars/new/address',
        '/admin/calendars/new/caldav',
        '/admin/people/new',
        '/admin/shifts/new',
        '/admin/shifts/types',
        '/admin/shifts/types/new',
        '/admin/chores/new',
      ]) {
        expect(seen, `the crawl never reached ${required}`).toContain(required);
      }
      // The two pages the vocabulary is really about, whose ids are minted.
      expect(
        seen.filter((p) => /^\/admin\/walls\/[0-9a-f]{8,}$/.test(p)).length,
        'a paired wall’s own page',
      ).toBeGreaterThan(0);
      // And the wall's Custom CSS page (RFC 014 §7), reached through the
      // Advanced category — a page with a field per widget and a sentence
      // about panels on it, which is exactly the kind of copy this sweeps.
      expect(
        seen.filter((p) => /^\/admin\/walls\/[0-9a-f]{8,}\/css$/.test(p)).length,
        'a paired wall’s Custom CSS page',
      ).toBeGreaterThan(0);
      expect(
        seen.filter((p) => /^\/admin\/epaper\/[0-9a-f]{8,}\/design$/.test(p)).length,
        'the e-paper panel’s design page',
      ).toBeGreaterThan(0);
      /*
       * The two Forget confirmations (RFC 016 phase 1), reachable only from
       * the revoked disclosure on the Walls list — which draws only with a
       * revoked wall seeded, and offers "Forget all" only with two.
       */
      expect(
        seen.filter((p) => /^\/admin\/screens\/[0-9a-f]{8,}\/forget$/.test(p)).length,
        'a revoked wall’s Forget confirmation',
      ).toBeGreaterThan(0);
      expect(seen, 'the Forget-all confirmation').toContain('/admin/screens/forget-revoked');
      /*
       * And the remove-a-theme confirmation, which is the page that named a
       * theme nobody could choose. It is reachable only from a custom theme's
       * own card, so this is the assertion that the seeded theme is still
       * doing its job — without it the retired-name sweep below would go on
       * passing over a sentence it can no longer see.
       */
      expect(
        seen.filter((p) => /^\/admin\/themes\/[0-9a-f]{8,}\/delete$/.test(p)).length,
        'the remove-a-theme confirmation',
      ).toBeGreaterThan(0);
      /*
       * And the add pages were read in their connected branch, with a form on
       * each — the conditional section connecting a house exists to reach. A
       * crawl whose house quietly failed to connect would still "reach" all
       * four, on the page that says "not connected yet".
       */
      const rendered = await pages();
      for (const [path, form] of [
        // Not "Add reading", which the page's own heading ("Add readings")
        // contains whether a form is drawn or not.
        ['/admin/home-assistant/readings/new', 'Show it as'],
        ['/admin/home-assistant/calendars/new', 'Add calendar'],
        ['/admin/home-assistant/lists/new', 'Show this list'],
        ['/admin/home-assistant/alerts/new', 'Add rule'],
      ] as const) {
        const read = rendered.find((p) => p.path === path);
        expect(read?.text, `${path} was read with its form drawn`).toContain(form);
        expect(read?.text).not.toContain('Home Assistant is not connected yet.');
      }
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

  it(
    'names no theme that no longer exists',
    async () => {
      /*
       * Board, Kitchen Slate and Glance are every member of
       * `LEGACY_THEME_ALIASES`, all three folding onto Panels. The live set is
       * `THEMES` and it is five: Panels, Household, Blueprint, Paper Almanac,
       * Swiss.
       *
       * They survived on served pages for releases, and in four places, which
       * is the argument for a sweep rather than a fix: `/admin/themes` named
       * four built-in directions of which three were retired and omitted three
       * that ship, the delete confirmation told a household their walls would
       * "switch to Board", and it had propagated into CLAUDE.md and back out
       * again (RFC 015 §2.1). A retired *name* is worse than a retired noun,
       * because it is a thing a household can go looking for and not find.
       *
       * Case-sensitive on purpose: the admin legitimately says "at a glance"
       * and an ESPHome recipe legitimately says `board: esp32dev`. It is the
       * proper nouns that are retired, not the words.
       */
      const DEAD_THEMES = /\b(Board|Kitchen Slate|Slate|Glance)\b/g;

      /*
       * One entry, defended: **Chore Board** is a shipped wall template and the
       * board is the thing on the wall. Allow-listed by the sentence rather
       * than by weakening the match, and read in both directions — the day no
       * template is called that, this entry fails as stale.
       */
      const ALLOWED: readonly string[] = ['Chore Board'];

      const { offenders, stale } = sweep(await pages(), DEAD_THEMES, ALLOWED);
      expect(
        offenders,
        `a theme that no longer exists is named on a page:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale, `allow-list entries that match nothing any more: ${stale.join(', ')}`).toEqual(
        [],
      );
    },
    SLOW,
  );

  it(
    'says “e-paper”, never “eInk”',
    async () => {
      /*
       * P1.5: the owner saw "Add an eInk panel" while the rest of the build
       * already said "e-paper" — a saved-message string, an image's alt text
       * and a Home Assistant sentence still had the old spelling. Case
       * sensitive, because "eInk" is a specific misspelling rather than a
       * word: the product's own noun is always "e-paper".
       *
       * Zero allow-list, deliberately: the ESPHome recipe's own
       * `name: eInk source` line is a device-config identifier rather than
       * copy, and `textOf` already excludes `<pre class="code">` blocks
       * structurally, so it never reaches this sweep in the first place.
       */
      const { offenders, stale } = sweep(await pages(), /\beInk\b/g, []);
      expect(
        offenders,
        `"eInk" survives where a household reads it:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale, `allow-list entries that match nothing any more: ${stale.join(', ')}`).toEqual(
        [],
      );
    },
    SLOW,
  );

  it(
    'adds a wall, of either kind, and pairs only a browser',
    async () => {
      /*
       * P2.2. The two doors on the Walls list were "Pair a browser wall" and
       * "Add an e-paper panel" — the verb and the noun both differed for one
       * act — over pages headed "Pair a new wall" and "Add an e-paper wall",
       * and the Overview asked a household to "pair" an e-paper panel, which
       * nothing ever pairs. The act is "Add a wall" everywhere now, and "Pair"
       * is kept for the step that pairs a browser: the QR and the link, and
       * the pairing code a wall shows. These are the retired phrasings, with
       * a zero allow-list, the way "eInk" is.
       */
      const RETIRED = /\b(Pair a (?:new |browser )?wall|Pair a tablet|Add an e-paper panel|No walls paired yet)\b/g;
      const { offenders, stale } = sweep(await pages(), RETIRED, []);
      expect(
        offenders,
        `a retired way of saying "add a wall" is back:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale).toEqual([]);
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
      /*
       * And the two modules RFC 014 §5.1 gave sentences of their own: a
       * group's name is composed in `widget-labels.ts` ("Group of 3: …"), and
       * the inspector's note for a child of a row, the multi-selection's
       * title and what Remove takes with a group are `inspector.ts`'s. Both
       * are read the same way — every template literal, comments first — and
       * the editor's own strings for the new toolbar buttons and the group's
       * controls are held to the same words below.
       */
      for (const file of ['widget-labels.ts', 'inspector.ts']) {
        const source = readFileSync(join(src, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        const own = [...source.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
        expect(own.length, `${file} composes no sentences — has it moved?`).toBeGreaterThan(0);
        labels.push(...own);
      }
      const editorStrings = [
        ...editor.matchAll(/(?:textContent|title|placeholder) = '([^']+)'/g),
      ].map((m) => m[1] as string);
      expect(editorStrings.some((one) => one.startsWith('Put the selected widgets')), 'the Group button’s words are not where this looks').toBe(true);
      labels.push(...editorStrings);
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
    'does not name a shared default, because there is not one any more',
    async () => {
      /*
       * This used to pin the *name*: the Walls list said "Default" on a card
       * whose page was headed "Default wall", so the one object a household met
       * before they owned any hardware had two names. The object is retired —
       * it was never a display, and a card for it counted a wall no household
       * has — so the rule inverts: "Default" may still appear as an adjective
       * about inheritance ("Household default"), and must not appear as the
       * name of a wall.
       *
       * Capital D standing alone is still what the sweep looks for, and the
       * allow-list is what says which adjectives are legitimate.
       */
      const ALLOWED: readonly string[] = [
        // The theme editor's two font pickers open on "Default", meaning the
        // theme's own face rather than any wall. Named by the option that
        // follows it, so reordering that list retires the entry rather than
        // quietly widening it.
        'Default Roboto Flex',
      ];
      const { offenders, stale } = sweep(await pages(), /\bDefault\b(?! wall)/g, ALLOWED);
      expect(
        offenders,
        `“Default” standing alone as a name (allow-list: ${ALLOWED.length} entries):\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
      expect(stale, `allow-list entries that match nothing any more: ${stale.join(', ')}`).toEqual(
        [],
      );

      // And the retired object is genuinely gone from the one page that used to
      // lead with it, rather than merely renamed somewhere.
      const list = (await pages()).find((p) => p.path === '/admin/walls');
      expect(list?.text, 'the Walls list still names a Default wall').not.toContain('Default wall');
      expect(list?.text, 'the Walls list still links the retired default').not.toContain(
        'admin/walls/default',
      );
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

      for (const path of [paired as string]) {
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
