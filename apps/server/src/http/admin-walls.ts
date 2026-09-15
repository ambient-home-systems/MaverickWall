import type { Context, Hono } from 'hono';

import {
  deleteRevokedScreens,
  deleteScreen,
  readAdminScreens,
  type AdminScreenRow,
} from '../api/queries.js';
import { navModules, type AdminDeps } from './admin.js';
import { card, destructive, emptyState, listRow, tag } from './components.js';
import { confirmDestroyPage, errorBlock, escapeHtml, icon, page } from './html.js';
import { ago, presence, presenceDot, type Presence } from './presence.js';
import { readSaved, savedRedirect } from './saved.js';
import { selfHref } from './self.js';

/**
 * The Walls list (RFC 016 phase 1).
 *
 * Its own file rather than more of `admin.ts`, on the precedent `admin-ha.ts`
 * and `admin-epaper.ts` set when their parent grew past reading: one
 * `admin-<screen>.ts` exporting `register<Screen>Routes(app, deps)`, called
 * from `registerAdminRoutes` at the point in the order those routes belong.
 *
 * A household comes here to do two things — add a wall, and check a wall is
 * alive — and the page used to do both worst. Both doors were `<a class="link">`
 * inside a `<p class="hint">` under every card; five of six status lines read
 * "Last seen never", which was one sentence for a link nobody had opened and a
 * wall that drew once and stopped; the largest number on the page (the revoked
 * count) was prose with nothing to press; and the rarest action, approving a
 * device-flow code, carried the most structure. So:
 *
 *  - the two doors are buttons in an action row under the app bar, with the
 *    approve form demoted to a ghost link beside them (§3.1, §2.4);
 *  - every card reads `presence()` and nothing else for its state, and a card
 *    for a wall nothing has ever used carries the one thing to do about it,
 *    per kind — **Pair it** for a browser wall, **Set up the device** for a
 *    panel — as a link to the page where that act lives (§3.3);
 *  - one quiet summary line above the grid is that same function *counted*,
 *    on two walls or more (§3.4);
 *  - the revoked walls are a closed `<details>` under the grid, each with a
 *    Forget behind a confirmation, and one Forget all (§3.5).
 *
 * `displaysPage` is exported as well as registered, because two handlers that
 * stay in `admin.ts` — the settings save and the token regenerate — answer a
 * refusal by re-drawing this list with the reason on it.
 */

/**
 * One card for every wall on the list, whatever it is (RFC 009 Phase 4).
 *
 * The list used to draw three shapes: the Default wall as a link, a browser
 * wall as a link with a status dot in its head, and an e-paper panel as a
 * static card carrying a ⋮ and an "Arrange layout" button — because a panel
 * had no page of its own to open, so its card had to be that page. It has
 * one now: its layout page, which carries the recipes link and Remove the
 * card used to (and which `/admin/walls/:id` sends a panel to). So every
 * card is the same object — a name, a kind tag, one status line, and either
 * "Open" or the one thing to do about a wall nothing has used — and the grid
 * composes, which three heights and three affordances never did.
 *
 * **The card is not a bare `<a>` any more (RFC 016 §5.1).** A control inside a
 * link is invalid HTML and an element the keyboard cannot reach, so the card
 * adopts `listRow`'s anatomy: a positioned `.card`, the name's own link
 * stretched over it by `::after`, and the trailing control painting over that
 * unaided because `button,.btn` in the sheet is already `position:relative`.
 * `browser-walls-list.test.ts` taps the control and reads back what is under
 * the finger, which is what holds that coupling.
 *
 * The tone is the presence state's: a not-yet-paired card takes `warn`, which
 * moves the edge to the hue and leaves the ground alone, exactly as `card()`
 * documents. Not a tinted card — a card is a 400px region and the soft grounds
 * are sized for a chip.
 *
 * `status` is already-escaped markup.
 */
function wallCard(
  href: string,
  name: string,
  kind: string,
  status: string,
  p: Presence,
  trail: string,
): string {
  return card(
    `<div class="wall-head">` +
      `<div class="wall-head-main">` +
      `<div class="rname"><a class="wall-link" href="${href}">${escapeHtml(name)}</a>` +
      ` ${tag(kind)}` +
      `</div>` +
      `<div class="sub">${status}</div></div>` +
      trail +
      `</div>`,
    { tone: p.state === 'unpaired' ? 'warn' : 'neutral', className: 'wall-card' },
  );
}

/** The card-go "Open", for a wall that has drawn: decoration inside the card, never a control. */
const openGo = `<span class="card-go">Open <span aria-hidden="true">${icon('chev')}</span></span>`;

