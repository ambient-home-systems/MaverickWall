import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';

/**
 * A stand-in for a NAS sharing a folder over WebDAV (plan item M3.3), on
 * loopback, written to RFC 4918's shapes.
 *
 * `PROPFIND` with `Depth: 1` answers a `207` multistatus naming the folder and
 * its immediate children, in the lowercase `d:` prefix Nextcloud uses and with
 * percent-encoded names, so the reader is held to namespaces rather than to a
 * prefix. A folder asked for without its trailing slash is a `301` to the one
 * with it, as Apache answers. Basic auth on everything when a password is set.
 * `GET` answers a file's bytes. A listing can be made to carry entries a
 * server should never be trusted with: one on another host and one above the
 * folder.
 */

export interface FakeFile {
  readonly bytes: Buffer;
  readonly type: string;
  /** What the listing says the size is, when it is not the bytes' own. */
  readonly claimedSize?: number;
  etag: string;
}

export interface FakeWebDav {
  readonly base: string;
  readonly files: Map<string, FakeFile>;
  username: string | undefined;
  password: string | undefined;
  /** Hrefs added to every listing of this folder path: the ones a server should never be trusted with. */
  readonly strays: Map<string, string[]>;
  failWith: number | undefined;
  /** Answer everything as an ordinary web page does: a 200 of HTML, which is no WebDAV at all. */
  plainWeb: boolean;
  readonly requests: { method: string; path: string; depth: string | undefined; authorization: string | undefined }[];
  close(): Promise<void>;
}

export function png(seed: number): Buffer {
  const fb = new Framebuffer(20 + (seed % 60), 16);
  for (let x = 0; x < fb.width; x += (seed % 4) + 2) for (let y = 0; y < 16; y++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

const encodePath = (path: string): string => path.split('/').map((segment) => encodeURIComponent(segment)).join('/');

export async function fakeWebDav(): Promise<FakeWebDav> {
  const state = {
    base: '',
    files: new Map<string, FakeFile>(),
    username: undefined as string | undefined,
    password: undefined as string | undefined,
    strays: new Map<string, string[]>(),
    failWith: undefined as number | undefined,
    plainWeb: false,
    requests: [] as FakeWebDav['requests'],
  };
  const folders = (): Set<string> => {
    const out = new Set<string>(['/']);
    for (const path of state.files.keys()) {
      const parts = path.split('/').slice(1, -1);
      for (let i = 1; i <= parts.length; i++) out.add(`/${parts.slice(0, i).join('/')}/`);
    }
    return out;
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const depth = typeof request.headers.depth === 'string' ? request.headers.depth : undefined;
      state.requests.push({ method: request.method ?? '', path, depth, authorization: request.headers.authorization });
      if (state.password !== undefined) {
        const expected = `Basic ${Buffer.from(`${state.username ?? ''}:${state.password}`).toString('base64')}`;
        if (request.headers.authorization !== expected) {
          response.writeHead(401, { 'www-authenticate': 'Basic realm="nas"', 'content-type': 'text/plain' });
          response.end('Unauthorized');
          return;
        }
      }
      if (state.plainWeb) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>My NAS</title><h1>Welcome</h1>');
        return;
      }
      if (state.failWith !== undefined) {
        response.writeHead(state.failWith, { 'content-type': 'text/plain' });
        response.end('failed');
        return;
      }
      const all = folders();
      if (request.method === 'PROPFIND') {
        if (!path.endsWith('/') && all.has(`${path}/`)) {
          response.writeHead(301, { location: `${encodePath(path)}/` });
          response.end();
          return;
        }
        if (!all.has(path)) {
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('Not Found');
          return;
        }
        const entries: string[] = [
          `<d:response><d:href>${encodePath(path)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        ];
        for (const folder of all) {
          if (folder === path || !folder.startsWith(path)) continue;
          if (folder.slice(path.length).replace(/\/$/, '').includes('/')) continue;
          entries.push(
            `<d:response><d:href>${encodePath(folder)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          );
        }
        for (const [file, meta] of state.files) {
          if (!file.startsWith(path) || file.slice(path.length).includes('/')) continue;
          entries.push(
            `<d:response><d:href>${encodePath(file)}</d:href><d:propstat><d:prop><d:resourcetype/>` +
              `<d:getcontenttype>${meta.type}</d:getcontenttype><d:getcontentlength>${meta.claimedSize ?? meta.bytes.length}</d:getcontentlength>` +
              `<d:getetag>"${meta.etag}"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          );
        }
        for (const stray of state.strays.get(path) ?? []) {
          entries.push(
            `<d:response><d:href>${stray}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontenttype>image/jpeg</d:getcontenttype>` +
              `<d:getcontentlength>100</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          );
        }
        response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        response.end(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`);
        return;
      }
      if (request.method === 'GET') {
        const file = state.files.get(path);
        if (file === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('Not Found');
          return;
        }
        response.writeHead(200, { 'content-type': file.type });
        response.end(file.bytes);
        return;
      }
      response.writeHead(405, { 'content-type': 'text/plain' });
      response.end('Method Not Allowed');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return Object.assign(state, { close: () => new Promise<void>((resolve) => server.close(() => resolve())) }) as FakeWebDav;
}
