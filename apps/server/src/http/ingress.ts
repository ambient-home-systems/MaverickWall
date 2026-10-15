import type { Context, Next } from 'hono';
import { SIGNOUT_CLOSE, SIGNOUT_OPEN } from './html.js';
import { SIDENAV_CLOSE, SIDENAV_OPEN, TABS_CLOSE, TABS_OPEN } from './nav-markers.js';

/**
 * Running behind Home Assistant's ingress proxy.
 *
 * The supervisor mounts an add-on under a per-session path —
 * `/api/hassio_ingress/<token>/` — strips that prefix before forwarding, and
 * tells us what it stripped in `X-Ingress-Path`. Everything this application
 * emits with a leading slash is therefore wrong by exactly that prefix, and
 * wrong in a way that lands somewhere else in Home Assistant rather than
 * 404ing visibly.
 *
 * Three things have to move, and all three are here so that nothing else in
 * the application has to know ingress exists:
 *
 *   1. **Redirects.** A `Location: /admin` sends the browser out of the add-on
 *      and into Home Assistant's own UI. Rewritten on the way out.
 *   2. **Links and form actions.** Handled with one `<base>` element injected
 *      into every HTML response; the pages emit relative URLs, which resolve
 *      against it. One tag rather than a prefix threaded through forty call
 *      sites, and the non-ingress case is the same code with `/`.
 *   3. **The cross-origin guard.** The browser's `Origin` is Home Assistant's,
 *      not ours, so the app-wide guard on non-GET requests refuses every form
 *      post. Under ingress the supervisor is the trust boundary, and it only
 *      forwards a request that already carries a valid Home Assistant session.
 *
 * The token changes per session, which is why nothing may be *stored* against
 * it — no absolute URL in the database, no service worker registered under it.
 * The wall displays do not come through here at all: they connect to the
 * add-on's own port with a display token, because ingress requires a Home
 * Assistant session and a screen screwed to a wall does not have one.
 */

/** Header the supervisor sets to whatever it stripped. Never trusted blindly. */
export const INGRESS_HEADER = 'x-ingress-path';

/**
 * The prefix for this request, or the empty string.
 *
 * Validated rather than taken as given. This header decides where a browser
 * sends its next request and what goes into a `<base>` element, so a value
 * carrying a quote, a scheme, or a `..` would be a redirect the household did
 * not ask for. Only the shape the supervisor actually sends is accepted.
 */
export function ingressPath(c: Context): string {
  const raw = c.req.header(INGRESS_HEADER);
  if (raw === undefined || raw === '') return '';
  // A single absolute path segment run, no trailing slash, no traversal.
  if (!/^\/[A-Za-z0-9_\-/.]{0,200}$/.test(raw)) return '';
  if (raw.includes('..') || raw.includes('//')) return '';
  return raw.replace(/\/+$/, '');
}

/** Where the application's root is, from the browser's point of view. */
export function baseHref(prefix: string): string {
  return prefix === '' ? '/' : `${prefix}/`;
}

/**
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:172.30.32.2`.
 * Compared against the bare form so a plain address in the trust list matches
 * either representation.
 */
