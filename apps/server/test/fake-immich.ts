import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';

/**
 * A stand-in for Immich (plan item M3.2), on loopback, built from Immich's own
 * OpenAPI description (3.3.0-rc.0) rather than from memory.
 *
 * - Every route needs the key in `x-api-key`; a wrong one is a 401 with
 *   Immich's own error body.
 * - `GET /api/albums` answers `AlbumResponseDto`s with no assets in them, as
 *   current Immich does, so an album's photos can only be found by searching.
 * - `POST /api/search/metadata` takes `albumIds`, `personIds`, `isFavorite` and
 *   `type`, refuses a body that is not labelled JSON, and pages two ways:
 *   `page`/`nextPage` as before 3.2, or `cursor`/`nextCursor` as after.
 * - `GET /api/memories?for=` answers the day's memories with their assets,
 *   unless it is set to be an Immich too old to have the route.
 * - `GET /api/assets/{id}/thumbnail?size=preview` answers a real PNG.
 *
 * Every request is recorded, so a test can say what left the server.
 */

export interface FakeAsset {
  readonly id: string;
  readonly type: 'IMAGE' | 'VIDEO';
  readonly albums: readonly string[];
  readonly people: readonly string[];
  readonly favourite: boolean;
  /** What Immich says the photo measures; 4032x3024 when not said. */
  readonly width?: number | null;
  readonly height?: number | null;
  /** The preview's own size, when the test needs a particular shape. */
  readonly preview?: { readonly width: number; readonly height: number };
}

export interface FakeImmich {
  readonly base: string;
  key: string;
  readonly albums: { id: string; albumName: string }[];
  readonly people: { id: string; name: string; isHidden: boolean }[];
  readonly assets: FakeAsset[];
  /** The memories for any day asked about: asset ids. */
  memories: string[];
  /** Page by cursor, as Immich 3.2 and later do, instead of by page number. */
  cursors: boolean;
  /** An Immich from before memories existed: the route is a 404. */
  noMemories: boolean;
  pageSize: number;
  /** A status every request answers with instead, while set. */
  failWith: number | undefined;
  readonly requests: { method: string; path: string; query: string; contentType: string | undefined; body: string; key: string | undefined }[];
  close(): Promise<void>;
}

export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `0b5a3c1e-4d2f-4a6b-9c8d-${hex}`;
}

