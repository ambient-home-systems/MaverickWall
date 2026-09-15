import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install, type Installation } from './browser-harness.js';

/**
 * RFC 016 phase 0, through the real app: whether a wall reads as up, and the
 * order the Walls list puts them in.
 *
 * **The clock.** `touchScreen` stamped `last_seen_at` from a bare `Date.now()`
 * while every page that reads it compares against the app's injected `now`. In
 * production those are one clock. `browser-harness` pins the app's `now` to
 * today at `HARNESS_HOUR` in the household's zone, so there they are hours
 * apart, and a wall that polled a second ago read "Not seen recently · last
 * seen 9 hours ago" — the `firstSyncPending` fault a third time. It never
 * showed on a page before, because every wall on a fresh harness had a null
 * stamp and `ago(null)` short-circuits; RFC 016's "Drawing now" is what would
 * have made it load-bearing.
 *
 * **Hour-dependent in one direction, so the stamp is asserted too.** A page
 * compares `at - lastSeenAt` against a window, and a `Date.now()` stamp *later*
 * than the pinned hour is a negative age, which is inside any window. So with
 * the fix reverted the page assertion is red only while the runner's clock is
 * behind `HARNESS_HOUR` in London; the stored stamp against `home.now()` is red
 * at every hour but the few minutes around it.
 *
 * No browser: `install()` needs none, and this asks the server what it says.
 */

let home: Installation;

beforeAll(async () => {
  home = await install();
}, 120_000);

afterAll(async () => {
  await home?.dispose();
});

function screenIdNamed(name: string): string {
  const row = home.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string } | undefined;
  if (row === undefined) throw new Error(`no screen named ${name}`);
  return row.id;
}

function stampOf(id: string): number | null {
  return (home.db.prepare('SELECT last_seen_at AS at FROM screens WHERE id = ?').get(id) as { at: number | null }).at;
}

describe('a wall that has just been polled reads as up, on the app’s own clock', () => {
  it('a browser wall: /d/manifest stamps the app’s now, and its page says Online', async () => {
    const link = await home.pairLink('Clock wall');
    const token = new URL(link).searchParams.get('token');
    if (token === null) throw new Error('the pairing link carried no token');
    const id = screenIdNamed('Clock wall');

    const polled = await home.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } });
    expect(polled.status).toBe(200);

    const html = await (await home.call(`/admin/walls/${encodeURIComponent(id)}`)).text();
    expect(html).toContain('<b>Online</b>');
    expect(html).not.toContain('Not seen recently');

    const stamp = stampOf(id);
    expect(stamp, 'the poll stamped nothing').not.toBeNull();
    expect(Math.abs((stamp ?? 0) - home.now()), 'stamped from a clock other than the app’s').toBeLessThan(60_000);
  });

  it('an e-paper panel: /d/epaper stamps the app’s now, and its page says Online', async () => {
    const made = await home.post('/admin/epaper', { name: 'Clock panel', preset: 'seeed-7in5', rotation: '0' });
    const recipes = await (await home.call(made.headers.get('location') ?? '')).text();
    const frame = /https?:\/\/[^"<\s]*(\/d\/epaper\/[^"<\s]+)/.exec(recipes)?.[1];
    if (frame === undefined) throw new Error('no frame URL on the panel’s recipes page');
    const id = screenIdNamed('Clock panel');

    const fetched = await home.call(frame);
    expect(fetched.status).toBe(200);

    const html = await (await home.call(`/admin/epaper/${encodeURIComponent(id)}/design`)).text();
    expect(html).toContain('<b>Online</b>');
    expect(html).not.toContain('Not seen recently');

    const stamp = stampOf(id);
    expect(stamp, 'the fetch stamped nothing').not.toBeNull();
    expect(Math.abs((stamp ?? 0) - home.now()), 'stamped from a clock other than the app’s').toBeLessThan(60_000);
  });
});

describe('the Walls list orders by name the way a person reads one', () => {
  it('puts "attic tablet" before "Hall" and "Kitchen", not after them', async () => {
    // Created out of order, so insertion order cannot pass for the fix.
    for (const name of ['Kitchen', 'attic tablet', 'Hall']) {
      const made = await home.post('/admin/screens', { name, theme: 'panels' });
      expect(made.status).toBe(303);
    }
    const html = await (await home.call('/admin/walls')).text();
    const names = [...html.matchAll(/<div class="rname">([^<]+)/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((n) => ['Hall', 'Kitchen', 'attic tablet'].includes(n));
    expect(names).toEqual(['attic tablet', 'Hall', 'Kitchen']);
  });
});
