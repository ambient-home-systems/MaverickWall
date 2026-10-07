import type { Context, Hono } from 'hono';

import { addFolder, readFolders, removeFolder, type FolderRow } from '../modules/folder/store.js';
import { checkbox, optionalText, parse, z } from '../validation.js';
import { errorBlock, escapeHtml, networkAccessLabel, page, switchRow, textField } from './html.js';
import { card, emptyState, listRow, section, tag } from './components.js';
import { savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * NAS folders, in the admin (plan item M3.3): adding one, and the section of
 * the Photos screen that lists them.
 *
 * A folder is read before it is added, so "Added" is never said of one the
 * NAS refused, and what is typed is echoed back on a refusal — the address,
 * the username and the switches, never the password.
 */

const folderBody = z.object({
  name: z.string().trim().min(1, 'Give the folder a name.').max(80, 'That name is too long.'),
  url: z.string().trim().min(1, 'Paste the folder’s WebDAV address.').max(500, 'That address is too long.'),
  username: optionalText(200),
  password: optionalText(500),
  subfolders: checkbox(),
  allow_lan: checkbox(),
  allow_http: checkbox(),
});

export function registerFolderRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/photos/folders/new', (c: Context) => c.html(addPage(c, {})));

  app.post('/admin/photos/folders', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const echo = {
      name: typeof body['name'] === 'string' ? body['name'].slice(0, 80) : '',
      url: typeof body['url'] === 'string' ? body['url'].slice(0, 500) : '',
      username: typeof body['username'] === 'string' ? body['username'].slice(0, 200) : '',
      subfolders: body['subfolders'] !== undefined,
      allowLan: body['allow_lan'] !== undefined,
      allowHttp: body['allow_http'] !== undefined,
    };
    const shaped = parse(folderBody, body);
    if (!shaped.ok) return c.html(addPage(c, echo, shaped.message), 400);
    let url: URL;
    try {
      url = new URL(shaped.value.url);
    } catch {
      return c.html(addPage(c, echo, 'That is not an address. It looks like http://192.168.1.10:5005/photo/Holidays.'), 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return c.html(addPage(c, echo, 'A folder is read from an http or https address.'), 400);
    }
    // A password in the address would be stored and shown with it; it has a field of its own.
    if (url.username !== '' || url.password !== '') {
      return c.html(addPage(c, echo, 'Put the username and password in their own boxes, not in the address.'), 400);
    }
    const added = await addFolder(
      { db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, dataDir: deps.dataDir, now: now() },
      {
        name: shaped.value.name,
        url: shaped.value.url,
        ...(shaped.value.username === undefined ? {} : { username: shaped.value.username }),
        ...(shaped.value.password === undefined ? {} : { password: shaped.value.password }),
        allowLan: shaped.value.allow_lan,
        allowHttp: shaped.value.allow_http,
        subfolders: shaped.value.subfolders,
      },
    );
    if (!added.ok) {
      const reason =
        added.switches === undefined
          ? added.message
          : `That address needs ${added.switches.map((option) => `“${networkAccessLabel(option)}”`).join(' and ')} turned on below.`;
      return c.html(addPage(c, echo, reason), 400);
    }
    return savedRedirect(c, '/admin/photos', 'folder-added');
  });

  app.post('/admin/photos/folders/:id/remove', (c: Context) =>
    removeFolder(deps.db, deps.dataDir, c.req.param('id') ?? '')
      ? savedRedirect(c, '/admin/photos', 'folder-removed')
      : c.redirect('/admin/photos', 302),
  );

  function addPage(
    c: Context,
    echo: { name?: string; url?: string; username?: string; subfolders?: boolean; allowLan?: boolean; allowHttp?: boolean },
    error?: string,
  ): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add a folder — Maverick Wall',
      nav: 'photos',
      heading: 'Add a folder from your NAS',
      back: { label: 'Photos', href: 'admin/photos' },
      intro:
        'Any folder your NAS shares over WebDAV: a Synology, a QNAP, Nextcloud, or a computer sharing a folder. ' +
        'The photos stay where they are.',
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/photos/folders">` +
        textField({ label: 'Name', name: 'name', required: true, value: echo.name ?? '', placeholder: 'Holidays' }) +
        textField({
          label: 'Folder address',
          name: 'url',
          required: true,
          value: echo.url ?? '',
          placeholder: 'http://192.168.1.10:5005/photo/Holidays',
          attrs: 'autocomplete="off" spellcheck="false"',
        }) +
        `<p class="hint">On a Synology, turn on the WebDAV Server package and use its port (5005, or 5006 for https) ` +
        `with the shared folder’s name. On Nextcloud it is https://your.server/remote.php/dav/files/you/Photos.</p>` +
        textField({ label: 'Username (if it asks for one)', name: 'username', value: echo.username ?? '', attrs: 'autocomplete="off"' }) +
        textField({ label: 'Password', name: 'password', type: 'password', attrs: 'autocomplete="new-password"' }) +
        `<p class="hint">Kept sealed on this box and used only to read this folder. An account that can only read it is best.</p>` +
        switchRow({
          label: 'Include the folders inside it',
          name: 'subfolders',
          checked: echo.subfolders ?? false,
          hint: 'Up to three folders deep.',
        }) +
        switchRow({
          label: networkAccessLabel('allowPrivateNetwork'),
          name: 'allow_lan',
          checked: echo.allowLan ?? false,
          hint: 'A NAS is usually on your own network — this machine included.',
        }) +
        switchRow({
          label: networkAccessLabel('allowHttp'),
          name: 'allow_http',
          checked: echo.allowHttp ?? false,
          hint: 'The password travels unencrypted. Only for a NAS on your own network.',
        }) +
        `<div class="row"><button type="submit">Add folder</button></div></form>`,
    });
  }
}

