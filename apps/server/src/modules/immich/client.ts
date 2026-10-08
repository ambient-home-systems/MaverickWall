import { FETCH_LIMITS, requiredNetworkOptions, type FetchOutcome, type Fetcher, type NetworkOption, type UrlPolicy } from '@maverick-wall/core';
import { parseJsonOr, z } from '../../validation.js';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';

/**
 * Immich's API, as much of it as a slideshow needs (plan item M3.2).
 *
 * Six calls, all reads: who the key belongs to, the albums, the people, the
 * day's memories, a search for the photos in an album, of a person or marked
 * favourite, and one photo's preview. The search is a `POST` because that is
 * how Immich takes a search, and it is the only one: its path is
 * `SEARCH_PATH`, a constant, and `ha-write-boundary.test.ts` holds it there.
 *
 * Read from Immich's own OpenAPI description (3.3.0-rc.0), and written to the
 * shapes both sides of its 3.2 change accept: the search pages by `page` and
 * answers `nextPage` before 3.2, and by `cursor` and `nextCursor` after it, so
 * this sends the first and follows whichever comes back. Album contents are
 * read through the search, which every version since 1.x has offered, because
 * current Immich no longer lists an album's photos with the album.
 *
 * Every request goes through the SSRF-guarded fetcher with the household's own
 * two switches, and the key travels in `x-api-key`, never in an address.
 */

export interface ImmichEndpoint {
  /** The server's address, as typed, without a trailing slash or `/api`. */
  readonly base: string;
  readonly key: string;
  readonly policy: UrlPolicy;
}

/** The household's two switches, as a fetch policy. A local address includes this machine, as a webhook's does. */
export function immichPolicy(row: { readonly allowLan: boolean; readonly allowHttp: boolean }): UrlPolicy {
  return { allowHttp: row.allowHttp, allowPrivateNetwork: row.allowLan, allowLoopback: row.allowLan };
}

/**
 * The address a household types, made the base every call builds on: no
 * trailing slash, and no `/api`, which Immich's own pages show beside the
 * address and people paste with it.
 */
