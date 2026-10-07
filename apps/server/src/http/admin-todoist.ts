import type { Context, Hono } from 'hono';

import { TODOIST, listProjects } from '../modules/todoist/client.js';
import {
  connectTodoist,
  disconnectTodoist,
  todoistConnected,
  todoistListId,
  todoistProjectOf,
  todoistToken,
} from '../modules/todoist/store.js';
import { pollTodoistList, readTodoistLists, unwatchTodoList, watchTodoList } from '../modules/todo/index.js';
import { parse, z } from '../validation.js';
import { confirmDestroyPage, errorBlock, escapeHtml, icon, page, selectField, textField } from './html.js';
import { card, destructive, emptyState, section, tag } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * Todoist, in the admin (plan item M5.7).
 *
 * Where a Todoist token is pasted, and the only place. It is used before it is
 * stored — the account's projects are read with it — so "Connected" is never
 * said of one Todoist refused, then sealed and never shown again. The lists on
 * walls are projects the household chose here, one at a time, each read before
 * "List added" is said; they sit in the same to-do store as Home Assistant's,
 * so the To-do widget, the wall's tick and the companion add treat both alike.
 */

const tokenBody = z.object({
  token: z.string().trim().min(1, 'Paste the API token from Todoist.').max(200, 'That is longer than a Todoist token.'),
});
const projectBody = z.object({
  project: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Choose a project.'),
});

