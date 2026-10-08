import type { Context, Hono } from 'hono';

import { listAlbums, listPeople, type ImmichChoice } from '../modules/immich/client.js';
import {
  addImmichSource,
  connectImmich,
  disconnectImmich,
  immichEndpoint,
  readImmichConnection,
  readImmichSources,
  removeImmichSource,
  syncImmichSource,
  type ImmichSourceKind,
} from '../modules/immich/store.js';
import { todayIn } from '../jobs/immich-sync.js';
import { readHousehold } from '../api/queries.js';
import { checkbox, parse, z } from '../validation.js';
import { confirmDestroyPage, errorBlock, escapeHtml, networkAccessLabel, page, switchRow, textField } from './html.js';
import { card, emptyState, listRow, section, tag } from './components.js';
import { savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * Immich, in the admin (plan item M3.2): connecting, and choosing what to show.
 *
 * Its own pages under Photos, because Immich is where the household's photos
 * already are and Photos is where a household goes to put photos on a wall.
 * The key is used before it is kept, so "Connected" is never said of a key
 * Immich refused; a source is read before "Added" is said; and nothing here
 * ever shows the key again.
 */

const connectBody = z.object({
  url: z.string().trim().min(1, 'Paste the address you open Immich at.').max(300, 'That address is too long.'),
  key: z.string().trim().min(1, 'Paste an API key from Immich.').max(200, 'That is longer than an Immich API key.'),
  allow_lan: checkbox(),
  allow_http: checkbox(),
});
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const chooseBody = z.object({
  choice: z
    .string()
    .regex(/^(album:[0-9a-fA-F-]{36}|person:[0-9a-fA-F-]{36}|favourites|memories)$/, 'Choose what to show.'),
});

export function registerImmichRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());
  const context = (): { db: typeof deps.db; keyring: typeof deps.keyring; fetcher: typeof deps.fetcher; dataDir: string; now: number } => ({
    db: deps.db,
    keyring: deps.keyring,
    fetcher: deps.fetcher,
    dataDir: deps.dataDir,
    now: now(),
  });

  app.get('/admin/photos/immich', (c: Context) => c.html(connectPage(c, {})));

  app.post('/admin/photos/immich', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    // The address and switches come back on a refusal; the key never does.
    const echo = {
      url: typeof body['url'] === 'string' ? body['url'].slice(0, 300) : '',
      allowLan: body['allow_lan'] !== undefined,
      allowHttp: body['allow_http'] !== undefined,
    };
    const shaped = parse(connectBody, body);
    if (!shaped.ok) return c.html(connectPage(c, echo, shaped.message), 400);
    let url: URL;
    try {
      url = new URL(shaped.value.url);
    } catch {
      return c.html(connectPage(c, echo, 'That is not an address. It looks like http://192.168.1.10:2283.'), 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return c.html(connectPage(c, echo, 'Immich is reached at an http or https address.'), 400);
    }
    const connected = await connectImmich(context(), {
      url: shaped.value.url,
      key: shaped.value.key,
      allowLan: shaped.value.allow_lan,
      allowHttp: shaped.value.allow_http,
    });
    if (!connected.ok) {
      const reason =
        connected.switches === undefined
          ? connected.message
          : `That address needs ${connected.switches.map((option) => `“${networkAccessLabel(option)}”`).join(' and ')} ` +
            'turned on below.';
      return c.html(connectPage(c, echo, reason), 400);
    }
    return savedRedirect(c, '/admin/photos', 'immich-connected');
  });

  app.get('/admin/photos/immich/add', async (c: Context) => c.html(...(await addPage(c))));

  app.post('/admin/photos/immich/add', async (c: Context) => {
    const shaped = parse(chooseBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(...(await addPage(c, shaped.message)));
    const endpoint = immichEndpoint(deps.db, deps.keyring);
    if (endpoint === undefined) return c.redirect('/admin/photos/immich', 302);
    const [kind, ref] = shaped.value.choice.split(':') as [ImmichSourceKind, string | undefined];
    /*
     * The name from Immich, and only for an id Immich still has: the form is
     * a convenience and the POST is the boundary, so a hand-posted id that is
     * no album of this account adds nothing.
     */
    let name: string | undefined;
    if (kind === 'album' || kind === 'person') {
      const listed = kind === 'album' ? await listAlbums(deps.fetcher, endpoint) : await listPeople(deps.fetcher, endpoint);
      if (!listed.ok) return c.html(...(await addPage(c, listed.message)));
      name = listed.value.find((one) => one.id.toLowerCase() === (ref ?? '').toLowerCase())?.name;
      if (name === undefined || ref === undefined || !UUID.test(ref)) {
        return c.html(...(await addPage(c, 'That is not in your Immich any more.')));
      }
    } else {
      name = kind === 'favourites' ? 'Favourites' : 'On this day';
    }
    const added = addImmichSource(deps.db, { kind, ref: ref ?? null, name }, now());
    if (!added.ok) return c.html(...(await addPage(c, added.message)));
    // Read before "added" is said; a source that does not read is not kept.
    const read = await syncImmichSource(context(), added.id, todayIn(readHousehold(deps.db).timezone, now()));
    if (!read.ok) {
      removeImmichSource(deps.db, deps.dataDir, added.id);
      return c.html(...(await addPage(c, read.message)));
    }
    return savedRedirect(c, '/admin/photos', 'immich-source-added');
  });

  app.post('/admin/photos/immich/sources/:id/remove', (c: Context) =>
    removeImmichSource(deps.db, deps.dataDir, c.req.param('id') ?? '')
      ? savedRedirect(c, '/admin/photos', 'immich-source-removed')
      : c.redirect('/admin/photos', 302),
  );

  app.get('/admin/photos/immich/disconnect', (c: Context) => {
    if (readImmichConnection(deps.db) === undefined) return c.redirect('/admin/photos', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Disconnect Immich',
        nav: 'photos',
        heading: 'Disconnect Immich?',
        intro:
          'The key is forgotten, and so is everything chosen from Immich, with the copies of its photos kept on ' +
          'this box. Walls showing them say their album has gone. Nothing in Immich is changed — to stop the key ' +
          'working at all, delete it in Immich as well.',
        destroyAction: 'admin/photos/immich/disconnect',
        destroyLabel: 'Disconnect',
        cancelAction: 'admin/photos',
      }),
    );
  });

  app.post('/admin/photos/immich/disconnect', (c: Context) => {
    if (readImmichConnection(deps.db) === undefined) return c.redirect('/admin/photos', 302);
    disconnectImmich(deps.db, deps.dataDir);
    return savedRedirect(c, '/admin/photos', 'immich-disconnected');
  });

  function connectPage(c: Context, echo: { url?: string; allowLan?: boolean; allowHttp?: boolean }, error?: string): string {
    const current = readImmichConnection(deps.db);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Connect Immich — Maverick Wall',
      nav: 'photos',
      heading: current === undefined ? 'Connect Immich' : 'Change the Immich connection',
      back: { label: 'Photos', href: 'admin/photos' },
      intro: 'Show albums, people, favourites and memories from your own Immich, without copying them here first.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/photos/immich">` +
        textField({
          label: 'Immich address',
          name: 'url',
          required: true,
          placeholder: 'http://192.168.1.10:2283',
          value: echo.url ?? current?.baseUrl ?? '',
          attrs: 'autocomplete="off" spellcheck="false"',
        }) +
        textField({
          label: 'API key',
          name: 'key',
          type: 'password',
          required: true,
          attrs: 'autocomplete="off" spellcheck="false"',
        }) +
        `<p class="hint">In Immich: Account Settings › API Keys › New API Key. It only needs to read: give it ` +
        `user.read, album.read, person.read, memory.read, asset.read and asset.view, or All. It is used before ` +
        `it is kept, then sealed, and never shown again or sent to a wall.</p>` +
        switchRow({
          label: networkAccessLabel('allowPrivateNetwork'),
          name: 'allow_lan',
          checked: echo.allowLan ?? current?.allowLan ?? false,
          hint: 'Immich is usually on your own network — this machine included.',
        }) +
        switchRow({
          label: networkAccessLabel('allowHttp'),
          name: 'allow_http',
          checked: echo.allowHttp ?? current?.allowHttp ?? false,
          hint: 'The key travels unencrypted. Only for an Immich on your own network.',
        }) +
        `<div class="row"><button type="submit">Connect</button></div></form>`,
    });
  }

  /** What can be chosen, read from Immich as the page is drawn. */
  async function addPage(c: Context, error?: string): Promise<[string, 200 | 400]> {
    const endpoint = immichEndpoint(deps.db, deps.keyring);
    const head = {
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add from Immich — Maverick Wall',
      nav: 'photos',
      heading: 'Add from Immich',
      back: { label: 'Photos', href: 'admin/photos' },
    };
    if (endpoint === undefined) {
      return [page({ ...head, body: emptyState('Immich is not connected.', { label: 'Connect Immich', href: 'admin/photos/immich' }) }), 200];
    }
    const [albums, people] = await Promise.all([listAlbums(deps.fetcher, endpoint), listPeople(deps.fetcher, endpoint)]);
    const problem = error ?? (!albums.ok ? albums.message : !people.ok ? people.message : undefined);
    const have = new Set(readImmichSources(deps.db).map((source) => `${source.kind}:${source.ref ?? ''}`));
    // The weather place picker's markup: one radio group per kind, in `.checks`.
    const choice = (value: string, label: string, detail?: string): string =>
      `<label><input type="radio" name="choice" value="${escapeHtml(value)}" required>` +
      `<span>${escapeHtml(detail === undefined ? label : `${label} — ${detail}`)}</span></label>`;
    const radios = (name: string, inner: string): string =>
      `<div class="checks" role="radiogroup" aria-label="${escapeHtml(name)}">${inner}</div>`;
    const group = (title: string, kind: 'album' | 'person', list: readonly ImmichChoice[]): string => {
      const open = list.filter((one) => !have.has(`${kind}:${one.id}`));
      return section(
        title,
        undefined,
        open.length === 0
          ? `<p class="hint">${kind === 'album' ? 'No albums to add.' : 'Nobody to add — name people in Immich first.'}</p>`
          : radios(
              title,
              open
                .map((one) =>
                  choice(`${kind}:${one.id}`, one.name, one.count === undefined ? undefined : `${one.count} item${one.count === 1 ? '' : 's'}`),
                )
                .join(''),
            ),
      );
    };
    const body =
      (problem === undefined ? '' : errorBlock(problem)) +
      `<form method="post" action="admin/photos/immich/add">` +
      section(
        'Collections',
        undefined,
        radios(
          'Collections',
          (have.has('favourites:') ? '' : choice('favourites', 'Favourites', 'every photo marked with a heart')) +
            (have.has('memories:') ? '' : choice('memories', 'On this day', 'Immich’s memories for today, from years before')),
        ),
      ) +
      (albums.ok ? group('Albums', 'album', albums.value) : '') +
      (people.ok ? group('People', 'person', people.value) : '') +
      `<div class="row"><button type="submit">Add</button></div></form>`;
    return [page({ ...head, body }), problem === undefined ? 200 : 400];
  }
}