export function immichBase(typed: string): string {
  return typed.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

export const SEARCH_PATH = '/api/search/metadata';
/** Enough photos for a slideshow to never feel like a loop, few enough that the manifest stays small. */
export const MAX_PHOTOS = 500;
const PAGE_SIZE = 250;
const MAX_PAGES = 20;

export type ImmichFailure = {
  readonly ok: false;
  readonly message: string;
  /** The switches an address needs and does not have, when that is the trouble. */
  readonly switches?: readonly NetworkOption[];
  readonly status?: number;
};
export type ImmichResult<T> = { readonly ok: true; readonly value: T } | ImmichFailure;

const UUID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

/** Why a call did not work, said for somebody standing in a kitchen. */
function failure(outcome: FetchOutcome, endpoint: ImmichEndpoint, url: string): ImmichFailure {
  if (outcome.status === 'rejected') {
    const options = [...(outcome.networkOptions ?? []), ...requiredNetworkOptions(url, endpoint.policy)];
    const switches: NetworkOption[] = [
      ...(options.includes('allowHttp') ? (['allowHttp'] as const) : []),
      ...(options.includes('allowPrivateNetwork') || options.includes('allowLoopback') ? (['allowPrivateNetwork'] as const) : []),
    ];
    if (switches.length > 0) {
      return {
        ok: false,
        switches,
        message: 'That address is on your own network or is plain http, which has to be allowed first. Tick the switches below.',
      };
    }
    if (outcome.code === 'dns-failed') return { ok: false, message: 'That name could not be found. Check the address for a typo.' };
    return { ok: false, message: 'That is not an address Immich can be reached at. It looks like http://192.168.1.10:2283.' };
  }
  if (outcome.status === 'failed') {
    if (outcome.code === 'http-error') {
      const status = outcome.httpStatus ?? 0;
      if (status === 401) return { ok: false, status, message: 'Immich did not accept that API key. Make a new one in Immich: Account Settings › API Keys.' };
      if (status === 403) {
        return {
          ok: false,
          status,
          message:
            'That API key is not allowed to read your photos. Give it these permissions in Immich, or All: ' +
            'user.read, album.read, person.read, memory.read, asset.read and asset.view.',
        };
      }
      if (status === 404) {
        return { ok: false, status, message: 'That address answered, but not as Immich. Check the port: Immich is usually on 2283.' };
      }
      return { ok: false, status, message: `Immich refused it (${status}). It will be tried again.` };
    }
    if (outcome.code === 'timeout') return { ok: false, message: 'Immich did not answer in time. It will be tried again.' };
    if (outcome.code === 'unacceptable-content-type') {
      return { ok: false, message: 'That address answered, but not as Immich. Check the port: Immich is usually on 2283.' };
    }
    return { ok: false, message: 'Immich could not be reached. It will be tried again.' };
  }
  return { ok: false, message: 'Immich could not be reached. It will be tried again.' };
}

async function getJson(fetcher: Fetcher, endpoint: ImmichEndpoint, path: string): Promise<ImmichResult<unknown>> {
  const url = `${endpoint.base}${path}`;
  const outcome = await fetcher.fetch({
    url,
    policy: endpoint.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 20_000,
    acceptContentTypes: ['application/json'],
    userAgent: DEFAULT_USER_AGENT,
    headers: { 'x-api-key': endpoint.key },
  });
  if (outcome.status !== 'ok') return failure(outcome, endpoint, url);
  return { ok: true, value: parseJsonOr(z.unknown(), outcome.body, undefined) };
}

/** The search: the one POST, to the one path. */
async function search(fetcher: Fetcher, endpoint: ImmichEndpoint, body: Record<string, unknown>): Promise<ImmichResult<unknown>> {
  const url = `${endpoint.base}${SEARCH_PATH}`;
  const outcome = await fetcher.fetch({
    url,
    policy: endpoint.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 30_000,
    acceptContentTypes: ['application/json'],
    userAgent: DEFAULT_USER_AGENT,
    headers: { 'x-api-key': endpoint.key },
    method: 'POST',
    body: JSON.stringify(body),
    bodyType: 'json',
  });
  if (outcome.status !== 'ok') return failure(outcome, endpoint, url);
  return { ok: true, value: parseJsonOr(z.unknown(), outcome.body, undefined) };
}

const me = z.object({ name: z.string().max(200).optional().catch(undefined), email: z.string().max(200).optional().catch(undefined) });

/** Who the key belongs to: the check a connection makes before it is kept, and the name shown beside it. */
export async function whoAmI(fetcher: Fetcher, endpoint: ImmichEndpoint): Promise<ImmichResult<string>> {
  const read = await getJson(fetcher, endpoint, '/api/users/me');
  if (!read.ok) return read;
  const shaped = me.safeParse(read.value);
  if (!shaped.success || (shaped.data.name === undefined && shaped.data.email === undefined)) {
    return { ok: false, message: 'That address answered, but not as Immich. Check the port: Immich is usually on 2283.' };
  }
  return { ok: true, value: shaped.data.name !== undefined && shaped.data.name !== '' ? shaped.data.name : (shaped.data.email ?? '') };
}

export interface ImmichChoice {
  readonly id: string;
  readonly name: string;
  readonly count?: number;
}

const album = z.object({ id: UUID, albumName: z.string().max(500), assetCount: z.number().int().nonnegative().optional().catch(undefined) });

export async function listAlbums(fetcher: Fetcher, endpoint: ImmichEndpoint): Promise<ImmichResult<ImmichChoice[]>> {
  const read = await getJson(fetcher, endpoint, '/api/albums');
  if (!read.ok) return read;
  if (!Array.isArray(read.value)) return { ok: false, message: 'Immich answered with something that is not a list of albums.' };
  const out: ImmichChoice[] = [];
  for (const raw of read.value) {
    const one = album.safeParse(raw);
    if (!one.success) continue;
    out.push({ id: one.data.id, name: one.data.albumName || 'Untitled album', ...(one.data.assetCount === undefined ? {} : { count: one.data.assetCount }) });
  }
  return { ok: true, value: out };
}

const people = z.object({
  people: z.array(z.unknown()).catch([]),
  hasNextPage: z.boolean().optional().catch(undefined),
});
const person = z.object({ id: UUID, name: z.string().max(200) });

/** The people Immich has a name for and shows: an unnamed face is nobody a household can choose. */
export async function listPeople(fetcher: Fetcher, endpoint: ImmichEndpoint): Promise<ImmichResult<ImmichChoice[]>> {
  const out: ImmichChoice[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const read = await getJson(fetcher, endpoint, `/api/people?withHidden=false&size=500&page=${page}`);
    if (!read.ok) return read;
    const shaped = people.safeParse(read.value);
    if (!shaped.success) return { ok: false, message: 'Immich answered with something that is not a list of people.' };
    for (const raw of shaped.data.people) {
      const one = person.safeParse(raw);
      // Hidden people are left out by the request itself (`withHidden=false`).
      if (one.success && one.data.name.trim() !== '') out.push({ id: one.data.id, name: one.data.name });
    }
    if (shaped.data.hasNextPage !== true) break;
  }
  return { ok: true, value: out };
}

const side = z.number().int().positive().max(65_535).nullish().catch(undefined);
const asset = z.object({ id: UUID, type: z.string().max(20).optional().catch(undefined), width: side, height: side });

/**
 * Immich's own idea of each photo's size, by asset id, collected as a list is
 * read (plan item M3.7): a first guess at which photos are portrait, replaced
 * by the preview's own header once it has been fetched.
 */
export type ImmichShapes = Map<string, { readonly width: number; readonly height: number }>;
const searchPage = z.object({
  assets: z.object({
    items: z.array(z.unknown()).catch([]),
    nextPage: z.union([z.string(), z.number()]).nullish().catch(undefined),
    nextCursor: z.string().nullish().catch(undefined),
  }),
});

/** Photo ids out of a list of assets; a video, or anything that is not one, is left out. */
function photoIds(items: readonly unknown[], shapes?: ImmichShapes): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const one = asset.safeParse(raw);
    if (!one.success || (one.data.type !== undefined && one.data.type !== 'IMAGE')) continue;
    out.push(one.data.id);
    const { width, height } = one.data;
    if (shapes !== undefined && typeof width === 'number' && typeof height === 'number') shapes.set(one.data.id, { width, height });
  }
  return out;
}