export function registerTodoistRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  const todoist = deps.todoist ?? TODOIST;

  app.get('/admin/todoist', (c: Context) => c.html(todoistPage(c)));

  app.post('/admin/todoist/connect', async (c: Context) => {
    const shaped = parse(tokenBody, (await c.req.parseBody()) as Record<string, unknown>);
    // The token is never written back into a page, refused or not.
    if (!shaped.ok) return c.html(todoistPage(c, shaped.message), 400);
    const connected = await connectTodoist(
      { db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, now: now() },
      todoist,
      shaped.value.token,
    );
    if (!connected.ok) return c.html(todoistPage(c, connected.message), 400);
    return savedRedirect(c, '/admin/todoist', 'todoist-connected');
  });

  app.get('/admin/todoist/lists/new', async (c: Context) => c.html(await newListPage(c)));

  app.post('/admin/todoist/lists', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(projectBody, body);
    if (!shaped.ok) return c.html(await newListPage(c, shaped.message), 400);
    const token = todoistToken(deps.db, deps.keyring);
    if (!token.ok) return c.html(await newListPage(c, token.message), 400);
    // Only a project the account really has: the form is a convenience and the POST is the boundary.
    const projects = await listProjects(deps.fetcher, todoist, token.token);
    if (!projects.ok) return c.html(await newListPage(c, projects.message), 400);
    const project = projects.value.find((one) => one.id === shaped.value.project);
    if (project === undefined) {
      return c.html(await newListPage(c, 'That project is not in your Todoist any more.'), 400);
    }
    const listId = todoistListId(project.id);
    const watched = watchTodoList(deps.db, { entityId: listId, name: project.name, label: null, supportsUpdate: true }, now());
    if (!watched.ok) return c.html(await newListPage(c, watched.message), 400);
    // Read before "added" is said, as a Home Assistant list is; a list that does not read is not kept.
    const read = await pollTodoistList({ db: deps.db, fetcher: deps.fetcher, keyring: deps.keyring, now: now() }, listId, todoist);
    if (!read.ok) {
      unwatchTodoList(deps.db, listId);
      return c.html(await newListPage(c, read.message), 400);
    }
    return savedRedirect(c, '/admin/todoist', 'todoist-list-added');
  });

  app.post('/admin/todoist/lists/:project/remove', (c: Context) => {
    const listId = todoistListId(c.req.param('project') ?? '');
    // A token is a claim: a list already gone changed nothing.
    if (!readTodoistLists(deps.db).some((list) => list.entityId === listId)) return c.redirect('/admin/todoist', 302);
    unwatchTodoList(deps.db, listId);
    return savedRedirect(c, '/admin/todoist', 'todoist-list-removed');
  });

  app.get('/admin/todoist/disconnect', (c: Context) => {
    if (!todoistConnected(deps.db)) return c.redirect('/admin/todoist', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Disconnect Todoist',
        nav: 'todoist',
        heading: 'Disconnect Todoist?',
        intro:
          'The token is forgotten, and so is every Todoist list on your walls. Nothing in Todoist is changed. ' +
          'To stop the token working at all, reset it in Todoist as well.',
        destroyAction: 'admin/todoist/disconnect',
        destroyLabel: 'Disconnect',
        cancelAction: 'admin/todoist',
      }),
    );
  });

  app.post('/admin/todoist/disconnect', (c: Context) => {
    if (!todoistConnected(deps.db)) return c.redirect('/admin/todoist', 302);
    disconnectTodoist(deps.db);
    return savedRedirect(c, '/admin/todoist', 'todoist-disconnected');
  });

  function connectForm(): string {
    return (
      `<form method="post" action="admin/todoist/connect">` +
      textField({
        label: 'API token',
        name: 'token',
        type: 'password',
        required: true,
        attrs: 'autocomplete="off" spellcheck="false"',
      }) +
      `<p class="hint">In Todoist: Settings › Integrations › Developer › API token. Copy it and paste it here. ` +
      `A Todoist token can read and change your whole account, so it is kept sealed and used for three things ` +
      `only: reading the projects you add here, ticking an item off on a wall that allows it, and adding an ` +
      `item from a phone with your companion token. It is never sent to a wall.</p>` +
      `<button type="submit">Connect</button></form>`
    );
  }

  function listCard(list: { entityId: string; name: string; lastError: string | null }): string {
    const project = todoistProjectOf(list.entityId);
    return card(
      `<div class="card-head"><div class="card-head-main">` +
        `<h2>${escapeHtml(list.name)}</h2>` +
        (list.lastError === null
          ? tag('Read every minute', 'ok')
          : `${tag('Not read last time', 'warn')} <p class="hint">${escapeHtml(list.lastError)} ` +
            `The wall keeps showing what it had.</p>`) +
        `</div>` +
        `<details class="ovf" data-overflow>` +
        `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
        `aria-label="More actions for ${escapeHtml(list.name)}" title="More">${icon('more')}</summary>` +
        `<div class="ovf-menu" role="menu">` +
        `<form method="post" action="admin/todoist/lists/${encodeURIComponent(project)}/remove">` +
        `<button type="submit" class="btn-text">Take off walls</button></form>` +
        `</div></details></div>`,
    );
  }

  function todoistPage(c: Context, error?: string): string {
    const connected = todoistConnected(deps.db);
    const lists = readTodoistLists(deps.db);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Todoist — Maverick Wall',
      nav: 'todoist',
      heading: 'Todoist',
      saved: readSaved(c),
      ...(connected ? { action: { label: 'Add a list', href: 'admin/todoist/lists/new' } } : {}),
      intro:
        'Show a Todoist project on your walls as a to-do list, tick things off it from a wall that allows it, ' +
        'and add to it from your phone. A To-do widget draws it, as it draws a Home Assistant list.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        (!connected
          ? section('Connect', 'Paste a token to start.', connectForm())
          : (lists.length === 0
              ? emptyState('No Todoist lists on your walls yet.', { label: 'Add a list', href: 'admin/todoist/lists/new' })
              : lists.map(listCard).join('')) +
            section(
              'Connection',
              'Connected. The token is sealed and is not shown again.',
              destructive('Disconnect Todoist', { thing: 'Todoist', confirmAction: 'admin/todoist/disconnect' }),
            )),
    });
  }

  /**
   * Choosing a project, on a page of its own (P2.1): the account's projects,
   * read live, less the ones already on walls.
   */
  async function newListPage(c: Context, error?: string): Promise<string> {
    const shell = (body: string): string =>
      page({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Add a Todoist list — Maverick Wall',
        nav: 'todoist',
        heading: 'Add a list',
        back: { label: 'Todoist', href: 'admin/todoist' },
        body: (error === undefined ? '' : errorBlock(error)) + body,
      });
    const token = todoistToken(deps.db, deps.keyring);
    if (!token.ok) return shell(`<p>${escapeHtml(token.message)}</p>`);
    const projects = await listProjects(deps.fetcher, todoist, token.token);
    if (!projects.ok) return shell(`<p>${escapeHtml(projects.message)}</p>`);
    const shown = new Set(readTodoistLists(deps.db).map((list) => todoistProjectOf(list.entityId)));
    const open = projects.value.filter((project) => !shown.has(project.id));
    if (open.length === 0) {
      return shell(emptyState('Every project in your Todoist is already on your walls.'));
    }
    return shell(
      `<form method="post" action="admin/todoist/lists">` +
        selectField({
          label: 'Project',
          name: 'project',
          optionsHtml: open
            .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`)
            .join(''),
          hint: 'Its open items are read every minute. Subtasks are left out: a list is read flat.',
        }) +
        `<button type="submit">Add list</button></form>`,
    );
  }
}
