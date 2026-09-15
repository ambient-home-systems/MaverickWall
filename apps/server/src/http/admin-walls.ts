import type { Context, Hono } from 'hono';

import { readAdminScreens, type AdminScreenRow } from '../api/queries.js';
import { navModules, type AdminDeps } from './admin.js';
import { section } from './components.js';
import { errorBlock, escapeHtml, icon, page, textField } from './html.js';
import { presence, presenceDot } from './presence.js';
import { readSaved } from './saved.js';
import { selfHref } from './self.js';

/**
 * The Walls list (RFC 016).
 *
 * Its own file rather than more of `admin.ts`, on the precedent `admin-ha.ts`
 * and `admin-epaper.ts` set when their parent grew past reading: one
 * `admin-<screen>.ts` exporting `register<Screen>Routes(app, deps)`, called
 * from `registerAdminRoutes` at the point in the order those routes belong.
 * This is a pure move — the page, its cards and its one route are exactly what
 * `admin.ts` held — so that the change RFC 016 phase 1 makes to the page is a
 * diff somebody can read.
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
 * card is the same object — a name, a kind tag, one status line, "Open" —
 * and the grid composes, which three heights and three affordances never did.
 *
 * The Default wall is gone from the list altogether: it was a card for a row
 * nothing is paired to and nothing draws, counted among a household's walls.
 * The dot still rides the status line rather than the head, which is now what
 * keeps a never-connected wall's name on the same edge as its neighbours'.
 *
 * `status` is already-escaped markup.
 */
function wallCard(href: string, name: string, tag: string | undefined, status: string): string {
  return (
    `<a class="card wall-card" href="${href}">` +
    `<div class="wall-head">` +
    `<div class="wall-head-main">` +
    `<div class="rname">${escapeHtml(name)}` +
    (tag === undefined ? '' : ` <span class="tag">${escapeHtml(tag)}</span>`) +
    `</div>` +
    `<div class="sub">${status}</div></div>` +
    `<span class="card-go">Open <span aria-hidden="true">${icon('chev')}</span></span>` +
    `</div></a>`
  );
}

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
function seenLine(screen: AdminScreenRow, at: number): string {
  const p = presence(screen, at);
  return presenceDot(p) + escapeHtml(p.headline) + (p.detail === '' ? '' : ` · ${escapeHtml(p.detail)}`);
}

/** A browser wall: its page holds status, pairing, settings and layout together. */
function displayListCard(screen: AdminScreenRow, at: number): string {
  return wallCard(
    `admin/walls/${encodeURIComponent(screen.id)}`,
    screen.name,
    'Browser',
    seenLine(screen, at) + (screen.appVersion === null ? '' : ` · ${escapeHtml(screen.appVersion)}`),
  );
}

/**
 * An e-paper panel: the same card, opening its layout page directly (the
 * `/admin/walls/:id` route would only redirect there, and a crawl of the
 * admin's own links should reach the page without a hop). The panel's
 * geometry stays on the status line because it is the one fact that tells
 * two panels apart, where two browser walls are told apart by their names.
 */
function epaperListCard(screen: AdminScreenRow, at: number): string {
  return wallCard(
    `admin/epaper/${encodeURIComponent(screen.id)}/design`,
    screen.name,
    'E-paper',
    seenLine(screen, at) +
      ` · ${screen.panelWidth ?? '?'}×${screen.panelHeight ?? '?'}` +
      (screen.rotation === 0 ? '' : ` · rotated ${screen.rotation}°`) +
      (screen.lanOnly === 1 ? ' · LAN only' : ''),
  );
}

/**
 * The Walls list: the shared Default plus every paired wall, browser and
 * e-paper alike — one list, one nav item, one card shape, with a kind chip
 * on each row rather than two nav entries for one kind of object (RFC 009
 * Phase 4). Every card opens its wall's own page.
 */
export function displaysPage(c: Context, deps: AdminDeps, error?: string): string {
  const now = deps.now ?? ((): number => Date.now());
  const at = now();
  const all = readAdminScreens(deps.db);
  const active = all.filter((screen) => screen.revokedAt === null);
  const revoked = all.length - active.length;

  const cardFor = (screen: AdminScreenRow): string =>
    screen.kind === 'epaper' ? epaperListCard(screen, at) : displayListCard(screen, at);

  // Reachable from nothing before this (RFC 009 Phase 4) — the device-flow
  // approve/decline page existed only as a URL a QR or a hand-typed link
  // could reach, with no form anywhere in the admin to get there.
  const approveForm = section(
    'Approve a pairing code',
    'A wall starting its own pairing flow shows an eight-character code. Type ' +
      'it here to approve or decline it.',
    `<form method="get" action="admin/screens/approve"><div class="row">` +
      textField({ label: 'Pairing code', name: 'code', placeholder: 'ABCD-EFGH', attrs: 'maxlength="12"' }) +
      `<button class="secondary" type="submit">Continue</button></div></form>`,
  );

  return page({
    self: selfHref(c),
    modules: navModules(deps.db),
    title: 'Walls — Maverick Wall',
    nav: 'walls',
    heading: 'Walls',
    saved: readSaved(c),
    // No app-bar action: see the Calendars page for the rule. The pairing
    // form is on this page, with the one filled Add wall.
    ...(active.length === 0
      ? { intro: 'No walls paired yet. Add one below and it will start on the layout you pick for it.' }
      : {}),
    body:
      (error === undefined ? '' : errorBlock(error)) +
      /*
       * Every card here is a real, paired display. The Default wall used to
       * lead the grid and was neither — nothing is paired to it and nothing
       * draws it — so a household counting their walls counted one that does
       * not exist. What it held is split: the settings every wall inherits are
       * on System, and the canvas walls fell back to was copied onto them.
       */
      (active.length === 0 ? '' : `<div class="grid g2">` + active.map(cardFor).join('') + `</div>`) +
      (revoked === 0
        ? ''
        : `<p class="hint">${revoked} unpaired wall${revoked === 1 ? '' : 's'} kept ` +
          `for the record. Their tokens no longer work.</p>`) +
      /*
       * Two doors, one shape. The browser form used to be right here — a
       * single name field — while e-paper had a page of its own asking for a
       * size and a rotation, so the two ways of adding a wall looked nothing
       * alike and the commoner one asked for the least. Both are pages now,
       * both ask name → hardware → starting layout → pair, and this list
       * carries the two links side by side rather than one form and one link.
       */
      section(
        'Add a wall',
        undefined,
        `<p class="hint">A tablet, monitor or television with Maverick Wall open in ` +
          `a browser. You name it and say what it is, then get a QR code and a ` +
          `short code to enter on the wall itself. ` +
          `<a class="link" href="admin/walls/new">Pair a new wall →</a></p>` +
          `<p class="hint">Low-power e-paper panels are added the same way, with ` +
          `their own panel sizes and starting views. ` +
          `<a class="link" href="admin/epaper#add">Add an e-paper wall →</a></p>`,
        'add',
      ) +
      approveForm,
  });
}

export function registerWallsRoutes(app: Hono, deps: AdminDeps): void {
  // The unified section. Screens and Layout were two pages for one thing, and
  // browser walls and e-paper walls were two nav items for one kind of object;
  // `/admin/walls` is the one list and the one canonical route now (RFC 009
  // Phase 4) — its status, pairing, settings and layout.
  app.get('/admin/walls', (c: Context) => c.html(displaysPage(c, deps)));
}
