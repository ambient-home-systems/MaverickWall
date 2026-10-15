/**
 * Markers around the admin's two navigations.
 *
 * `page()` draws both: the sidebar (with the compact width's drawer and the
 * app bar's menu button), and the tab bar a page opened inside Home
 * Assistant's own sidebar uses instead. It cannot choose, because it is handed
 * strings and never the request; the ingress middleware knows the request, and
 * on the way out it keeps one and removes the other (`chooseNavigation`). That
 * is the `SIGNOUT_OPEN` arrangement, for the same reason: `page()` and its
 * dozens of callers stay unaware that ingress exists.
 *
 * In a file of their own because `components.ts` draws the menu button and
 * `html.ts` imports `components.ts`, so neither can be where both read them.
 */
export const SIDENAV_OPEN = '<!--mw:sidenav-->';
export const SIDENAV_CLOSE = '<!--/mw:sidenav-->';
export const TABS_OPEN = '<!--mw:tabs-->';
export const TABS_CLOSE = '<!--/mw:tabs-->';