/**
 * "● Drawing now", "● Not paired yet", "● Not seen recently · last seen 3 days
 * ago from 10.0.0.4" — `presence`'s words, per kind.
 *
 * It said "Last seen never" for a wall nothing had ever used, which on a
 * household with five new walls was the whole second line of five cards, and
 * the same sentence for a link nobody opened and a wall that drew once and
 * stopped. The window is the kind's, from the same function the wall's own
 * page reads.
 */
function seenLine(p: Presence): string {
  return presenceDot(p) + escapeHtml(p.headline) + (p.detail === '' ? '' : ` · ${escapeHtml(p.detail)}`);
}

/**
 * The one trailing control a card may carry, and only a not-yet-paired card
 * carries it (RFC 016 §3.3, §5.1).
 *
 * A link, not a button, and to the page where the act actually lives. A
 * pairing link is shown once and never kept, so the list cannot re-show it;
 * what a household can do for a browser wall nothing has used is on the wall's
 * own page. A panel is never paired at all — its frame URL and the two device
 * recipes are on `/admin/epaper/:id` — so its control names that.
 */
function unpairedControl(screen: AdminScreenRow): string {
  const id = encodeURIComponent(screen.id);
  return screen.kind === 'epaper'
    ? `<a class="btn btn-ghost btn-sm" href="admin/epaper/${id}">Set up the device</a>`
    : `<a class="btn btn-ghost btn-sm" href="admin/walls/${id}">Pair it</a>`;
}

/** A browser wall: its page holds status, pairing, settings and layout together. */
function displayListCard(screen: AdminScreenRow, p: Presence): string {
  return wallCard(
    `admin/walls/${encodeURIComponent(screen.id)}`,
    screen.name,
    'Browser',
    seenLine(p) + (screen.appVersion === null ? '' : ` · ${escapeHtml(screen.appVersion)}`),
    p,
    p.state === 'unpaired' ? unpairedControl(screen) : openGo,
  );
}

/**
 * An e-paper panel: the same card, opening its layout page directly (the
 * `/admin/walls/:id` route would only redirect there, and a crawl of the
 * admin's own links should reach the page without a hop). The panel's
 * geometry stays on the status line because it is the one fact that tells
 * two panels apart, where two browser walls are told apart by their names.
 */
function epaperListCard(screen: AdminScreenRow, p: Presence): string {
  return wallCard(
    `admin/epaper/${encodeURIComponent(screen.id)}/design`,
    screen.name,
    'E-paper',
    seenLine(p) +
      ` · ${screen.panelWidth ?? '?'}×${screen.panelHeight ?? '?'}` +
      (screen.rotation === 0 ? '' : ` · rotated ${screen.rotation}°`) +
      (screen.lanOnly === 1 ? ' · LAN only' : ''),
    p,
    p.state === 'unpaired' ? unpairedControl(screen) : openGo,
  );
}

/**
 * The summary line: `presence()` counted, and nothing else (RFC 016 §3.4).
 *
 * Each card's state and this line's tallies come from one call per wall, so
 * the line cannot disagree with the cards under it — which is the honest form
 * of "no second definition of alive": there were four, and they all read one
 * module now. The words follow the cards' per-kind wording, because a panel
 * and a browser wall are not in the same position: a fresh browser wall is
 * drawing, a fresh panel has *asked* within the hour and is asleep the rest
 * of it; a browser wall is not yet paired, a panel is waiting for a device.
 *
 * The stale tally names the silence when there is one wall in it ("not seen
 * for 30 days") and the shared headline when there are several, because one
 * figure cannot be true of two walls.
 *
 * Empty below two walls: one wall's summary is its own card, and no walls is
 * the empty state.
 */
export function wallSummary(walls: readonly { screen: AdminScreenRow; p: Presence }[], at: number): string {
  if (walls.length < 2) return '';
  const count = (test: (w: { screen: AdminScreenRow; p: Presence }) => boolean): number =>
    walls.filter(test).length;
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts: { dot: 'ok' | 'idle'; words: string }[] = [];

  const freshWalls = count((w) => w.p.state === 'fresh' && w.screen.kind !== 'epaper');
  const freshPanels = count((w) => w.p.state === 'fresh' && w.screen.kind === 'epaper');
  const unpairedWalls = count((w) => w.p.state === 'unpaired' && w.screen.kind !== 'epaper');
  const unpairedPanels = count((w) => w.p.state === 'unpaired' && w.screen.kind === 'epaper');
  const stale = walls.filter((w) => w.p.state === 'stale');

  if (freshWalls > 0) parts.push({ dot: 'ok', words: `${plural(freshWalls, 'wall', 'walls')} drawing now` });
  if (freshPanels > 0) {
    parts.push({ dot: 'ok', words: `${plural(freshPanels, 'panel', 'panels')} checked in within the hour` });
  }
  if (unpairedWalls > 0) parts.push({ dot: 'idle', words: `${unpairedWalls} not paired yet` });
  if (unpairedPanels > 0) {
    parts.push({
      dot: 'idle',
      words: `${plural(unpairedPanels, 'panel waiting for its device', 'panels waiting for their devices')}`,
    });
  }
  if (stale.length === 1) {
    const silence = ago(stale[0]?.screen.lastSeenAt ?? null, at).replace(/ ago$/, '');
    parts.push({ dot: 'idle', words: `1 not seen for ${silence}` });
  } else if (stale.length > 1) {
    parts.push({ dot: 'idle', words: `${stale.length} not seen recently` });
  }

  const dot = (which: 'ok' | 'idle'): string =>
    which === 'ok' ? `<span class="dot dot-ok"></span>` : `<span class="dot dot-idle"></span>`;
  return (
    `<p class="wall-summary">` +
    parts.map((part) => `<span>${dot(part.dot)}${escapeHtml(part.words)}</span>`).join('<span aria-hidden="true">·</span>') +
    `</p>`
  );
}

