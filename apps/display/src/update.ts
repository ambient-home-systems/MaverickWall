/**
 * A wall reloads itself after the server is updated (plan item M1.5).
 *
 * The page knows which release served it — the server stamps it into the HTML
 * (`<meta name="mw-version">`) — and every `/d/manifest` answer says which
 * release is answering now. When the two differ, the wall is running code the
 * server no longer ships: an old renderer reading a new manifest, which works
 * until the day it does not. So it reloads, once.
 *
 * Three things keep that from being its own fault. **A stagger** of up to half
 * a minute, so every wall in a house does not hit a server that has just
 * started all at once. **At most once in ten minutes**, remembered in the
 * device's own storage across the reload, so a wall whose page and server go
 * on disagreeing — a proxy caching the old page, say — cannot reload in a
 * loop. And **the shell cache emptied first**, so a page the service worker
 * would have handed straight back is fetched from the server instead; without
 * that, the reload on an https install brings back the old code and the
 * update waits for a second reload nobody asks for.
 *
 * Pure apart from the last function, which is the one that touches the page.
 */

/** How long a version reload is remembered for. */
export const UPDATE_RELOAD_GAP_MS = 10 * 60_000;
/** The longest a wall waits before reloading, so a house of walls is spread out. */
export const UPDATE_STAGGER_MS = 30_000;
/** Where the last version reload is remembered, across the reload itself. */
export const UPDATE_RELOAD_KEY = 'mw-update-reload-at';
/** The service worker's caches all start with this (`sw.ts`'s `CACHE`). */
export const SHELL_CACHE_PREFIX = 'maverick-wall-shell';

/** The release that served this page, from its `<meta name="mw-version">`, or undefined. */
export function pageVersion(doc: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | undefined {
  const content = doc.querySelector('meta[name="mw-version"]')?.getAttribute('content') ?? '';
  return content === '' ? undefined : content;
}

/** Whether this page is from another release than the server answering it. */
export function updateDue(page: string | undefined, server: string | undefined): boolean {
  return page !== undefined && server !== undefined && page !== server;
}

/** Whether a version reload may happen now, given when the last one did. */
export function reloadAllowed(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || !Number.isFinite(lastAt) || now - lastAt >= UPDATE_RELOAD_GAP_MS || now < lastAt;
}

/** How long this wall waits before reloading: somewhere in the first half-minute. */
export function staggerMs(random: () => number = Math.random): number {
  return Math.floor(random() * UPDATE_STAGGER_MS);
}

/**
 * Reload, past the service worker's copy of the shell: empty its caches first,
 * so the worker finds nothing and goes to the server. Best-effort — on plain
 * http there is no worker and no `caches`, and a reload is all there is to do.
 */
export async function reloadFresh(location: { reload(): void }): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX)).map((name) => caches.delete(name)));
    }
  } catch {
    // A cache that will not empty still reloads; at worst into the old shell,
    // which the worker refreshes behind it.
  }
  location.reload();
}