export function normaliseSource(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Is this the supervisor itself, forwarding an already-authenticated Home
 * Assistant session — rather than a device on the LAN that merely set the
 * ingress header?
 *
 * This is what lets the settings trust Home Assistant's own login instead of
 * asking for a second one. All of it has to hold, and any doubt fails closed
 * to the normal sign-in:
 *
 *   - We are actually running as an add-on. A plain `docker run` never sees
 *     ingress and must never grant a session on the strength of a header.
 *   - The request carries a valid ingress path.
 *   - Its real TCP source — the socket, never a header — is in the trusted
 *     set, which is the supervisor's fixed address on the internal network.
 *
 * The header alone cannot be trusted, and that is the whole point. Ingress and
 * the wall displays share one LAN-exposed port, so anything on the household
 * network can open it and send `X-Ingress-Path`. The socket source is the part
 * it cannot forge without already being on the supervisor's own network — a
 * compromised add-on, which is a different and far higher bar than a phone on
 * the wifi.
 */
export function isTrustedIngress(
  c: Context,
  socketAddress: string | undefined,
  opts: { readonly isAddon: boolean; readonly sources: ReadonlySet<string> },
): boolean {
  if (!opts.isAddon) return false;
  if (ingressPath(c) === '') return false;
  if (socketAddress === undefined || socketAddress === '') return false;
  return opts.sources.has(normaliseSource(socketAddress));
}

/**
 * The tag `page()` always emits. Replaced rather than joined by a second one.
 *
 * A browser honours the first `<base>` and ignores the rest, so injecting one
 * ahead of this would work — and would leave two of them in the document
 * disagreeing, which is the sort of thing that survives until somebody
 * reorders the template.
 */
const BASE_TAG = '<base href="/">';

/** Matches the sidebar sign-out block, markers included, for removal. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SIGNOUT_RE = new RegExp(`${escapeRe(SIGNOUT_OPEN)}[\\s\\S]*?${escapeRe(SIGNOUT_CLOSE)}`, 'g');

const SIDENAV_RE = new RegExp(`${escapeRe(SIDENAV_OPEN)}[\\s\\S]*?${escapeRe(SIDENAV_CLOSE)}`, 'g');
const TABS_RE = new RegExp(`${escapeRe(TABS_OPEN)}[\\s\\S]*?${escapeRe(TABS_CLOSE)}`, 'g');
const SHELL_BODY = '<body class="shell">';

/** A 204, a 304 or a HEAD answer: nothing to rewrite, and no Response could carry a body for one. */
function hasBody(res: Response): boolean {
  return res.body !== null && res.status !== 204 && res.status !== 304;
}

/**
 * Keep one of the admin's two navigations (nav-markers.ts).
 *
 * Inside Home Assistant's sidebar the page keeps its tab bar and loses its own
 * sidebar, its drawer and the app bar's menu button, which opens that drawer:
 * two sidebars side by side spent about 520px of a 1440px screen on navigation
 * and read as one doubled column. The body takes `in-ha` so the stylesheet can
 * give the main column the whole width. Anywhere else it is the other way
 * round, and the page is exactly what it was before the tab bar existed.
 *
 * Exported so the swap can be held to that without a server.
 */
export function chooseNavigation(body: string, insideHomeAssistant: boolean): string {
  if (!body.includes(TABS_OPEN) && !body.includes(SIDENAV_OPEN)) return body;
  if (!insideHomeAssistant) return body.replace(TABS_RE, '');
  return body.replace(SIDENAV_RE, '').replace(SHELL_BODY, '<body class="shell in-ha">');
}

/**
 * Rewrite what leaves, so nothing that builds a page has to know.
 *
 * Only ever active when the header is present, so the overwhelmingly common
 * case — a household browsing to the box directly — runs the same code it
 * always did and cannot be broken by anything here.
 */
export function ingress() {
  return async (c: Context, next: Next): Promise<void> => {
    const prefix = ingressPath(c);
    if (prefix === '') {
      await next();
      // The one rewrite outside Home Assistant: an admin page carries a tab bar
      // only Home Assistant's sidebar uses, and it goes before it is sent. Only
      // the admin's own pages, because they are the only ones `page()` draws
      // a shell for, and never a bodiless answer: a wall's 304 for its own page
      // is HTML too, and a Response with a body cannot carry a 304.
      const path = c.req.path;
      if (path !== '/admin' && !path.startsWith('/admin/')) return;
      if (!hasBody(c.res) || !(c.res.headers.get('content-type') ?? '').includes('text/html')) return;
      const body = await c.res.text();
      c.res = new Response(chooseNavigation(body, false), {
        status: c.res.status,
        headers: c.res.headers,
      });
      return;
    }

    c.set('ingressPath', prefix);
    await next();

    /*
     * Redirects, first.
     *
     * Only an absolute path, and only one not already prefixed — a handler
     * that has been taught about ingress, or a redirect to another host, must
     * pass through untouched.
     */
    const location = c.res.headers.get('location');
    if (location !== null && location.startsWith('/') && !location.startsWith(`${prefix}/`)) {
      c.res.headers.set('location', `${prefix}${location}`);
    }

    const type = c.res.headers.get('content-type') ?? '';
    if (!type.includes('text/html') || !hasBody(c.res)) return;

    /*
     * Then the base element and the sign-out control.
     *
     * The base is inserted rather than templated because `page()` is called
     * from four files and a dozen closures, and threading a prefix through all
     * of them would be forty chances to forget one. The pages emit relative
     * URLs, so this single tag is what makes every link, form action and asset
     * resolve inside the add-on.
     *
     * The sidebar's sign-out is removed here for the same reason it is not
     * threaded through every page: under ingress the supervisor authenticated
     * the household, so ending our cookie only has the supervisor hand the
     * session straight back — a control that looks like it failed. It is
     * rendered by default (a plain `docker run` has no other way out) and
     * stripped on the one path where it is wrong.
     */
    const body = await c.res.text();
    let patched = chooseNavigation(body, true);
    if (patched.includes(BASE_TAG)) patched = patched.replace(BASE_TAG, `<base href="${baseHref(prefix)}">`);
    if (patched.includes(SIGNOUT_OPEN)) patched = patched.replace(SIGNOUT_RE, '');

    c.res = new Response(patched, {
      status: c.res.status,
      headers: c.res.headers,
    });
  };
}