export type ImmichFilter =
  | { readonly albumIds: readonly string[] }
  | { readonly personIds: readonly string[] }
  | { readonly isFavorite: true };

/** The photos a filter finds, newest first as Immich orders them, up to `MAX_PHOTOS`. */
export async function searchPhotos(
  fetcher: Fetcher,
  endpoint: ImmichEndpoint,
  filter: ImmichFilter,
  shapes?: ImmichShapes,
): Promise<ImmichResult<string[]>> {
  const out: string[] = [];
  let next: { page?: number; cursor?: string } = { page: 1 };
  for (let round = 0; round < MAX_PAGES && out.length < MAX_PHOTOS; round++) {
    const read = await search(fetcher, endpoint, { ...filter, type: 'IMAGE', size: PAGE_SIZE, ...next });
    if (!read.ok) return read;
    const shaped = searchPage.safeParse(read.value);
    if (!shaped.success) return { ok: false, message: 'Immich answered the search with something this cannot read.' };
    for (const id of photoIds(shaped.data.assets.items, shapes)) if (!out.includes(id)) out.push(id);
    const cursor = shaped.data.assets.nextCursor;
    const page = shaped.data.assets.nextPage;
    if (typeof cursor === 'string' && cursor !== '') next = { cursor };
    else if (page !== null && page !== undefined && Number.isInteger(Number(page))) next = { page: Number(page) };
    else break;
  }
  return { ok: true, value: out.slice(0, MAX_PHOTOS) };
}

const memory = z.object({ assets: z.array(z.unknown()).catch([]) });

/** The photos in the memories Immich has for a day — "on this day", years ago. */
export async function memoryPhotos(
  fetcher: Fetcher,
  endpoint: ImmichEndpoint,
  day: string,
  shapes?: ImmichShapes,
): Promise<ImmichResult<string[]>> {
  const read = await getJson(fetcher, endpoint, `/api/memories?for=${encodeURIComponent(day)}`);
  if (!read.ok) {
    return read.status === 404
      ? { ok: false, status: 404, message: 'This Immich is too old to have memories. Update it, or choose an album instead.' }
      : read;
  }
  if (!Array.isArray(read.value)) return { ok: false, message: 'Immich answered with something that is not a list of memories.' };
  const out: string[] = [];
  for (const raw of read.value) {
    const one = memory.safeParse(raw);
    if (!one.success) continue;
    for (const id of photoIds(one.data.assets, shapes)) if (!out.includes(id)) out.push(id);
  }
  return { ok: true, value: out.slice(0, MAX_PHOTOS) };
}

/**
 * One photo's preview, as bytes: Immich's own JPEG for screens, about 1440
 * pixels on its long side, rather than the original a camera wrote.
 */
export async function previewBytes(fetcher: Fetcher, endpoint: ImmichEndpoint, assetId: string): Promise<ImmichResult<Buffer>> {
  if (!UUID.safeParse(assetId).success) return { ok: false, message: 'That is not an Immich photo.' };
  const url = `${endpoint.base}/api/assets/${assetId}/thumbnail?size=preview`;
  const outcome = await fetcher.fetch({
    url,
    policy: endpoint.policy,
    maxBytes: FETCH_LIMITS.image,
    timeoutMs: 30_000,
    userAgent: DEFAULT_USER_AGENT,
    headers: { 'x-api-key': endpoint.key },
    bodyEncoding: 'base64',
  });
  if (outcome.status !== 'ok') return failure(outcome, endpoint, url);
  return { ok: true, value: Buffer.from(outcome.body, 'base64') };
}