function picture(seed: number): Buffer {
  const fb = new Framebuffer(30 + (seed % 50), 20);
  for (let x = 0; x < fb.width; x += (seed % 5) + 2) for (let y = 0; y < 20; y++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

export async function fakeImmich(key = 'immich-test-key-0123456789abcdefghij'): Promise<FakeImmich> {
  const state = {
    base: '',
    key,
    albums: [] as FakeImmich['albums'],
    people: [] as FakeImmich['people'],
    assets: [] as FakeAsset[],
    memories: [] as string[],
    cursors: true,
    noMemories: false,
    pageSize: 250,
    failWith: undefined as number | undefined,
    requests: [] as FakeImmich['requests'],
  };
  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const assetDto = (asset: FakeAsset): Record<string, unknown> => ({
    id: asset.id,
    type: asset.type,
    checksum: 'abc',
    createdAt: '2026-07-01T10:00:00.000Z',
    duration: asset.type === 'VIDEO' ? '0:00:12.000' : '0:00:00.00000',
    fileCreatedAt: '2026-07-01T10:00:00.000Z',
    fileModifiedAt: '2026-07-01T10:00:00.000Z',
    hasMetadata: true,
    height: asset.height === undefined ? 3024 : asset.height,
    width: asset.width === undefined ? 4032 : asset.width,
    isArchived: false,
    isEdited: false,
    isFavorite: asset.favourite,
    isOffline: false,
    isTrashed: false,
    localDateTime: '2026-07-01T11:00:00.000Z',
    originalFileName: `IMG_${asset.id.slice(-4)}.jpg`,
    originalPath: `/usr/src/app/upload/library/admin/2026/IMG_${asset.id.slice(-4)}.jpg`,
    ownerId: uuid(999),
    thumbhash: 'abc',
    updatedAt: '2026-07-01T10:00:00.000Z',
    visibility: 'timeline',
  });

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const presented = request.headers['x-api-key'];
      state.requests.push({
        method: request.method ?? '',
        path: url.pathname,
        query: url.search,
        contentType: request.headers['content-type'],
        body,
        key: typeof presented === 'string' ? presented : undefined,
      });
      if (presented !== state.key) {
        send(response, 401, { message: 'Invalid API key', error: 'Unauthorized', statusCode: 401, correlationId: 'x' });
        return;
      }
      if (state.failWith !== undefined) {
        send(response, state.failWith, { message: 'Failed', statusCode: state.failWith });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/users/me') {
        send(response, 200, { id: uuid(999), email: 'jane@example.com', name: 'Jane', isAdmin: true, status: 'active' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/albums') {
        send(
          response,
          200,
          state.albums.map((album) => ({
            id: album.id,
            albumName: album.albumName,
            albumThumbnailAssetId: null,
            albumUsers: [],
            assetCount: state.assets.filter((asset) => asset.albums.includes(album.id)).length,
            createdAt: '2026-07-01T10:00:00.000Z',
            description: '',
            hasSharedLink: false,
            isActivityEnabled: true,
            shared: false,
            updatedAt: '2026-07-01T10:00:00.000Z',
          })),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/people') {
        const withHidden = url.searchParams.get('withHidden') === 'true';
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Number(url.searchParams.get('size') ?? 500);
        const all = state.people.filter((one) => withHidden || !one.isHidden);
        const slice = all.slice((page - 1) * size, page * size);
        send(response, 200, {
          people: slice.map((one) => ({ ...one, birthDate: null, thumbnailPath: '/x', updatedAt: '2026-07-01T10:00:00.000Z' })),
          hasNextPage: page * size < all.length,
          hidden: state.people.filter((one) => one.isHidden).length,
          total: all.length,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/search/metadata') {
        if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
          send(response, 400, { message: ['body must be an object'], error: 'Bad Request', statusCode: 400 });
          return;
        }
        const dto = JSON.parse(body) as {
          albumIds?: string[];
          personIds?: string[];
          isFavorite?: boolean;
          type?: string;
          size?: number;
          page?: number;
          cursor?: string;
        };
        const matches = state.assets.filter(
          (asset) =>
            (dto.albumIds === undefined || dto.albumIds.every((id) => asset.albums.includes(id))) &&
            (dto.personIds === undefined || dto.personIds.every((id) => asset.people.includes(id))) &&
            (dto.isFavorite === undefined || asset.favourite === dto.isFavorite) &&
            (dto.type === undefined || asset.type === dto.type),
        );
        const size = Math.min(dto.size ?? 250, state.pageSize);
        const start = state.cursors && dto.cursor !== undefined ? Number(Buffer.from(dto.cursor, 'base64').toString()) : ((dto.page ?? 1) - 1) * size;
        const items = matches.slice(start, start + size);
        const more = start + size < matches.length;
        send(response, 200, {
          albums: { count: 0, facets: [], items: [], nextPage: null, total: 0 },
          assets: {
            count: items.length,
            facets: [],
            items: items.map(assetDto),
            total: matches.length,
            nextPage: !state.cursors && more ? String((dto.page ?? 1) + 1) : null,
            nextCursor: state.cursors && more ? Buffer.from(String(start + size)).toString('base64') : null,
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/memories') {
        if (state.noMemories) {
          send(response, 404, { message: 'Cannot GET /api/memories', error: 'Not Found', statusCode: 404 });
          return;
        }
        send(
          response,
          200,
          state.memories.length === 0
            ? []
            : [
                {
                  id: uuid(500),
                  type: 'on_this_day',
                  data: { year: 2021 },
                  assets: state.assets.filter((asset) => state.memories.includes(asset.id)).map(assetDto),
                  createdAt: '2026-07-01T10:00:00.000Z',
                  isSaved: false,
                  memoryAt: `${url.searchParams.get('for')}T00:00:00.000Z`,
                  ownerId: uuid(999),
                  updatedAt: '2026-07-01T10:00:00.000Z',
                },
              ],
        );
        return;
      }
      const thumb = /^\/api\/assets\/([0-9a-f-]{36})\/thumbnail$/.exec(url.pathname);
      if (request.method === 'GET' && thumb !== null) {
        const index = state.assets.findIndex((asset) => asset.id === thumb[1]);
        if (index === -1) {
          send(response, 404, { message: 'Asset not found', statusCode: 404 });
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        const shape = state.assets[index]?.preview;
        if (shape === undefined) response.end(picture(index));
        else {
          const fb = new Framebuffer(shape.width, shape.height);
          fb.set(0, 0);
          response.end(Buffer.from(encodePng1bit(fb)));
        }
        return;
      }
      send(response, 404, { message: `Cannot ${request.method} ${url.pathname}`, statusCode: 404 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return Object.assign(state, { close: () => new Promise<void>((resolve) => server.close(() => resolve())) }) as FakeImmich;
}
