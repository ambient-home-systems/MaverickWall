import { randomBytes } from 'node:crypto';

import type { Context, Hono } from 'hono';

import { issueDisplayToken, type IssuedToken } from '../auth/tokens.js';
import { createScreen, readAdminScreens, readHousehold } from '../api/queries.js';
import {
  applyWallState,
  checkStateCss,
  exportableState,
  readSnapshotState,
  readSnapshots,
  readWallState,
  snapshotWall,
  WALL_STATE_VERSION,
  wallFileSchema,
  type ApplyOutcome,
} from '../api/wall-state.js';
import { parse } from '../validation.js';
import { navModules, pairingSecret, type AdminDeps } from './admin.js';
import { emptyState, listRow, section } from './components.js';
import { errorBlock, escapeHtml, icon, page } from './html.js';
import { readSaved, savedRedirect, type SavedKey } from './saved.js';
import { selfHref } from './self.js';

/**
 * A wall's earlier versions, its layout as a file, and a copy of it (plan
 * items M8.4–M8.6).
 *
 * One page because they are one idea — a wall's look as something a household
 * can keep, carry and repeat — and because each is infrequent: reached from
 * Advanced on the wall's settings, like Custom CSS. Every write here takes a
 * snapshot first, so the page can never be the way a layout is lost: an
 * import or a restore pressed by mistake is one more Restore away from
 * undone — which is why none of them asks "are you sure?" first.
 */

/** A file this large is not a layout; a real one is a few kilobytes. */
export const WALL_FILE_MAX_BYTES = 256 * 1024;

/** The Advanced row that leads here. */
export function versionsAdvancedRow(wallId: string): string {
  const id = encodeURIComponent(wallId);
  return (
    `<a class="arow" href="admin/walls/${id}/versions">` +
    `<span class="arow-text">Versions and copies` +
    `<small>Go back to an earlier layout, save this one as a file, or make a second wall like it.</small></span>` +
    `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span></a>`
  );
}

/** The sentence after a restore or an import, chosen by what could not be carried. */
function outcomeKey(kind: 'restored' | 'imported', outcome: ApplyOutcome): SavedKey {
  if (outcome.themeKept) return kind === 'restored' ? 'wall-restored-theme-kept' : 'wall-imported-theme-kept';
  if (outcome.cssDropped > 0) return kind === 'restored' ? 'wall-restored-css-dropped' : 'wall-imported-css-dropped';
  return kind === 'restored' ? 'wall-restored' : 'wall-imported';
}

