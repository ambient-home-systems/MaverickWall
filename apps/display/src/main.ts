import { createClock } from './clock.js';
import {
  createManifestClient,
  isRenderableManifest,
  isStandInManifest,
  keepHeld,
  shouldAdoptStored,
  shouldKeepHeld,
  type Manifest,
  type ManifestWidget,
  type CanvasBackground,
} from './manifest.js';
import { renderFreeform, renderMessage, renderPairing } from './render.js';
import { applyTheme, daytimeActive } from './theme.js';
import {
  geometryFor,
  normaliseOrientation,
  normaliseRotation,
  physicalScreenFrom,
  WALL_TYPE_PROPERTIES,
  WALL_TYPE_ROLES,
  type ScreenGeometry,
} from './orientation.js';
import { buildModel, localTime } from './viewmodel.js';
import { createManifestStore } from './store.js';
import { assess, DEFAULT_LIMITS } from './watchdog.js';

/**
 * Which canvas to draw, for how the screen is actually hung.
 *
 * A display carries two canvases (RFC 005) and only the wall knows its live
 * orientation, so the choice is made here rather than on the server. The
 * matching orientation wins; if its canvas is empty, the other's is drawn
 * letterboxed, so a household that arranged only one side still sees it. The
 * legacy single-canvas shape (from a manifest cached by a pre-split bundle) is
 * read last. Every wall is free-form now — the responsive "auto" layout was
 * retired — so this always returns a canvas: an empty one (no widgets) when
 * there is nothing to draw, which `renderFreeform` paints as a "nothing yet"
 * note rather than a blank wall.
 */