/** What a wall leaves out of a folder, said once, by kind. */
export function skippedSentence(row: Pick<FolderRow, 'skippedHeic' | 'skippedRaw' | 'skippedLarge'>): string | undefined {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  if (row.skippedHeic > 0) parts.push(plural(row.skippedHeic, 'HEIC photo', 'HEIC photos'));
  if (row.skippedRaw > 0) parts.push(plural(row.skippedRaw, 'RAW file', 'RAW files'));
  if (row.skippedLarge > 0) parts.push(plural(row.skippedLarge, 'picture over 10 MB', 'pictures over 10 MB'));
  if (parts.length === 0) return undefined;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const total = row.skippedHeic + row.skippedRaw + row.skippedLarge;
  return `${list} left out: walls cannot show ${total === 1 ? 'it' : 'them'}. Save as JPEG to include ${total === 1 ? 'it' : 'them'}.`;
}

/** The NAS folders section of the Photos screen. */
export function folderSection(db: AdminDeps['db']): string {
  const folders = readFolders(db);
  return section(
    'From a folder on your NAS',
    'A folder your NAS shares over WebDAV, shown by an Image widget as a slideshow without copying it here.',
    (folders.length === 0
      ? emptyState('No folders yet.', { label: 'Add a folder', href: 'admin/photos/folders/new' })
      : folders
          .map((folder) => {
            const skipped = skippedSentence(folder);
            return card(
              listRow(
                '',
                {
                  title: folder.name,
                  detail: `${folder.host}${folder.username === null ? '' : ` · as ${folder.username}`} · ${folder.count} photo${folder.count === 1 ? '' : 's'}`,
                },
                folder.lastError === null ? '' : tag('Problem', 'danger'),
              ) +
                (folder.lastError === null ? '' : errorBlock(folder.lastError, 'The photos it had are still shown.')) +
                (skipped === undefined ? '' : `<p class="hint">${escapeHtml(skipped)}</p>`) +
                `<form method="post" action="admin/photos/folders/${escapeHtml(folder.id)}/remove">` +
                `<button class="secondary" type="submit" aria-label="Remove ${escapeHtml(folder.name)}">Remove</button></form>`,
              folder.lastError === null ? {} : { tone: 'danger' },
            );
          })
          .join('') + `<p><a class="btn btn-ghost" href="admin/photos/folders/new">Add a folder</a></p>`),
  );
}
