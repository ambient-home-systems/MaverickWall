import { FETCH_LIMITS, requiredNetworkOptions, type FetchOutcome, type Fetcher, type NetworkOption, type UrlPolicy } from '@maverick-wall/core';
import { DAV_NS, prop, readMultistatus, type DavResponse } from '../../caldav/multistatus.js';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';

/**
 * A folder of photos on the household's own NAS, over WebDAV (plan item M3.3).
 *
 * Two requests, both reads: `PROPFIND` to list a folder, and `GET` for one
 * photo. The listing goes through the multistatus reader CalDAV already uses
 * (`caldav/multistatus.ts`), so a Synology, a Nextcloud and an Apache
 * `mod_dav` are read by the code that already reads SabreDAV, prefixes and
 * all.
 *
 * **A server's hrefs are followed only inside the folder.** A listing names
 * its entries by path, and this sends a password to whatever it names; a href
 * on another host, or above the folder, would be a server choosing where the
 * household's password goes. So every href is resolved against the folder and
 * kept only when it is on the same origin and under the folder's own path.
 *
 * **What a wall cannot show is counted, and named.** A HEIC photo, a camera's
 * RAW file and a picture over the fetch ceiling are left out of the slideshow
 * — a tablet draws none of them — and the Photos screen says how many of each,
 * rather than a household wondering why half their folder never appears.
 */

export interface FolderEndpoint {
  /** The folder's address, ending in `/`. */
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly policy: UrlPolicy;
}

export function folderPolicy(row: { readonly allowLan: boolean; readonly allowHttp: boolean }): UrlPolicy {
  return { allowHttp: row.allowHttp, allowPrivateNetwork: row.allowLan, allowLoopback: row.allowLan };
}

/** A folder's address with exactly one trailing slash, which is what a collection's href ends in. */
export function folderUrl(typed: string): string {
  return `${typed.trim().replace(/\/+$/, '')}/`;
}

/** A slideshow's worth, as an album's is. */
export const MAX_FOLDER_PHOTOS = 500;
/** How deep "and the folders inside it" goes, and how many folders it reads in all. */
export const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDERS = 50;

const PHOTO_TYPES = /^image\/(jpeg|png|gif|webp)$/;
const PHOTO_NAMES = /\.(jpe?g|png|gif|webp)$/i;
const HEIC_NAMES = /\.(heic|heif|avif)$/i;
const HEIC_TYPES = /^image\/(heic|heif|avif)/;
const RAW_NAMES = /\.(cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|mrw)$/i;

export interface FolderPhoto {
  /** The photo's path on the server, as resolved under the folder. */
  readonly path: string;
  readonly etag: string | undefined;
}

export interface FolderListing {
  readonly photos: readonly FolderPhoto[];
  readonly heic: number;
  readonly raw: number;
  readonly tooLarge: number;
}

export type FolderFailure = {
  readonly ok: false;
  readonly message: string;
  readonly switches?: readonly NetworkOption[];
};
export type FolderResult<T> = { readonly ok: true; readonly value: T } | FolderFailure;