/**
 * The revoked walls, folded away (RFC 016 §3.5).
 *
 * A `<details>` — the script-free idiom `/admin/chores` uses for its editor —
 * closed by default, so the page is unchanged for a household with none. It
 * used to be "18 unpaired walls kept for the record" in prose, three times as
 * many walls reported as shown, with nothing to click: no way to see which was
 * which or to clear them out.
 *
 * Each row's Forget and the Forget all under them are `destructive()`: a GET
 * to a confirmation that names what goes, never a one-click POST. Forgetting
 * is the first hard delete of a screen this application makes, and
 * `deleteScreen` says what it sweeps.
 */
function revokedDisclosure(revoked: readonly AdminScreenRow[], at: number): string {
  if (revoked.length === 0) return '';
  const n = revoked.length;
  const rows = revoked
    .map((screen) =>
      listRow(
        '',
        {
          title: screen.name,
          detail: `${screen.kind === 'epaper' ? 'E-paper' : 'Browser'} · unpaired ${ago(screen.revokedAt, at)}`,
        },
        destructive('Forget', {
          thing: screen.name,
          confirmAction: `admin/screens/${encodeURIComponent(screen.id)}/forget`,
          variant: 'button',
        }),
      ),
    )
    .join('');
  return (
    `<details class="disclose wall-revoked">` +
    `<summary>${n} unpaired wall${n === 1 ? '' : 's'} kept for the record</summary>` +
    `<p class="hint">Their tokens no longer work. Forgetting one deletes its layout as well, ` +
    `and a panel that was following it goes back to its built-in view.</p>` +
    rows +
    (n < 2
      ? ''
      : destructive('Forget all', {
          thing: 'unpaired walls',
          confirmAction: 'admin/screens/forget-revoked',
          variant: 'button',
        })) +
    `</details>`
  );
}

/**
 * The Walls list: every paired wall, browser and e-paper alike — one list,
 * one nav item, one card shape, with a kind chip on each card rather than two
 * nav entries for one kind of object (RFC 009 Phase 4). Every card opens its
 * wall's own page.
 */
export function displaysPage(c: Context, deps: AdminDeps, error?: string): string {
  const now = deps.now ?? ((): number => Date.now());
  const at = now();
  const all = readAdminScreens(deps.db);
  const active = all.filter((screen) => screen.revokedAt === null);
  const revoked = all.filter((screen) => screen.revokedAt !== null);

  // One reading per wall, shared by its card and by the summary line.
  const walls = active.map((screen) => ({ screen, p: presence(screen, at) }));
  const cardFor = (w: { screen: AdminScreenRow; p: Presence }): string =>
    w.screen.kind === 'epaper' ? epaperListCard(w.screen, w.p) : displayListCard(w.screen, w.p);

  /*
   * The two doors, and the rare third, as buttons (RFC 016 §3.1). Filled,
   * tonal and ghost are the three emphases the sheet already declares; every
   * anchor wears `.btn` beside its variant, which `admin-button-anatomy`
   * holds every page to. Deliberately not the app bar: `pageHeader` takes one
   * action, and two equal doors are not one.
   *
   * The approve form used to be a whole section at the foot of the page, the
   * same construction as adding a wall, for the path taken when a *wall*
   * starts its own device flow. `GET /admin/screens/approve` with no code
   * already renders that form, so the section is a link to it.
   */
  const actions =
    `<div class="wall-actions">` +
    `<a class="btn" href="admin/walls/new">Pair a browser wall</a>` +
    `<a class="btn btn-tonal" href="admin/epaper#add">Add an e-paper panel</a>` +
    `<a class="btn btn-ghost" href="admin/screens/approve">Approve a pairing code</a>` +
    `</div>`;

  return page({
    self: selfHref(c),
    modules: navModules(deps.db),
    title: 'Walls — Maverick Wall',
    nav: 'walls',
    heading: 'Walls',
    saved: readSaved(c),
    body:
      (error === undefined ? '' : errorBlock(error)) +
      actions +
      /*
       * Every card here is a real, paired wall. The Default wall used to lead
       * the grid and was neither — nothing is paired to it and nothing draws
       * it — so a household counting their walls counted one that does not
       * exist. What it held is split: the settings every wall inherits are on
       * System, and the canvas walls fell back to was copied onto them.
       */
      (walls.length === 0
        ? emptyState('No walls yet.', { label: 'Pair a browser wall', href: 'admin/walls/new' })
        : wallSummary(walls, at) + `<div class="grid g2">` + walls.map(cardFor).join('') + `</div>`) +
      revokedDisclosure(revoked, at),
  });
}

