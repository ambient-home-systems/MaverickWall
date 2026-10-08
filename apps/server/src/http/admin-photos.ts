import type { Context, Hono } from 'hono';

import { imageSize } from '../api/image-size.js';
import { recordShape } from '../api/photo-shapes.js';
import {
  addPhoto,
  createAlbum,
  deleteAlbum,
  MAX_PHOTOS_PER_ALBUM,
  readAlbum,
  readAlbums,
  removePhoto,
  renameAlbum,
  type Album,
} from '../api/photo-albums.js';
import { MAX_PHOTO_BYTES, isStoredName, storeImage } from '../api/media.js';
import { parse, z } from '../validation.js';
import { confirmDestroyPage, errorBlock, escapeHtml, page, textField } from './html.js';
import { destructive, emptyState, listRow, section } from './components.js';
import { readSaved, savedRedirect } from './saved.js';
import { navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';
import { immichSection } from './admin-immich.js';
import { folderSection } from './admin-folders.js';

/**
 * Photo albums, in the admin (plan item M3.1).
 *
 * The household's own pictures, uploaded here into the media store and kept
 * in named albums, for the Image widget's slideshow (M5.12). Everything the media store
 * already promises holds for every file: the type is sniffed from the bytes,
 * SVG is refused, a HEIC photo is named and refused with what to do instead,
 * and the stored name is the content hash, so the same photo in two albums is
 * one file.
 *
 * **Resizing happens in the browser** (MQ2: there is no image library in the
 * image). With scripting on, `photo-upload.js` draws each photo onto a canvas
 * no larger than a wall needs and sends that JPEG — which also leaves behind
 * the location a phone writes into every photo it takes. With scripting off
 * the form still works and sends the files as they are, up to a cap.
 *
 * The photo grid is hand-built rather than a list of rows: a set of pictures
 * to look at is not a card, a row or a table, which is the exception
 * `components.ts` names.
 */

const nameBody = z.object({ name: z.string().trim().min(1, 'Give the album a name.').max(80, 'That name is too long.') });
const ALBUM_ID = /^[0-9a-f]{16}$/;

export function registerPhotoRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/photos', (c: Context) => c.html(albumsPage(c)));
  app.get('/admin/photos/new', (c: Context) => c.html(newAlbumPage(c)));

  app.post('/admin/photos', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(nameBody, body);
    const echo = typeof body['name'] === 'string' ? body['name'].slice(0, 80) : '';
    if (!shaped.ok) return c.html(newAlbumPage(c, echo, shaped.message), 400);
    const created = createAlbum(deps.db, shaped.value.name, now());
    if (!created.ok) return c.html(newAlbumPage(c, echo, created.message), 400);
    return savedRedirect(c, `/admin/photos/${created.id}`, 'album-added');
  });

  app.get('/admin/photos/:id', (c: Context) => {
    const album = albumOf(c);
    return album === undefined ? c.redirect('/admin/photos', 302) : c.html(albumPage(c, album));
  });

  /**
   * Photos into an album, one or many in one submission.
   *
   * Each file is its own outcome: one HEIC among twenty JPEGs costs that one
   * photo and says so by its own name, rather than refusing the twenty or
   * adding them and saying nothing about the one.
   */
  app.post('/admin/photos/:id/upload', async (c: Context) => {
    const album = albumOf(c);
    if (album === undefined) return c.redirect('/admin/photos', 302);
    const body = await c.req.parseBody({ all: true });
    const raw = body['photos'];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((one): one is File => one instanceof File && one.size > 0);
    if (files.length === 0) return c.html(albumPage(c, album, ['Choose one or more photos to add.']), 400);
    const refused: string[] = [];
    let added = 0;
    for (const file of files) {
      const label = file.name === '' ? 'A photo' : file.name.slice(0, 120);
      if (file.size > MAX_PHOTO_BYTES) {
        // Refused before it is read into memory twice over.
        refused.push(`${label}: larger than ${MAX_PHOTO_BYTES / (1024 * 1024)} MB. Shrink it first.`);
        continue;
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const stored = storeImage(deps.db, deps.dataDir, bytes, file.name, 'photo');
      if (!stored.ok) {
        refused.push(`${label}: ${stored.message}${stored.suggestion === undefined ? '' : ` ${stored.suggestion}`}`);
        continue;
      }
      // Its shape, from the bytes in hand, so a slideshow can pair it (plan item M3.7).
      const size = imageSize(bytes);
      if (size !== undefined) recordShape(deps.db, stored.name, size, true, now());
      const put = addPhoto(deps.db, album.id, stored.name, now());
      if (!put.ok) {
        refused.push(`${label}: ${put.message}`);
        continue;
      }
      if (put.added) added++;
    }
    if (refused.length > 0) {
      const fresh = readAlbum(deps.db, album.id) ?? album;
      const lead = added === 0 ? [] : [`${added} photo${added === 1 ? ' was' : 's were'} added.`];
      return c.html(albumPage(c, fresh, [...lead, ...refused]), 400);
    }
    // A token is a claim: photos already in the album are not "added".
    return added === 0
      ? savedRedirect(c, `/admin/photos/${album.id}`, 'photos-already-there')
      : savedRedirect(c, `/admin/photos/${album.id}`, 'photos-added');
  });

  app.post('/admin/photos/:id/remove/:name', (c: Context) => {
    const album = albumOf(c);
    const name = c.req.param('name') ?? '';
    if (album === undefined) return c.redirect('/admin/photos', 302);
    if (!isStoredName(name) || !removePhoto(deps.db, deps.dataDir, album.id, name)) {
      return c.redirect(`/admin/photos/${album.id}`, 302);
    }
    return savedRedirect(c, `/admin/photos/${album.id}`, 'photo-removed');
  });

  app.post('/admin/photos/:id/rename', async (c: Context) => {
    const album = albumOf(c);
    if (album === undefined) return c.redirect('/admin/photos', 302);
    const shaped = parse(nameBody, (await c.req.parseBody()) as Record<string, unknown>);
    if (!shaped.ok) return c.html(albumPage(c, album, [shaped.message]), 400);
    renameAlbum(deps.db, album.id, shaped.value.name, now());
    return savedRedirect(c, `/admin/photos/${album.id}`, 'album-renamed');
  });

  app.get('/admin/photos/:id/delete', (c: Context) => {
    const album = albumOf(c);
    if (album === undefined) return c.redirect('/admin/photos', 302);
    const count = album.photos.length;
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Delete album',
        nav: 'photos',
        heading: `Delete ${album.name}?`,
        intro:
          `The album and its list of ${count} photo${count === 1 ? '' : 's'} are deleted, and any wall showing ` +
          'it stops. A photo is kept if a background, a person or another album still uses it; the rest are ' +
          'deleted from this box. The copies on your phone or computer are untouched.',
        destroyAction: `admin/photos/${album.id}/delete`,
        destroyLabel: 'Delete it',
        cancelAction: `admin/photos/${album.id}`,
      }),
    );
  });

  app.post('/admin/photos/:id/delete', (c: Context) => {
    const album = albumOf(c);
    if (album === undefined) return c.redirect('/admin/photos', 302);
    deleteAlbum(deps.db, deps.dataDir, album.id);
    return savedRedirect(c, '/admin/photos', 'album-removed');
  });

  function albumOf(c: Context): Album | undefined {
    const id = c.req.param('id') ?? '';
    return ALBUM_ID.test(id) ? readAlbum(deps.db, id) : undefined;
  }

  function albumsPage(c: Context): string {
    const albums = readAlbums(deps.db);
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Photos — Maverick Wall',
      nav: 'photos',
      heading: 'Photos',
      saved: readSaved(c),
      action: { label: 'Add an album', href: 'admin/photos/new' },
      intro: 'Your own photos, kept on this box in albums. An Image widget can show an album as a slideshow.',
      body:
        (albums.length === 0
          ? emptyState('No albums yet.', { label: 'Add an album', href: 'admin/photos/new' })
          : albums
              .map((album) =>
                listRow(
                  album.cover === null
                    ? ''
                    : `<img class="photo-cover" src="admin/media/${escapeHtml(album.cover)}" alt="" loading="lazy">`,
                  {
                    title: album.name,
                    detail: album.count === 0 ? 'Empty' : `${album.count} photo${album.count === 1 ? '' : 's'}`,
                    href: `admin/photos/${album.id}`,
                  },
                ),
              )
              .join('')) +
        // Immich, below the household's own albums (plan item M3.2).
        immichSection(deps.db) +
        // And NAS folders (plan item M3.3).
        folderSection(deps.db),
    });
  }

  function newAlbumPage(c: Context, name = '', error?: string): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Add an album — Maverick Wall',
      nav: 'photos',
      heading: 'Add an album',
      back: { label: 'Photos', href: 'admin/photos' },
      body:
        (error === undefined ? '' : errorBlock(error)) +
        `<form method="post" action="admin/photos">` +
        textField({ label: 'Name', name: 'name', required: true, value: name, placeholder: 'Holidays' }) +
        `<div class="row"><button type="submit">Add album</button></div></form>`,
    });
  }

  function albumPage(c: Context, album: Album, problems?: readonly string[]): string {
    const id = album.id;
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${album.name} — Maverick Wall`,
      nav: 'photos',
      heading: album.name,
      back: { label: 'Photos', href: 'admin/photos' },
      saved: readSaved(c),
      body:
        (problems === undefined || problems.length === 0
          ? ''
          : errorBlock(
              problems.length === 1 ? (problems[0] ?? '') : 'Some photos could not be added.',
              problems.length === 1 ? undefined : problems.join(' '),
            )) +
        section(
          'Add photos',
          `JPEG, PNG, WebP or GIF, up to ${MAX_PHOTO_BYTES / (1024 * 1024)} MB each and ` +
            `${MAX_PHOTOS_PER_ALBUM} in an album.`,
          `<form method="post" action="admin/photos/${id}/upload" enctype="multipart/form-data" data-photo-upload>` +
            // Said only where it is true: `photo-upload.js` reveals it, and
            // without script the files are sent as they are.
            `<p class="hint" data-photo-resize hidden>This page makes each photo the right size for a wall before ` +
            `sending it, which also drops the location a phone stores in it.</p>` +
            `<label class="field"><span class="field-label">Photos</span>` +
            `<input class="field-input" type="file" name="photos" accept="image/*" multiple required></label>` +
            `<p class="hint" data-photo-status aria-live="polite"></p>` +
            `<div class="row"><button type="submit">Add photos</button></div></form>`,
        ) +
        section(
          album.photos.length === 0 ? 'No photos yet' : `${album.photos.length} photo${album.photos.length === 1 ? '' : 's'}`,
          undefined,
          album.photos.length === 0
            ? emptyState('Add some above and they appear here.')
            : `<ul class="photo-grid">` +
                album.photos
                  .map((photo) => {
                    const label = photo.originalName ?? 'this photo';
                    return (
                      `<li><img src="admin/media/${escapeHtml(photo.name)}" alt="${escapeHtml(label)}" loading="lazy">` +
                      `<form method="post" action="admin/photos/${id}/remove/${escapeHtml(photo.name)}">` +
                      `<button class="btn-ghost btn-sm" type="submit" aria-label="Remove ${escapeHtml(label)}">Remove</button>` +
                      `</form></li>`
                    );
                  })
                  .join('') +
                `</ul>`,
        ) +
        section(
          'Album',
          undefined,
          `<form method="post" action="admin/photos/${id}/rename">` +
            textField({ label: 'Name', name: 'name', required: true, value: album.name }) +
            `<div class="row"><button class="secondary" type="submit">Rename</button></div></form>` +
            destructive('Delete album', {
              thing: album.name,
              confirmAction: `admin/photos/${id}/delete`,
              variant: 'button',
            }),
        ),
    });
  }
}
