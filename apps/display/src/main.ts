import { createClock } from './clock.js';
import { createManifestClient, type Manifest } from './manifest.js';
import { render, renderFreeform, renderMessage } from './render.js';
import { applyTheme, themeAt } from './theme.js';
import {
  geometryFor,
  normaliseOrientation,
  normaliseRotation,
  type ScreenGeometry,
} from './orientation.js';
import { buildModel, localTime } from './viewmodel.js';
import { createManifestStore } from './store.js';
import { assess, DEFAULT_LIMITS } from './watchdog.js';

/**
 * The wall.
 *
 * Poll, draw, repeat, and never stop for anything. Every failure below leaves
 * whatever is on screen alone and says so in a banner — a household walking
 * past wants yesterday's calendar with a note far more than a blank rectangle
 * or an error page.
 *
 * The last good manifest is kept on the device, so a wall that has been
 * unplugged, or whose server is down while somebody reboots the router, comes
 * back showing yesterday's calendar with a note rather than a waiting screen.
 */

const POLL_MS = 60_000;
/** Redraw between polls so the clock and "today" move on their own. */
const TICK_MS = 15_000;
/** How often the watchdog asks whether the wall is still a wall. */
const WATCHDOG_MS = 30_000;

function start(): void {
  const root = document.getElementById('wall');
  if (root === null) return;

  const clock = createClock();
  const client = createManifestClient((input, init) => fetch(input, init));
  const store = createManifestStore();

  let manifest: Manifest | undefined;
  let lastConfirmedAt = 0;
  let offline = false;
  const startedAt = Date.now();
  let lastDrawAt = startedAt;
  let lastContactAt = startedAt;

  renderMessage(root, 'Maverick Wall', 'Waiting for the first update…');

  /**
   * Turn the page to match how the screen is hung.
   *
   * Written onto the root as attributes and custom properties rather than into
   * the markup, so a rotation change costs no re-render — and so the stylesheet
   * keeps every layout decision, which is where they can be read.
   */
  const applyGeometry = (geometry: ScreenGeometry): void => {
    const root = document.documentElement;
    root.setAttribute('data-layout', geometry.layout);
    root.setAttribute('data-rotation', String(geometry.rotation));
    root.style.setProperty('--frame-w', geometry.frame.width);
    root.style.setProperty('--frame-h', geometry.frame.height);
    root.style.setProperty('--root-size', geometry.rootFontSize);
  };

  const geometry = (): ScreenGeometry =>
    geometryFor(
      { width: window.innerWidth, height: window.innerHeight },
      normaliseRotation(manifest?.screen?.rotation),
      normaliseOrientation(manifest?.screen?.orientation),
    );

  const draw = (): void => {
    if (manifest === undefined) return;
    const now = clock.now();
    applyGeometry(geometry());
    const model = buildModel({ manifest, now, lastConfirmedAt, offline });

    // Which blocks are on screen, for the few layout rules that need to know
    // one is absent. A space-separated attribute so `~=` can test it, which
    // works everywhere; `:has()` would not.
    document.documentElement.setAttribute('data-blocks', model.blocks.join(' '));

    // The theme is re-evaluated on every draw rather than only on a new
    // manifest, or the switch to the daylight theme would wait for a calendar
    // to change rather than for the sun to come up.
    applyTheme(
      document.documentElement,
      themeAt(
        localTime(now, manifest.timezone),
        manifest.theme.active,
        manifest.theme.daytime,
        manifest.theme.daytimeStartsAt,
        manifest.theme.daytimeEndsAt,
      ),
    );
    /*
     * Free-form when the household arranged a canvas, the responsive layout
     * otherwise. The server only sets `freeform` when there is something to
     * draw, but the length check is kept here too: a bundle must draw something
     * sane against any manifest, including one older or newer than itself.
     */
    const layout = manifest.layout;
    if (layout?.mode === 'freeform' && layout.widgets !== undefined && layout.widgets.length > 0) {
      renderFreeform(root, model, { aspect: layout.aspect ?? 0.5625, widgets: layout.widgets });
    } else {
      render(root, model);
    }
    lastDrawAt = Date.now();
  };

  /**
   * Never let one bad draw end the loop.
   *
   * An exception inside an interval callback does not stop the interval, but
   * it does abandon everything after the throw — so a single malformed
   * document could leave the clock frozen for ever with no sign of why.
   */
  const safely = (work: () => void): void => {
    try {
      work();
      focusControl();
    } catch {
      // Swallowed deliberately. The watchdog below is what notices that draws
      // have stopped landing, and it can act where a thrown error cannot.
    }
  };

  const poll = async (): Promise<void> => {
    const outcome = await client.poll();
    switch (outcome.status) {
      case 'fresh':
        clock.sync(outcome.serverTime);
        manifest = outcome.manifest;
        lastConfirmedAt = clock.now();
        lastContactAt = Date.now();
        offline = false;
        // Kept for the next reload. Awaited so a save that is going to fail
        // does so before the wall is told everything is fine.
        await store.save({ manifest: outcome.manifest, confirmedAt: lastConfirmedAt });
        break;
      case 'unchanged':
        clock.sync(outcome.serverTime);
        lastConfirmedAt = clock.now();
        lastContactAt = Date.now();
        offline = false;
        break;
      case 'unpaired':
        manifest = undefined;
        renderMessage(
          root,
          'This screen is not paired',
          'Add it from the Maverick Wall admin, then open the pairing link on this screen.',
        );
        return;
      case 'failed':
        // Deliberately keeps the last manifest. The banner will say how old it
        // is; the calendar is still the most useful thing on the wall.
        offline = true;
        break;
    }
    // Through `safely`, like the tick does: a poll-driven draw gets the same
    // protection, and the focus that follows a redraw is applied in one place.
    safely(draw);
  };

  /*
   * Acknowledging an interrupt, from a remote or a fingertip.
   *
   * The keys are the ones a television remote's OK actually produces across
   * the WebViews that end up bolted to walls: `Enter` almost always, and
   * `NumpadEnter` on a few. `Escape` is deliberately *not* one of them — an
   * Android BACK press sends it, and BACK should not silently clear a warning
   * somebody has not read.
   *
   * The key acknowledges whatever is showing rather than whatever has focus.
   * D-pad focus navigation is inconsistent enough across those WebViews that
   * depending on it would mean a remote that works on one television and not
   * the next; "point at the wall, press OK" works on all of them. The button
   * is still a real button, so a touchscreen and a keyboard both work.
   */
  const acknowledge = async (key: string): Promise<void> => {
    try {
      const response = await fetch('/d/interrupts/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // The display token is an HttpOnly cookie set at pairing.
        credentials: 'same-origin',
        body: new URLSearchParams({ key }).toString(),
      });
      // A 403 means the rule said it may not be cleared. The server is the
      // authority on that, not the button — so nothing happens, deliberately.
      if (!response.ok) return;
    } catch {
      // Offline. The interrupt stays up, which is the honest outcome: nothing
      // has been acknowledged as far as the household is concerned.
      return;
    }
    // Straight back to the server rather than waiting out the poll interval,
    // so the wall reacts to a button press the way a person expects.
    await poll();
  };

  /** The control currently on screen, or nothing. */
  const dismissTarget = (): string | undefined => {
    const button = root.querySelector('[data-dismiss]');
    const key = button?.getAttribute('data-dismiss') ?? '';
    return key === '' ? undefined : key;
  };

  /*
   * Focus the control when what it acknowledges changes, and only then.
   *
   * On a wall `cursor: none` is set, so the focus ring is the only thing that
   * says which control the OK key will hit — and the whole screen is rebuilt
   * on every draw, which is once a second. Refocusing every time would fight
   * anybody using a keyboard and burn work for nothing, so it is keyed on the
   * target rather than on the redraw.
   */
  let focusedKey: string | undefined;
  const focusControl = (): void => {
    const key = dismissTarget();
    if (key === undefined) {
      focusedKey = undefined;
      return;
    }
    if (key === focusedKey) return;
    focusedKey = key;
    const button = root.querySelector('[data-dismiss]');
    if (button instanceof HTMLElement) button.focus();
  };

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    const key = dismissTarget();
    if (key === undefined) return;
    event.preventDefault();
    void acknowledge(key);
  });

  root.addEventListener('click', (event: Event) => {
    const target = event.target as Element | null;
    const key = target?.closest?.('[data-dismiss]')?.getAttribute('data-dismiss');
    if (key === null || key === undefined || key === '') return;
    void acknowledge(key);
  });

  // A wall does not usually get resized, but a kiosk browser reports its size
  // late often enough that assuming one measurement is wrong.
  window.addEventListener('resize', () => applyGeometry(geometry()));
  applyGeometry(geometry());

  /*
   * Draw from memory first, then ask the server.
   *
   * The stored document is shown before the first request is even sent, so a
   * wall coming back from a power cut with no network paints a calendar in
   * milliseconds instead of a waiting screen. The banner will say how old it
   * is — that is the honest part, and it is why the age is stored alongside.
   */
  void store.load().then((stored) => {
    if (stored !== undefined && manifest === undefined) {
      manifest = stored.manifest;
      lastConfirmedAt = stored.confirmedAt;
      offline = true;
      safely(draw);
    }
  });

  void poll();
  setInterval(() => void poll(), POLL_MS);
  setInterval(() => safely(draw), TICK_MS);

  /*
   * The watchdog, which only ever reloads.
   *
   * It cannot help a page the browser has frozen outright — nothing running
   * inside that page can — but the realistic failures are a loop that threw
   * and a renderer that stopped, and a reload clears both.
   */
  let reloads = 0;
  setInterval(() => {
    const verdict = assess(
      { lastDrawAt, lastContactAt, startedAt, reloads },
      Date.now(),
      DEFAULT_LIMITS,
    );
    if (verdict.action === 'reload') {
      reloads++;
      location.reload();
    }
  }, WATCHDOG_MS);

  /*
   * The shell cache, best-effort.
   *
   * Registration silently does nothing over plain http, because a service
   * worker needs a secure context and a LAN address is not one. The stored
   * manifest carries the offline story there; this makes a *reload* work as
   * well, on localhost or behind TLS.
   */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Not available here. Nothing else changes.
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