/** The Immich section of the Photos screen. */
export function immichSection(db: AdminDeps['db']): string {
  const connection = readImmichConnection(db);
  if (connection === undefined) {
    return section(
      'Immich',
      'Show your Immich albums, people, favourites and memories on a wall, without copying them here.',
      `<p><a class="btn btn-ghost" href="admin/photos/immich">Connect Immich</a></p>`,
    );
  }
  const sources = readImmichSources(db);
  return section(
    'From Immich',
    `Connected to ${connection.host}${connection.accountLabel === null ? '' : ` as ${connection.accountLabel}`}. ` +
      'An Image widget can show any of these as a slideshow.',
    (sources.length === 0
      ? emptyState('Nothing chosen from Immich yet.', { label: 'Add from Immich', href: 'admin/photos/immich/add' })
      : sources
          .map((source) =>
            card(
              listRow(
                '',
                {
                  title: source.name,
                  detail:
                    (source.kind === 'album' ? 'Album' : source.kind === 'person' ? 'Person' : source.kind === 'favourites' ? 'Favourites' : 'Memories') +
                    ` · ${source.count} photo${source.count === 1 ? '' : 's'}`,
                },
                source.lastError === null ? '' : tag('Problem', 'danger'),
              ) +
                (source.lastError === null ? '' : errorBlock(source.lastError, 'The photos it had are still shown.')) +
                // Nothing in it is not a fault, and a wall does not go blank over it (plan item M3.8).
                (source.count === 0 && source.lastError === null
                  ? `<p class="hint">${escapeHtml(
                      source.kind === 'memories'
                        ? 'Immich has no memories for today. A wall showing them draws a bundled picture until there are.'
                        : 'Nothing to show right now. A wall showing it draws a bundled picture until there is.',
                    )}</p>`
                  : '') +
                `<form method="post" action="admin/photos/immich/sources/${escapeHtml(source.id)}/remove">` +
                `<button class="secondary" type="submit" aria-label="Remove ${escapeHtml(source.name)}">Remove</button></form>`,
              source.lastError === null ? {} : { tone: 'danger' },
            ),
          )
          .join('') +
        `<p><a class="btn btn-ghost" href="admin/photos/immich/add">Add from Immich</a></p>`) +
      `<p class="hint"><a href="admin/photos/immich">Change the connection</a> · ` +
      `<a href="admin/photos/immich/disconnect">Disconnect Immich</a></p>`,
  );
}
