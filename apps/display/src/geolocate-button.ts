/**
 * "Use this device's location" — progressive enhancement for the Weather
 * screen's place lookup (P2.3).
 *
 * The server renders the button `hidden`, and this is the only thing that
 * ever un-hides it: `window.isSecureContext && 'geolocation' in navigator`.
 * That fails on most plain-http LAN installs (a Docker box with no
 * certificate, reached by IP) and probably fails again inside the Home
 * Assistant sidebar iframe, which grants no `allow="geolocation"`. Both are
 * fine — a control that stays hidden costs nothing, where one that is shown
 * and then silently fails is worse than never having offered it.
 *
 * **Script is allowed here**, for the reason `settings-form.ts` already
 * states it for this screen: the no-script fence covers only the wizard and
 * sign-in. It fills the coordinate fields already on the form and dispatches
 * `input` on each — the event `settings-form.js`'s dirty-state watcher
 * listens for — so pressing this button marks the form dirty exactly as
 * typing into those fields would, with no second wiring into that script.
 */

function wire(button: HTMLButtonElement): void {
  const form = button.closest('form');
  if (form === null) return;
  const latitude = form.querySelector<HTMLInputElement>('[data-geolocate-lat]');
  const longitude = form.querySelector<HTMLInputElement>('[data-geolocate-lon]');
  if (latitude === null || longitude === null) return;

  button.hidden = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        latitude.value = String(position.coords.latitude);
        longitude.value = String(position.coords.longitude);
        latitude.dispatchEvent(new Event('input', { bubbles: true }));
        longitude.dispatchEvent(new Event('input', { bubbles: true }));
        button.disabled = false;
      },
      // A denied permission or an unavailable position: nothing was filled
      // in, so the household is exactly where they were before pressing it.
      () => {
        button.disabled = false;
      },
    );
  });
}

function boot(): void {
  if (!window.isSecureContext || !('geolocation' in navigator)) return;
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-geolocate]');
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index];
    if (button !== undefined) wire(button);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// No runtime imports, so mark this a module (not a global script) to keep
// `boot` out of the shared script scope the other bundles compile into.
export {};
