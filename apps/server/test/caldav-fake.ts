import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A CalDAV server on loopback that records every request it was sent.
 *
 * RFC 013 §11 asks for the host-confirmation policy to be "driven rather than
 * reasoned about", and names the assertion that only a real server can make:
 * *the credential must not have been sent before the chain stopped*, which is a
 * claim about what the **second** host received. No stub can answer that — a
 * stub is asked, and the whole question is whether it was asked at all.
 *
 * So this is a real `node:http` server, and two of them stand in for two hosts.
 * Two loopback ports is enough to be two origins: `isCrossOrigin` treats a port
 * change exactly as it treats a host change, and the `hostKey` the policy
 * compares carries the port for the same reason.
 *
 * It answers the four-hop chain, deliberately in the shapes servers actually
 * use rather than in one house style — the well-known redirect that RFC 6764 §6
 * specifies, a `207` for each `PROPFIND`, and a `401` with a `WWW-Authenticate`
 * for anything unsigned past the first hop.
 */

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly depth: string | undefined;
  /** Present exactly when the request carried one. The whole point of this file. */
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface CalDavFake {
  readonly base: string;
  /**
   * Change a collection's CTag, which is the only way to make the second poll
   * of an unchanged calendar do any work (§6.6).
   */
  readonly setCtag: (path: string, ctag: string) => void;
  /** Every request this server saw, oldest first. */
  readonly seen: Recorded[];
  /** Requests that carried an `authorization` header. */
  readonly signedIn: () => readonly Recorded[];
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

export interface FakeOptions {
  /** The Basic credential this server accepts. Anything else is a 401. */
  readonly credential: string;
  /**
   * Where `calendar-home-set` points. Absolute to send the chain to another
   * host, which is the iCloud partition-host move; omitted to stay put.
   */
  readonly homeSetUrl?: string;
  /** Serve the calendar listing even though the home set is elsewhere. */
  readonly serveCollections?: boolean;
  /**
   * Answer the home set with a `207` holding only the container — signed in,
   * and no calendars on the account.
   *
   * A different thing from `serveCollections: false`, which 404s: §6.7's whole
   * argument is that "you are signed in and that account has no calendars" and
   * "that address is not a CalDAV server" are different sentences, and a fake
   * that can only produce one of them cannot tell whether the code says both.
   */
  readonly emptyHomeSet?: boolean;
  /** Answer `/.well-known/caldav` with a redirect to this path. Default `/dav/`. */
  readonly wellKnownTarget?: string;
  /**
   * What each collection answers a `REPORT` with, keyed by its path.
   *
   * A whole `multistatus` string rather than a list of `VCALENDAR`s, because
   * §6.5's isolation assertion needs a **deliberately broken resource between
   * two good ones** and a fixture that could only be built from well-formed
   * events could not express one.
   */
  readonly reports?: Readonly<Record<string, string>>;
}

const XML = { 'content-type': 'application/xml; charset=utf-8' } as const;

function multistatus(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ` +
    `xmlns:cs="http://calendarserver.org/ns/">\n${body}</d:multistatus>\n`
  );
}

function principalDocument(): string {
  return multistatus(
    ` <d:response>\n` +
      `  <d:href>/dav/</d:href>\n` +
      `  <d:propstat>\n` +
      `   <d:prop><d:current-user-principal><d:href>/dav/principals/REDACTED/</d:href>` +
      `</d:current-user-principal></d:prop>\n` +
      `   <d:status>HTTP/1.1 200 OK</d:status>\n` +
      `  </d:propstat>\n` +
      ` </d:response>\n`,
  );
}

function homeSetDocument(homeSetUrl: string): string {
  return multistatus(
    ` <d:response>\n` +
      `  <d:href>/dav/principals/REDACTED/</d:href>\n` +
      `  <d:propstat>\n` +
      `   <d:prop><cal:calendar-home-set><d:href>${homeSetUrl}</d:href></cal:calendar-home-set>` +
      `</d:prop>\n` +
      `   <d:status>HTTP/1.1 200 OK</d:status>\n` +
      `  </d:propstat>\n` +
      ` </d:response>\n`,
  );
}

function collection(href: string, name: string, ctag: string, components: string): string {
  return (
    ` <d:response>\n` +
    `  <d:href>${href}</d:href>\n` +
    `  <d:propstat>\n` +
    `   <d:prop>\n` +
    `    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>\n` +
    `    <d:displayname>${name}</d:displayname>\n` +
    `    <cal:supported-calendar-component-set>${components}` +
    `</cal:supported-calendar-component-set>\n` +
    `    <cs:getctag>${ctag}</cs:getctag>\n` +
    `   </d:prop>\n` +
    `   <d:status>HTTP/1.1 200 OK</d:status>\n` +
    `  </d:propstat>\n` +
    ` </d:response>\n`
  );
}

/**
 * A home set with four collections: the container itself, two that hold events
 * and one that holds only tasks.
 *
 * Three is the number §6.2.1's schema argument rests on ("households end up
 * with more than one calendar per account") and the `VTODO`-only one is the
 * case a discovery that filtered on nothing would offer a household as a
 * calendar.
 */
function collectionsDocument(prefix: string): string {
  return multistatus(
    ` <d:response>\n` +
      `  <d:href>${prefix}</d:href>\n` +
      `  <d:propstat>\n` +
      `   <d:prop><d:resourcetype><d:collection/></d:resourcetype>` +
      `<d:displayname>calendars</d:displayname></d:prop>\n` +
      `   <d:status>HTTP/1.1 200 OK</d:status>\n` +
      `  </d:propstat>\n` +
      ` </d:response>\n` +
      collection(`${prefix}personal/`, 'Home', 'ctag-home-1', '<cal:comp name="VEVENT"/>') +
      collection(
        `${prefix}school-run/`,
        'School &amp; clubs',
        'ctag-school-9',
        '<cal:comp name="VEVENT"/><cal:comp name="VTODO"/>',
      ) +
      collection(`${prefix}shopping/`, 'Shopping', 'ctag-shop-3', '<cal:comp name="VTODO"/>'),
  );
}

/** The container and nothing else: a real account with no calendars on it. */
function emptyHomeSetDocument(prefix: string): string {
  return multistatus(
    ` <d:response>\n` +
      `  <d:href>${prefix}</d:href>\n` +
      `  <d:propstat>\n` +
      `   <d:prop><d:resourcetype><d:collection/></d:resourcetype>` +
      `<d:displayname>calendars</d:displayname></d:prop>\n` +
      `   <d:status>HTTP/1.1 200 OK</d:status>\n` +
      `  </d:propstat>\n` +
      ` </d:response>\n`,
  );
}

export async function startCalDavFake(options: FakeOptions): Promise<CalDavFake> {
  const seen: Recorded[] = [];
  let base = '';
  /*
   * A CTag for every collection the listing advertises, plus one for anything
   * `reports` names.
   *
   * The second half is what stops a fixture being quietly unreachable: a
   * collection with a `REPORT` and no CTag answers the sync's first request
   * with a 404, which reads as a broken calendar rather than as a fixture
   * missing a line. Deriving them from the same map means adding a collection
   * to a test cannot forget one.
   */
  const ctags: Record<string, string> = {
    '/dav/calendars/REDACTED/personal/': 'ctag-home-1',
    '/dav/calendars/REDACTED/school-run/': 'ctag-school-9',
    '/dav/calendars/REDACTED/shopping/': 'ctag-shop-3',
    ...Object.fromEntries(Object.keys(options.reports ?? {}).map((path) => [path, `ctag-${path}-1`])),
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const authorization = req.headers.authorization;
      seen.push({
        method: req.method ?? '',
        path,
        depth: req.headers['depth'] as string | undefined,
        authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (path === '/.well-known/caldav') {
        // RFC 6764 §6. Unauthenticated: the client has nothing to prove yet and
        // this is the hop that tells it where the context path is.
        res.writeHead(301, { location: options.wellKnownTarget ?? '/dav/' });
        res.end();
        return;
      }

      if (authorization !== options.credential) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
        res.end('sign in');
        return;
      }

      if (path === '/dav/' || path === '/dav') {
        res.writeHead(207, XML);
        res.end(principalDocument());
        return;
      }
      if (path === '/dav/principals/REDACTED/') {
        res.writeHead(207, XML);
        res.end(homeSetDocument(options.homeSetUrl ?? '/dav/calendars/REDACTED/'));
        return;
      }
      /*
       * A collection answers the CTag to a `PROPFIND` and the events to a
       * `REPORT`, which is the two-request shape §6.6 turns into one on an
       * unchanged calendar. The CTag is mutable so a test can change it and
       * watch the second poll do the work the first one skipped.
       */
      if (ctags[path] !== undefined && req.method === 'PROPFIND') {
        res.writeHead(207, XML);
        res.end(
          multistatus(
            ` <d:response>\n  <d:href>${path}</d:href>\n  <d:propstat>\n` +
              `   <d:prop><cs:getctag>${ctags[path]}</cs:getctag></d:prop>\n` +
              `   <d:status>HTTP/1.1 200 OK</d:status>\n  </d:propstat>\n </d:response>\n`,
          ),
        );
        return;
      }
      if (req.method === 'REPORT' && options.reports?.[path] !== undefined) {
        res.writeHead(207, XML);
        res.end(options.reports[path]);
        return;
      }

      if (path === '/dav/calendars/REDACTED/' && options.serveCollections !== false) {
        res.writeHead(207, XML);
        res.end(
          options.emptyHomeSet === true
            ? emptyHomeSetDocument('/dav/calendars/REDACTED/')
            : collectionsDocument('/dav/calendars/REDACTED/'),
        );
        return;
      }

      res.writeHead(404, XML);
      res.end('<d:error xmlns:d="DAV:"/>');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  return {
    base,
    seen,
    setCtag: (path, ctag) => {
      ctags[path] = ctag;
    },
    signedIn: () => seen.filter((record) => record.authorization !== undefined),
    reset: () => {
      seen.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
