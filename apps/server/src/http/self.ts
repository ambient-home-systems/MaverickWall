/**
 * This document's own URL, written the way a link in it has to be written.
 *
 * Every page emits `<base href="/">` — the ingress middleware rewrites it to
 * the supervisor's per-session prefix, and that one element is what carries
 * forty call sites' worth of relative links through the add-on without a
 * prefix threaded through any of them.
 *
 * The cost is a trap, and the skip link is what walked into it: **a bare
 * fragment resolves against the `<base>`, not against the document.** On
 * `/admin/calendars` an `href="#mw-main"` resolves to `/#mw-main`, which is a
 * different URL, so a browser leaves the page entirely and lands on the admin
 * root. Measured in Chromium rather than reasoned about, because the markup
 * reads as obviously correct and the anchor's `.href` says otherwise.
 *
 * So a link to *this* document has to name this document, and the name has to
 * be relative for the same reason everything else here is. The request is the
 * only thing that knows it, which is why `page()` is handed the answer rather
 * than left to guess from the section it was told to highlight — a section is
 * a nav key, and `/admin/walls` and `/admin/walls/:id` share one.
 */
import type { Context } from 'hono';

/**
 * Every query parameter the request carried, in order.
 *
 * `queries()`, not `query()`: the latter keeps only the first value of a
 * repeated parameter. A self link that dropped the rest would resolve to a
 * *different* URL from the one the browser is on, which turns a same-document
 * jump into a page load — the whole fault this file exists to avoid, one step
 * quieter.
 */
export function queryOf(c: Context): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, values] of Object.entries(c.req.queries())) {
    for (const value of values) params.append(name, value);
  }
  return params;
}

/**
 * The request's own path and query, relative.
 *
 * A path that is somehow empty falls back to the admin root rather than to
 * `""`, which a browser resolves as "this URL, parameters and all" — correct
 * by accident here, and not something to rely on.
 */
export function selfHref(c: Context, params: URLSearchParams = queryOf(c)): string {
  const rest = params.toString();
  const relative = c.req.path.replace(/^\/+/, '');
  if (relative === '') return 'admin';
  return rest === '' ? relative : `${relative}?${rest}`;
}