function pickCanvas(
  layout: Manifest['layout'],
  orientation: 'portrait' | 'landscape',
): { readonly aspect: number; readonly widgets: readonly ManifestWidget[]; readonly background?: CanvasBackground } {
  const landscape = orientation === 'landscape';
  const primary = landscape ? layout?.landscape : layout?.portrait;
  const secondary = landscape ? layout?.portrait : layout?.landscape;
  if (primary?.widgets !== undefined && primary.widgets.length > 0) {
    return {
      aspect: primary.aspect ?? (landscape ? 1.7778 : 0.5625),
      widgets: primary.widgets,
      ...(primary.background !== undefined ? { background: primary.background } : {}),
    };
  }
  if (secondary?.widgets !== undefined && secondary.widgets.length > 0) {
    return {
      aspect: secondary.aspect ?? (landscape ? 0.5625 : 1.7778),
      widgets: secondary.widgets,
      ...(secondary.background !== undefined ? { background: secondary.background } : {}),
    };
  }
  if (layout?.widgets !== undefined && layout.widgets.length > 0) {
    return { aspect: layout.aspect ?? 0.5625, widgets: layout.widgets };
  }
  // Nothing arranged for either orientation: an empty canvas at this
  // orientation's default aspect. `renderFreeform` draws the "nothing yet" note.
  return { aspect: landscape ? 1.7778 : 0.5625, widgets: [] };
}

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

  // The default theme, before any manifest. Panels is the documented default,
  // and its tokens are what the pre-paint and pairing screens are styled from —
  // without this they draw with `--panel`, `--muted` and `--accent` all unset,
  // so a field has no box and the muted text is not muted. A real manifest
  // re-themes on the first draw.
  applyTheme(document.documentElement, 'panels');

  const clock = createClock();
  const client = createManifestClient(
    (input, init) => fetch(input, init),
    '/d/manifest',
    () => ({ w: window.innerWidth, h: window.innerHeight }),
  );
  const store = createManifestStore();

  let manifest: Manifest | undefined;
  /*
   * Whether what is held is the household's calendar rather than the server's
   * stand-in. Tracked rather than re-derived, because the keep-held branch
   * folds the stand-in's notices into the held document — so asking the
   * document would answer "stand-in" from the second poll on, and the empty one
   * would get through after all.
   */
  let heldIsReal = false;
  let lastConfirmedAt = 0;
  let offline = false;
  // Drawn once when the screen first turns out to be unpaired, then left alone
  // so the 60-second poll cannot wipe a code somebody is mid-way through typing.
  let pairingShown = false;
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
    /*
     * What one arc-minute of the reader's vision is worth here, for the type
     * scale to size against — set only on a wall that has been measured, and
     * *removed* rather than left when it has not. A household who clears the
     * measurement must not keep a stale one until the next reload, which is the
     * same argument as every other attribute written here rather than into the
     * markup.
     */
    if (geometry.pxArcmin === undefined) {
      root.style.removeProperty('--px-arcmin');
    } else {
      root.style.setProperty('--px-arcmin', String(geometry.pxArcmin));
    }
    /*
     * And the eight roles that follow from it, in CSS pixels.
     *
     * Written here rather than left for the stylesheet to `calc()` because
     * this is where `--root-size` is written, and both answer the same
     * question: what a size is worth on this screen. Removed on the same
     * argument as `--px-arcmin` above — and it is *removal* that makes the
     * whole scale degrade, because every use site in `display.css` is
     * `var(--t-wall-role, <what that selector drew before>)` and an undefined
     * custom property is exactly what reaches that fallback. A role left
     * behind on a wall whose measurement was taken back would be the one
     * thing rule nine does not allow: a wall that changed under a household
     * who asked for it not to.
     */
    const scale = geometry.type;
    for (const role of WALL_TYPE_ROLES) {
      const property = WALL_TYPE_PROPERTIES[role];
      if (scale === undefined) root.style.removeProperty(property);
      else root.style.setProperty(property, `${scale[role]}px`);
    }
  };

  const geometry = (): ScreenGeometry =>
    geometryFor(
      { width: window.innerWidth, height: window.innerHeight },
      normaliseRotation(manifest?.screen?.rotation),
      normaliseOrientation(manifest?.screen?.orientation),
      // How large this wall is and how far away it is read from, if the
      // household has said. The server sends facts in millimetres and never a
      // size in pixels, because this is the only place that knows what this
      // browser calls a pixel.
      physicalScreenFrom(
        manifest?.screen?.panelWidthMm,
        manifest?.screen?.panelHeightMm,
        manifest?.screen?.readDistanceMm,
      ),
    );

  const draw = (): void => {
    if (manifest === undefined) {
      /*
       * Nothing to draw is not a stopped renderer, and the watchdog cannot
       * tell them apart on its own: `lastDrawAt` advances only in here, so a
       * wall waiting to be paired or waiting for its first manifest read as a
       * dead loop and reloaded every ninety seconds — wiping a half-typed
       * pairing code, which on a television remote is most of the work. Saying
       * so here rather than at each caller is what keeps the margin honest: on
       * the branches it advances the poll is sixty seconds and `drawSilenceMs`
       * is sixty seconds, so a few milliseconds of jitter fired it anyway. The
       * tick runs every fifteen. The two-hour contact-silence limit is the one
       * that covers a server which never answers, and `watchdog.ts` says as
       * much in its own comments.
       */
      lastDrawAt = Date.now();
      return;
    }
    const now = clock.now();
    const geo = geometry();
    applyGeometry(geo);
    const model = buildModel({ manifest, now, lastConfirmedAt, offline });

    // Which blocks are on screen, for the few layout rules that need to know
    // one is absent. A space-separated attribute so `~=` can test it, which
    // works everywhere; `:has()` would not.
    document.documentElement.setAttribute('data-blocks', model.blocks.join(' '));

    // The theme is re-evaluated on every draw rather than only on a new
    // manifest, or the switch to the daylight theme would wait for a calendar
    // to change rather than for the sun to come up.
    const local = localTime(now, manifest.timezone);
    const day = daytimeActive(
      local,
      manifest.theme.daytime,
      manifest.theme.daytimeStartsAt,
      manifest.theme.daytimeEndsAt,
    );
    applyTheme(
      document.documentElement,
      day && manifest.theme.daytime !== undefined ? manifest.theme.daytime : manifest.theme.active,
      day ? manifest.theme.daytimeTokens : manifest.theme.activeTokens,
      day ? manifest.theme.daytimeShape : manifest.theme.activeShape,
    );
    /*
     * One rendering path: every wall is free-form. `pickCanvas` returns the
     * arranged canvas for this orientation (or the other one, letterboxed), or
     * an empty canvas when nothing is arranged — `renderFreeform` draws a
     * "nothing yet" note for that rather than a blank wall.
     */
    const canvas = pickCanvas(manifest.layout, geo.layout);
    renderFreeform(root, model, canvas);
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
        if (manifest !== undefined && shouldKeepHeld(heldIsReal, outcome.manifest)) {
          /*
           * The server is answering, and answering with its stand-in. Keep the
           * calendar rather than trading it for an empty document, and take
           * the one thing the stand-in came to say: its notice, which is the
           * only text naming the fault.
           *
           * `offline` stays false, because it is not — the wall reached the
           * server and the server replied. `lastConfirmedAt` deliberately does
           * not advance instead, so the banner becomes "Last updated N ago" on
           * its own once the calendar is old enough, which is true, over a
           * notice that says why. Marking it offline would have drawn "Not
           * reaching the server" above a notice from that very server.
           */
          manifest = keepHeld(manifest, outcome.manifest);
          lastContactAt = Date.now();
          offline = false;
          break;
        }
        manifest = outcome.manifest;
        heldIsReal = !isStandInManifest(outcome.manifest);
        lastConfirmedAt = clock.now();
        lastContactAt = Date.now();
        offline = false;
        /*
         * Kept for the next reload — unless it is the server's stand-in.
         *
         * That document is empty by design and carries the reason as a notice,
         * so drawing it is right; remembering it is not. Saving it overwrote
         * the last calendar this wall had, and a reload then had nothing to
         * fall back to — the whole point of the store, spent on the one poll
         * that proves the server cannot supply the real thing. Awaited so a
         * save that is going to fail does so before the wall is told
         * everything is fine.
         */
        if (!isStandInManifest(outcome.manifest)) {
          await store.save({ manifest: outcome.manifest, confirmedAt: lastConfirmedAt });
        }
        break;
      case 'unchanged':
        clock.sync(outcome.serverTime);
        lastConfirmedAt = clock.now();
        lastContactAt = Date.now();
        offline = false;
        break;
      case 'unpaired':
        manifest = undefined;
        heldIsReal = false;
        /*
         * A marked 401 is proof the server answered, so this is contact. Without
         * it a screen sitting on the pairing form tripped the two-hour
         * contact-silence limit and was reloaded for ever — the same cost as
         * the ninety-second draw-silence one, and the same code being typed on
         * a remote lost with it.
         */
        lastContactAt = Date.now();
        offline = false;
        // Render the code-entry form once. Redrawing it every poll would clear
        // the field between keystrokes on a remote, which is slow enough already.
        if (!pairingShown) {
          pairingShown = true;
          renderPairing(root, submitPairingCode);
        }
        return;
      case 'failed':
        // Deliberately keeps the last manifest. The banner will say how old it
        // is; the calendar is still the most useful thing on the wall.
        /*
         * But a refusal is not an unreachable server, and saying so was three
         * faults at once. A wall holding a calendar drew "Not reaching the
         * server" while the server was up and answering — the same false
         * sentence the keep-held branch above exists to avoid. `lastContactAt`
         * stopped advancing, so a persistent refusal tripped the two-hour
         * contact-silence limit and reloaded a wall that was talking to its
         * server every sixty seconds, which is the case `watchdog.ts` says
         * that limit is *not* for. And the flag is owned rather than merely
         * set: a wall that was offline and is now being refused is no longer
         * offline.
         *
         * What stays frozen either way is `lastConfirmedAt`, so the banner
         * tells the truth on its own — "Last updated N ago" — without claiming
         * a cause it cannot know.
         */
        offline = !outcome.answered;
        if (outcome.answered) lastContactAt = Date.now();
        /*
         * Except that a wall with no manifest at all has no banner either —
         * `draw` returns at its first line — so it would sit on the boot
         * message, "Waiting for the first update…", for as long as the fault
         * lasted. That sentence is true for the first minute and a lie by the
         * tenth, on the one screen with nothing else on it: a household
         * looking at a wall that has never worked is owed the reason rule nine
         * promises rather than a hopeful ellipsis. This is the shape of a
         * screen booted during an outage — a server that is down, or one
         * answering "not just now" because it cannot read its own database.
         */
        if (manifest === undefined && !pairingShown) {
          /*
           * Never over the pairing form. `renderMessage` clears the root, and
           * `pairingShown` is only ever set — so one failed poll during pairing
           * (a restart, a LAN blip, this route's own 503) would wipe a
           * half-typed code and the form would never be drawn again. The screen
           * would sit saying the server is unreachable while the server was up
           * and waiting to be paired.
           */
          /*
           * A refusal and an unreachable server both arrive as `failed`, and
           * only one of them can explain itself. When the server answered with
           * a sentence — "This wall could not be built just now", and what the
           * screen will do about it — that is the one to draw: it is written
           * for somebody standing in a kitchen and it names a fault they can
           * act on, where the line below would send them looking at the
           * network for a server that is up.
           */
          renderMessage(
            root,
            'Maverick Wall',
            outcome.serverSaid ??
              (outcome.answered
                ? 'This wall’s server answered, but not with a wall. Nothing has arrived yet — it keeps trying.'
                : 'Not reaching this wall’s server. Nothing has arrived yet — it keeps trying.'),
          );
        }
        break;
    }
    // Through `safely`, like the tick does: a poll-driven draw gets the same
    // protection, and the focus that follows a redraw is applied in one place.
    safely(draw);
  };

  /*
   * Pairing this screen by code.
   *
   * Posts the short code from the admin's pairing page. On success the server
   * has set the display cookie, so a reload restarts the normal boot path fully
   * paired — simpler and more certain than trying to poll on from here. On
   * failure the message is passed straight back to the form for the person at
   * the screen to read.
   */
  const submitPairingCode = async (code: string): Promise<{ ok: boolean; message?: string }> => {
    const response = await fetch('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // Accept the Set-Cookie the server sends back.
      credentials: 'same-origin',
      body: new URLSearchParams({ code }).toString(),
    });
    if (response.ok) {
      location.reload();
      return { ok: true };
    }
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === 'string') return { ok: false, message: payload.message };
    } catch {
      // No JSON body; the form falls back to its own wording.
    }
    return { ok: false };
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
    /*
     * Not when a chore's tick box has focus.
     *
     * The OK key acknowledges whatever is showing rather than whatever has
     * focus, which is right for a remote pointed at a wall — but a native
     * `<button>` also fires its own click on Enter, so with a *banner* up (which
     * does not cover the wall) one press would tick the chore and clear the
     * banner at the same time. Two actions from one key, and only one of them
     * asked for.
     */
    if (document.activeElement?.closest?.('[data-chore]') !== null &&
        document.activeElement?.closest?.('[data-chore]') !== undefined) {
      return;
    }
    const key = dismissTarget();
    if (key === undefined) return;
    event.preventDefault();
    void acknowledge(key);
  });

  /*
   * Ticking a chore off (RFC 008 phase 3).
   *
   * Deliberately the same shape as `acknowledge`, including what it does when
   * it fails: nothing. The wall does not paint the box in and hope — the server
   * decides whether a chore is done, and the row only changes when the next
   * document says so. That is a *choice*, not a missing feature: an optimistic
   * tick with a retry queue reads better on one screen and buys a
   * distributed-state problem across two, for a feature whose worst case is
   * "press it again". Offline, the box stays empty, which is the honest answer.
   *
   * What it does not send is the day. A wall tablet's clock drifts and plenty
   * never get NTP, so the server resolves the household's civil date; the
   * client says which chore and whether it is done, and nothing else.
   *
   * The immediate re-poll is what makes it feel like a button rather than
   * something that eventually happens.
   */
  const tickChore = async (id: string, done: boolean): Promise<void> => {
    try {
      const response = await fetch('/d/chores/tick', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // The display token is an HttpOnly cookie set at pairing.
        credentials: 'same-origin',
        body: new URLSearchParams({ id, done: done ? '1' : '0' }).toString(),
      });
      // A 403 means this screen may not tick; a 409 means the chore is not due
      // today. The server is the authority on both, so nothing happens here —
      // the same as a rule that said an interrupt may not be cleared.
      if (!response.ok) return;
    } catch {
      return;
    }
    await poll();
  };

  root.addEventListener('click', (event: Event) => {
    const target = event.target as Element | null;

    const chore = target?.closest?.('[data-chore]');
    if (chore !== null && chore !== undefined) {
      const id = chore.getAttribute('data-chore') ?? '';
      // `aria-pressed` is the row's current state, so the press asks for its
      // opposite — one attribute, read by the handler and by a screen reader,
      // rather than a second source of truth that can disagree with the paint.
      if (id !== '') void tickChore(id, chore.getAttribute('aria-pressed') !== 'true');
      return;
    }

    const key = target?.closest?.('[data-dismiss]')?.getAttribute('data-dismiss');
    if (key === null || key === undefined || key === '') return;
    void acknowledge(key);
  });

  /*
   * A narrow bridge for the native shell, and nothing else.
   *
   * The Android app hosts this exact page in a WebView (it does not re-implement
   * the wall), and there are two things it needs that a page cannot do for
   * itself. When a push says the manifest changed — or a dark screen has just
   * been woken for a warning — it calls `poll()` so the wall reacts at once
   * instead of waiting out the sixty-second interval. And when a remote's OK is
   * pressed it calls `acknowledge()`, because D-pad focus is unreliable across
   * the WebViews bolted to walls, so the app forwards the key here rather than
   * hoping the page's own `keydown` sees it (`render.ts`/the handler above).
   *
   * This is not a plugin surface: it exposes only the two verbs the shell
   * already drives through the UI, calls the same `poll`/`acknowledge` a
   * fingertip does, and is inert in a browser where nothing ever calls it.
   * `acknowledge()` clears whatever is showing, exactly as the OK key does, and
   * a rule the server marked non-dismissible is still refused server-side (a
   * 403), so the bridge cannot clear what a button could not.
   */
  const bridge = {
    poll: (): void => void poll(),
    acknowledge: (): void => {
      const key = dismissTarget();
      if (key !== undefined) void acknowledge(key);
    },
  };
  (window as unknown as { maverickWall?: typeof bridge }).maverickWall = bridge;

  /*
   * Re-poll when the page becomes visible again.
   *
   * A screen woken from black for a tornado warning fires exactly this, so the
   * warning is on the wall the moment it lights rather than up to a minute
   * later. Harmless on a browser tab a household switches back to; it just gets
   * a fresh calendar a little sooner.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
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
    // `shouldAdoptStored` rather than "nothing yet": the poll is not waited for,
    // so on a slow tablet the server can answer first — and an empty stand-in
    // must not beat the household's real calendar to the screen.
    // `!pairingShown` for the same reason the message below the poll has it:
    // the 401 can win this race, and drawing a calendar over the code-entry
    // form would take the form away for good.
    if (stored !== undefined && !pairingShown && shouldAdoptStored(heldIsReal)) {
      /*
       * This no longer only runs before the first poll — that is the whole
       * point of `shouldAdoptStored`, which lets the stored calendar in over a
       * stand-in that won the race. So anything the stand-in was carrying has
       * to come with it: its notice is the only text naming the fault, and
       * dropping it here would blank the reason until the next poll a minute
       * later put it back.
       */
      /*
       * Shape-checked before it is drawn, not only before it is classified.
       * `isStandInManifest` survives a stored document with no `notices`, but
       * `buildModel` then does `manifest.notices.map(...)` and throws — inside
       * `safely`, which swallows it, so the wall sits on the boot message and
       * gets reloaded into the same failure for ever. A cache this bundle
       * cannot draw is worth exactly as much as no cache.
       */
      if (!isRenderableManifest(stored.manifest)) return;
      manifest = manifest === undefined ? stored.manifest : keepHeld(stored.manifest, manifest);
      /*
       * Asked, not assumed. This bundle never saves the stand-in — but the
       * store outlives a release, and one written before this fix can hold one;
       * treating that as the household's calendar would pin an empty document
       * under a days-old banner.
       */
      heldIsReal = !isStandInManifest(stored.manifest);
      lastConfirmedAt = stored.confirmedAt;
      /*
       * And only when nothing has answered yet. `lastContactAt` moves off
       * `startedAt` the moment a poll succeeds, so this says "no poll has ever
       * got through" — without it, a stored copy arriving late would relabel a
       * server that had just replied as unreachable, and nothing would clear
       * the flag again.
       */
      if (lastContactAt === startedAt) offline = true;
      safely(draw);
    }
  });

  void poll();
  setInterval(() => void poll(), POLL_MS);
  setInterval(() => safely(draw), TICK_MS);

  /*
   * Draw again once the webfonts have landed, because a fit is computed once
   * and never revisited.
   *
   * `fitToBox` measures its section as it appends it and writes a `scale()`
   * that nothing recomputes; the faces are `font-display: swap`, so a first
   * paint that beats the font measures *fallback* metrics. Measured on a
   * 1080x1920 Classic wall: the agenda is 812px tall on the fallback and 816px
   * with the real face, so the fit comes out `532.24/812` rather than
   * `532.24/816` — half a percent too large, permanently, on a section whose
   * box is `overflow: hidden`. The last row clips and nothing on the wall says
   * why.
   *
   * The 15-second tick already corrects it, so what this buys is the first
   * fifteen seconds after a cold load — which is exactly when somebody is
   * standing in front of it, having just turned the screen on or come back
   * from a power cut. It is one extra draw on a wall that redraws four times a
   * minute anyway.
   *
   * Deliberately a redraw rather than a re-fit: every decision this bundle
   * takes from measured text has the same hazard (the month tier pass, the week
   * fallback, the agenda's time column), and they are all taken inside a draw.
   * Re-running the draw fixes the class; re-fitting one section fixes one
   * symptom.
   *
   * Guarded because the CSS Font Loading API is not everywhere, and a tablet
   * that has never heard of it must lose the correction rather than the wall
   * (rule nine). `catch` for the same reason: `ready` is not specified to
   * reject, and an unhandled rejection is not worth a wall to find out.
   */
  const fontSet = (document as unknown as { readonly fonts?: { readonly ready?: Promise<unknown> } })
    .fonts;
  if (fontSet?.ready !== undefined) {
    void fontSet.ready.then(() => safely(draw)).catch(() => undefined);
  }

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
