import { createClock } from './clock.js';
import { createManifestClient, type Manifest } from './manifest.js';
import { render, renderMessage } from './render.js';
import { applyTheme, themeAt } from './theme.js';
import {
  geometryFor,
  normaliseOrientation,
  normaliseRotation,
  type ScreenGeometry,
} from './orientation.js';
import { buildModel, localTime } from './viewmodel.js';

/**
 * The wall.
 *
 * Poll, draw, repeat, and never stop for anything. Every failure below leaves
 * whatever is on screen alone and says so in a banner — a household walking
 * past wants yesterday's calendar with a note far more than a blank rectangle
 * or an error page.
 *
 * Nothing here is stored yet: a reload with the server down still shows the
 * "waiting" screen. IndexedDB and the service worker are the next change, and
 * they come after this because resilience protecting a layout nobody has
 * looked at is effort on the wrong risk.
 */

const POLL_MS = 60_000;
/** Redraw between polls so the clock and "today" move on their own. */
const TICK_MS = 15_000;

function start(): void {
  const root = document.getElementById('wall');
  if (root === null) return;

  const clock = createClock();
  const client = createManifestClient((input, init) => fetch(input, init));

  let manifest: Manifest | undefined;
  let lastConfirmedAt = 0;
  let offline = false;

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
    render(root, model);
  };

  const poll = async (): Promise<void> => {
    const outcome = await client.poll();
    switch (outcome.status) {
      case 'fresh':
        clock.sync(outcome.serverTime);
        manifest = outcome.manifest;
        lastConfirmedAt = clock.now();
        offline = false;
        break;
      case 'unchanged':
        clock.sync(outcome.serverTime);
        lastConfirmedAt = clock.now();
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
    draw();
  };

  // A wall does not usually get resized, but a kiosk browser reports its size
  // late often enough that assuming one measurement is wrong.
  window.addEventListener('resize', () => applyGeometry(geometry()));
  applyGeometry(geometry());

  void poll();
  setInterval(() => void poll(), POLL_MS);
  setInterval(draw, TICK_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
