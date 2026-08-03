import type { Context, Next } from 'hono';

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
 * The tag `page()` always emits. Replaced rather than joined by a second one.
 *
 * A browser honours the first `<base>` and ignores the rest, so injecting one
 * ahead of this would work — and would leave two of them in the document
 * disagreeing, which is the sort of thing that survives until somebody
 * reorders the template.
 */
const BASE_TAG = '<base href="/">';

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
    if (!type.includes('text/html')) return;

    /*
     * Then the base element.
     *
     * Inserted rather than templated because `page()` is called from four
     * files and a dozen closures, and threading a prefix through all of them
     * would be forty chances to forget one. The pages emit relative URLs, so
     * this single tag is what makes every link, form action and asset resolve
     * inside the add-on.
     */
    const body = await c.res.text();
    if (!body.includes(BASE_TAG)) return;
    const patched = body.replace(BASE_TAG, `<base href="${baseHref(prefix)}">`);

    c.res = new Response(patched, {
      status: c.res.status,
      headers: c.res.headers,
    });
  };
}