export function registerWallsRoutes(app: Hono, deps: AdminDeps): void {
  // The unified section. Screens and Layout were two pages for one thing, and
  // browser walls and e-paper walls were two nav items for one kind of object;
  // `/admin/walls` is the one list and the one canonical route now (RFC 009
  // Phase 4) — its status, pairing, settings and layout.
  app.get('/admin/walls', (c: Context) => c.html(displaysPage(c, deps)));

  const now = deps.now ?? ((): number => Date.now());
  const revokedScreens = (): AdminScreenRow[] =>
    readAdminScreens(deps.db).filter((screen) => screen.revokedAt !== null);

  /*
   * Forget all — a static segment, registered ahead of the `/admin/screens/:id`
   * family in `admin.ts` for the reason the approve route states: Hono answers
   * with the first pattern that matches, and `:id` would swallow
   * `forget-revoked` as a wall called that. This function runs at the point in
   * `registerAdminRoutes` where `/admin/walls` was declared, which is before
   * any of those.
   */
  app.get('/admin/screens/forget-revoked', (c: Context) => {
    const revoked = revokedScreens();
    // Nothing to forget is not a confirmation with nothing in it; it is the
    // list, which says so by having no disclosure.
    if (revoked.length === 0) return c.redirect('/admin/walls', 302);
    const n = revoked.length;
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Forget unpaired walls',
        nav: 'walls',
        heading: `Forget ${n === 1 ? 'the one' : `all ${n}`} unpaired wall${n === 1 ? '' : 's'}?`,
        intro:
          'Their tokens already do nothing. Forgetting them deletes their layouts too, and ' +
          'any panel that was following one of them goes back to its built-in view. ' +
          'Nothing on any paired wall changes.',
        body:
          `<ul class="hint">` +
          revoked.map((screen) => `<li>${escapeHtml(screen.name)} · unpaired ${escapeHtml(ago(screen.revokedAt, now()))}</li>`).join('') +
          `</ul>`,
        destroyAction: 'admin/screens/forget-revoked',
        destroyLabel: n === 1 ? 'Forget it' : 'Forget them all',
        cancelAction: 'admin/walls',
        cancelLabel: 'Keep them',
      }),
    );
  });

  app.post('/admin/screens/forget-revoked', (c: Context) => {
    // A token is a claim, so it is only sent on the branch that did something.
    if (deleteRevokedScreens(deps.db) === 0) return c.redirect('/admin/walls', 302);
    return savedRedirect(c, '/admin/walls', 'walls-forgotten');
  });

  /**
   * Forget one revoked wall: the GET names what goes, the POST does it.
   *
   * `deleteScreen` refuses a wall that is still paired, and so does this
   * page — the list only offers Forget on revoked walls, but the list is a
   * convenience and the POST is the boundary. A paired wall is sent back to
   * the list with the reason, because the thing to do about it is on its own
   * page (Unpair), not here.
   */
  app.get('/admin/screens/:id/forget', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const screen = revokedScreens().find((candidate) => candidate.id === id);
    if (screen === undefined) return c.redirect('/admin/walls', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Forget wall',
        nav: 'walls',
        heading: `Forget “${screen.name}”?`,
        intro:
          `It was unpaired ${ago(screen.revokedAt, now())} and its token already does nothing. ` +
          'Forgetting it deletes its layout too, and a panel that was following it goes back ' +
          'to its built-in view. Nothing on any other wall changes.',
        destroyAction: `admin/screens/${encodeURIComponent(id)}/forget`,
        destroyLabel: 'Forget it',
        cancelAction: 'admin/walls',
      }),
    );
  });

  app.post('/admin/screens/:id/forget', (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (deleteScreen(deps.db, id)) return savedRedirect(c, '/admin/walls', 'wall-forgotten');
    const stillThere = readAdminScreens(deps.db).some((candidate) => candidate.id === id);
    return c.html(
      displaysPage(
        c,
        deps,
        stillThere
          ? 'That wall is still paired, so it was not forgotten. Unpair it from its own page first.'
          : 'That wall is no longer there.',
      ),
      stillThere ? 400 : 404,
    );
  });
}