function authorization(endpoint: FolderEndpoint): Record<string, string> {
  if (endpoint.username === undefined || endpoint.username === '') return {};
  const pair = `${endpoint.username}:${endpoint.password ?? ''}`;
  return { authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}` };
}

/** Why a request did not work, for somebody standing in a kitchen. */
function failure(outcome: FetchOutcome, endpoint: FolderEndpoint, url: string): FolderFailure {
  if (outcome.status === 'rejected') {
    const options = [...(outcome.networkOptions ?? []), ...requiredNetworkOptions(url, endpoint.policy)];
    const switches: NetworkOption[] = [
      ...(options.includes('allowHttp') ? (['allowHttp'] as const) : []),
      ...(options.includes('allowPrivateNetwork') || options.includes('allowLoopback') ? (['allowPrivateNetwork'] as const) : []),
    ];
    if (switches.length > 0) {
      return { ok: false, switches, message: 'That address is on your own network or is plain http, which has to be allowed first.' };
    }
    if (outcome.code === 'dns-failed') return { ok: false, message: 'That name could not be found. Check the address for a typo.' };
    return { ok: false, message: 'That is not an address a folder can be read from.' };
  }
  if (outcome.status === 'failed') {
    if (outcome.code === 'http-error') {
      const status = outcome.httpStatus ?? 0;
      if (status === 401) {
        return endpoint.username === undefined || endpoint.username === ''
          ? { ok: false, message: 'That folder needs a username and password.' }
          : { ok: false, message: 'That username and password were not accepted.' };
      }
      if (status === 403) return { ok: false, message: 'That account is not allowed to read that folder.' };
      if (status === 404) return { ok: false, message: 'There is no folder at that address. Check the path.' };
      if (status === 405 || status === 501) return { ok: false, message: notWebDav };
      return { ok: false, message: `The server refused it (${status}). It will be tried again.` };
    }
    if (outcome.code === 'too-large') return { ok: false, message: 'That folder has too many files to list. Choose a smaller one.' };
    if (outcome.code === 'unacceptable-content-type') return { ok: false, message: notWebDav };
    if (outcome.code === 'timeout') return { ok: false, message: 'The server did not answer in time. It will be tried again.' };
    return { ok: false, message: 'The server could not be reached. It will be tried again.' };
  }
  return { ok: false, message: 'The server could not be reached. It will be tried again.' };
}

const notWebDav =
  'That address answered, but not as a WebDAV folder. On a Synology it is the WebDAV Server package’s port; ' +
  'on Nextcloud it looks like https://your.server/remote.php/dav/files/you/Photos.';

const LIST_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<D:propfind xmlns:D="DAV:">\n` +
  `  <D:prop><D:resourcetype/><D:getcontenttype/><D:getcontentlength/><D:getetag/></D:prop>\n` +
  `</D:propfind>\n`;

/** Is this listing entry a folder? */
function isCollection(response: DavResponse): boolean {
  return prop(response, DAV_NS, 'resourcetype')?.children.some((child) => child.namespace === DAV_NS && child.localName === 'collection') === true;
}

/** One folder's entries, its own href aside. */
async function listOne(fetcher: Fetcher, endpoint: FolderEndpoint, url: string): Promise<FolderResult<{ base: string; responses: readonly DavResponse[] }>> {
  const outcome = await fetcher.fetch({
    url,
    policy: endpoint.policy,
    method: 'PROPFIND',
    body: LIST_BODY,
    bodyType: 'xml',
    maxBytes: FETCH_LIMITS.dav,
    timeoutMs: 30_000,
    acceptContentTypes: ['application/xml', 'text/xml'],
    userAgent: DEFAULT_USER_AGENT,
    headers: { ...authorization(endpoint), depth: '1' },
  });
  if (outcome.status !== 'ok') return failure(outcome, endpoint, url);
  const read = readMultistatus(outcome.body);
  if (!read.ok) return { ok: false, message: read.error.code === 'too-large' ? 'That folder has too many files to list. Choose a smaller one.' : notWebDav };
  return { ok: true, value: { base: outcome.finalUrl, responses: read.responses } };
}

/**
 * Where a href points, as a path under the folder, or nothing when it points
 * anywhere else: another origin, or above the folder the household chose.
 */
export function insideFolder(href: string, base: string, folder: string): string | undefined {
  let target: URL;
  let root: URL;
  try {
    target = new URL(href, base);
    root = new URL(folder);
  } catch {
    return undefined;
  }
  if (target.origin !== root.origin) return undefined;
  const path = target.pathname;
  if (!path.startsWith(root.pathname)) return undefined;
  // `..` cannot survive URL parsing, but an encoded one can, and is refused.
  if (/%2e%2e|%2f/i.test(path)) return undefined;
  return path;
}

/** The last segment of a path, decoded, for the name a file goes by. */
function fileName(path: string): string {
  const segment = path.replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Every photo a wall can show in a folder — and, when asked, the folders
 * inside it — in the order of their names, with what was left out counted.
 */
export async function listFolder(
  fetcher: Fetcher,
  endpoint: FolderEndpoint,
  subfolders: boolean,
): Promise<FolderResult<FolderListing>> {
  const root = new URL(endpoint.url);
  const queue: { url: string; depth: number }[] = [{ url: endpoint.url, depth: 0 }];
  const seen = new Set<string>([root.pathname]);
  const photos: FolderPhoto[] = [];
  let heic = 0;
  let raw = 0;
  let tooLarge = 0;
  let read = 0;
  while (queue.length > 0 && read < MAX_FOLDERS) {
    const next = queue.shift();
    if (next === undefined) break;
    read++;
    const listed = await listOne(fetcher, endpoint, next.url);
    if (!listed.ok) {
      // The folder itself failing is the answer; a subfolder failing costs that subfolder.
      if (next.depth === 0) return listed;
      continue;
    }
    for (const response of listed.value.responses) {
      const path = insideFolder(response.href, listed.value.base, endpoint.url);
      if (path === undefined) continue;
      if (isCollection(response)) {
        const key = path.endsWith('/') ? path : `${path}/`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (subfolders && next.depth + 1 <= MAX_FOLDER_DEPTH) queue.push({ url: `${root.origin}${key}`, depth: next.depth + 1 });
        continue;
      }
      const name = fileName(path);
      const type = (prop(response, DAV_NS, 'getcontenttype')?.text ?? '').toLowerCase();
      const size = Number(prop(response, DAV_NS, 'getcontentlength')?.text ?? '');
      if (HEIC_NAMES.test(name) || HEIC_TYPES.test(type)) {
        heic++;
        continue;
      }
      if (RAW_NAMES.test(name)) {
        raw++;
        continue;
      }
      if (!PHOTO_NAMES.test(name) && !PHOTO_TYPES.test(type)) continue;
      if (Number.isFinite(size) && size > FETCH_LIMITS.image) {
        tooLarge++;
        continue;
      }
      const etag = prop(response, DAV_NS, 'getetag')?.text;
      photos.push({ path, etag: etag === undefined || etag === '' ? undefined : etag });
    }
  }
  photos.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true, sensitivity: 'base' }));
  return { ok: true, value: { photos: photos.slice(0, MAX_FOLDER_PHOTOS), heic, raw, tooLarge } };
}

/** One photo's bytes, from a path the listing kept under the folder. */
export async function photoBytes(fetcher: Fetcher, endpoint: FolderEndpoint, path: string): Promise<FolderResult<Buffer>> {
  const url = `${new URL(endpoint.url).origin}${path}`;
  if (insideFolder(url, url, endpoint.url) === undefined) return { ok: false, message: 'That is not in the folder.' };
  const outcome = await fetcher.fetch({
    url,
    policy: endpoint.policy,
    maxBytes: FETCH_LIMITS.image,
    timeoutMs: 60_000,
    userAgent: DEFAULT_USER_AGENT,
    headers: authorization(endpoint),
    bodyEncoding: 'base64',
  });
  if (outcome.status !== 'ok') return failure(outcome, endpoint, url);
  return { ok: true, value: Buffer.from(outcome.body, 'base64') };
}