export function registerWallVersionRoutes(
  app: Hono,
  deps: AdminDeps,
  reveal: (id: string, issued: IssuedToken) => void,
): void {
  const now = deps.now ?? ((): number => Date.now());

  /** A paired browser wall, or undefined: a panel draws a frame and has no canvas to keep. */
  const wallOf = (id: string): { readonly id: string; readonly name: string; readonly theme: string } | undefined => {
    const screen = readAdminScreens(deps.db).find((s) => s.id === id && s.revokedAt === null);
    if (screen === undefined || screen.kind === 'epaper') return undefined;
    return { id: screen.id, name: screen.name, theme: screen.theme ?? 'panels' };
  };

  /** "Mon 12 Oct, 14:32", in the household's own zone. */
  const when = (at: number): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: readHousehold(deps.db).timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));

  function versionsPage(c: Context, wall: { readonly id: string; readonly name: string }, error?: string): string {
    const id = encodeURIComponent(wall.id);
    const snapshots = readSnapshots(deps.db, wall.id);
    const earlier =
      snapshots.length === 0
        ? emptyState('No earlier versions yet. One is kept each time this wall’s layout or look is saved.')
        : `<div class="rows">` +
          snapshots
            .map((snapshot) =>
              listRow(
                '',
                { title: when(snapshot.createdAt), detail: snapshot.reason },
                `<form method="post" action="admin/walls/${id}/versions/${encodeURIComponent(snapshot.id)}/restore">` +
                  `<button class="btn-ghost" type="submit" aria-label="Restore the version from ${escapeHtml(when(snapshot.createdAt))}">Restore</button>` +
                  `</form>`,
              ),
            )
            .join('') +
          `</div>`;

    const body =
      (error === undefined ? '' : errorBlock(error)) +
      section(
        'Earlier versions',
        'The last twenty, newest first. Each is the wall as it was just before a save changed it: every layout, its hours, the theme, the backgrounds, the spacing and the CSS. Restoring one keeps how it looks now as a version first.',
        earlier,
      ) +
      section(
        'Save as a file',
        'Every layout on this wall, its hours and its look, as one file you can keep or open on another Maverick Wall. A guest Wi-Fi password in a QR code is left out of the file, and so are uploaded pictures — only their names travel.',
        `<a class="btn" href="admin/walls/${id}/export.json" download data-download>Download layout</a>`,
      ) +
      section(
        'Open a file',
        'Replaces every layout on this wall with the one in the file. How it looks now is kept as a version first, so this can be undone above. The wall’s name, its pairing and what may be pressed on it do not change.',
        `<form method="post" action="admin/walls/${id}/import" enctype="multipart/form-data">` +
          `<label>Layout file<input type="file" name="layout" accept="application/json,.json" required></label>` +
          `<div class="saverow"><button type="submit">Open file</button></div>` +
          `</form>`,
      ) +
      section(
        'Make a second wall like this one',
        'A new wall with these layouts, hours and look. It needs pairing on its own tablet or television, and starts with nothing it may press: alerts, chores, to-do lists and the house are each its own switch.',
        `<form method="post" action="admin/walls/${id}/duplicate">` +
          `<div class="saverow"><button type="submit">Duplicate wall</button></div>` +
          `</form>`,
      );

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `Versions and copies — ${wall.name} — Maverick Wall`,
      nav: 'walls',
      heading: 'Versions and copies',
      saved: readSaved(c),
      back: { label: wall.name, href: `admin/walls/${id}` },
      intro: `Earlier versions of ${wall.name}, its layout as a file, and a second wall like it.`,
      body,
    });
  }

  app.get('/admin/walls/:id/versions', (c: Context) => {
    const wall = wallOf(c.req.param('id') ?? '');
    if (wall === undefined) return c.redirect('/admin/walls', 302);
    return c.html(versionsPage(c, wall));
  });

  /**
   * Restore one version. The wall as it is now is kept first, forced past the
   * burst rule, so a restore is itself one Restore from undone.
   */
  app.post('/admin/walls/:id/versions/:snapshot/restore', (c: Context) => {
    const wall = wallOf(c.req.param('id') ?? '');
    if (wall === undefined) return c.redirect('/admin/walls', 302);
    const state = readSnapshotState(deps.db, wall.id, c.req.param('snapshot') ?? '');
    if (state === undefined) {
      return c.html(versionsPage(c, wall, 'That version is not one this wall still keeps.'), 404);
    }
    snapshotWall(deps.db, wall.id, 'Before an earlier version was restored', now(), { force: true });
    const outcome = applyWallState(deps.db, wall.id, state, { freshIds: false });
    return savedRedirect(c, `/admin/walls/${encodeURIComponent(wall.id)}/versions`, outcomeKey('restored', outcome));
  });

  /**
   * The layout as a file. `no-store`, like every page that could carry
   * something a household would not post: the file is theirs to keep, not a
   * cache's.
   */
  app.get('/admin/walls/:id/export.json', (c: Context) => {
    const wall = wallOf(c.req.param('id') ?? '');
    const state = wall === undefined ? undefined : readWallState(deps.db, wall.id);
    if (wall === undefined || state === undefined) return c.redirect('/admin/walls', 302);
    const file = {
      format: 'maverick-wall-layout',
      version: WALL_STATE_VERSION,
      name: wall.name,
      exportedAt: new Date(now()).toISOString(),
      state: exportableState(state).state,
    };
    const slug = wall.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wall';
    c.header('content-type', 'application/json; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${slug}-layout.json"`);
    c.header('cache-control', 'no-store');
    return c.body(`${JSON.stringify(file, null, 2)}\n`);
  });

  /**
   * Open a file onto this wall.
   *
   * Refused whole, never half applied: the file is read through the same
   * schemas a save goes through (rule five), an unknown widget type or a key
   * no schema names is a sentence rather than a widget dropped, and every
   * block of CSS in it is put through the sanitiser before anything is
   * written. Every widget gets a fresh id, because a widget id is unique
   * across the house and the file may be this wall's own.
   */
  app.post('/admin/walls/:id/import', async (c: Context) => {
    const wall = wallOf(c.req.param('id') ?? '');
    if (wall === undefined) return c.redirect('/admin/walls', 302);
    const body = await c.req.parseBody();
    const file = body['layout'];
    if (!(file instanceof File) || file.size === 0) {
      return c.html(versionsPage(c, wall, 'Choose a layout file to open.'), 400);
    }
    if (file.size > WALL_FILE_MAX_BYTES) {
      return c.html(versionsPage(c, wall, 'That file is too large to be a layout. A layout file is a few kilobytes.'), 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      return c.html(versionsPage(c, wall, 'That file is not a layout: it could not be read as JSON.'), 400);
    }
    const shaped = parse(wallFileSchema, raw);
    if (!shaped.ok) {
      return c.html(versionsPage(c, wall, `That file could not be opened: ${shaped.message}`), 400);
    }
    const problems = checkStateCss(shaped.value.state);
    if (problems.length > 0) {
      const first = problems[0] as { where: string; reason: string };
      const where = first.where === 'wall' ? 'the wall’s own CSS' : `the CSS on a ${first.where} widget`;
      return c.html(versionsPage(c, wall, `That file could not be opened: ${where} was refused. ${first.reason}`), 400);
    }
    snapshotWall(deps.db, wall.id, 'Before a layout file was opened', now(), { force: true });
    const outcome = applyWallState(deps.db, wall.id, shaped.value.state, { freshIds: true });
    return savedRedirect(c, `/admin/walls/${encodeURIComponent(wall.id)}/versions`, outcomeKey('imported', outcome));
  });

  /**
   * A second wall like this one, and straight to pairing it.
   *
   * The look and every layout are copied with fresh widget ids; the name says
   * it is a copy, and nothing it may press is: every `allow_*` starts off, as
   * on any new wall, because what a screen may press is a decision about the
   * room it hangs in.
   */
  app.post('/admin/walls/:id/duplicate', (c: Context) => {
    const wall = wallOf(c.req.param('id') ?? '');
    const state = wall === undefined ? undefined : readWallState(deps.db, wall.id);
    if (wall === undefined || state === undefined) return c.redirect('/admin/walls', 302);
    const issued = issueDisplayToken();
    const id = randomBytes(6).toString('hex');
    const name = `${wall.name.slice(0, 73)} (copy)`;
    createScreen(deps.db, id, name, pairingSecret(issued), wall.theme);
    applyWallState(deps.db, id, state, { freshIds: true });
    reveal(id, issued);
    return c.redirect(`/admin/walls/${encodeURIComponent(id)}/pair`, 303);
  });
}
