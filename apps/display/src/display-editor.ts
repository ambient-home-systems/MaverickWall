/**
 * The wall editor's page chrome — the second (and smaller) of the admin's
 * client-side apps, beside `layout-editor.ts`.
 *
 * Vanilla TS, ES2019, same-origin: it ships in the image and loads on the two
 * admin pages that host the layout editor — the per-display page and the
 * e-paper design page. The server renders the shell; this wires it:
 *
 *   - **Layout / Wall settings**, the two modes the editor is organised
 *     around. One is on screen at a time, which is the whole redesign: the
 *     canvas, the selected widget and the wall's own settings used to run into
 *     one another down a single column.
 *   - **The settings categories** inside Wall settings — a rail beside the
 *     panel on a wide screen, one focused screen at a time on a phone.
 *   - **Progressive disclosure**: a daylight window that is not drawn until a
 *     daytime theme is chosen, a number field that is not drawn while the wall
 *     inherits the household's.
 *   - the overflow menu, the "?" help popovers, and
 *   - the single save action.
 *
 * There used to be two saves: the layout editor's own button, and the settings
 * form's submit. There is one now. The layout editor publishes a bridge on
 * `window` (`mwEditor`); this bar saves the layout through it, then submits the
 * settings form — so the canvas and every category persist together. Dirty
 * state is the union of the editor's and the form's, and both the leave-guard
 * and the bar's own enabled state key off it.
 *
 * The settings form is optional on purpose: the e-paper design page has no
 * settings beside the canvas, so there the save bar saves the layout and
 * reloads — the same clean slate the display page gets from its settings
 * POST's redirect back. The savebar is the marker that this is an editor page;
 * a page with neither savebar nor form gets none of this. Losing that
 * distinction is exactly how the e-paper editor silently broke once: the
 * mount used to emit its own script tag, the two-pane redesign moved script
 * emission into the display page, and the other host page kept the mount but
 * lost the editor.
 */

interface EditorBridge {
  saveCurrent(): Promise<{ ok: boolean; message?: string }>;
  isDirty(): boolean;
}
type EditorWindow = typeof window & {
  mwEditor?: EditorBridge;
  mwEditorState?: (state: { dirty: boolean }) => void;
};

/** Which mode and which settings category to reopen on. Per browser, so a
 *  schema column would be the wrong home; keyed to the origin, so the ingress
 *  path changing under it does not matter. */
const MODE_KEY = 'mw-wall-mode';
const CATEGORY_KEY = 'mw-wall-category';

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser with storage disabled simply forgets where you were.
  }
}
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * One tablist: buttons that carry `aria-selected`, roving tabindex, and the
 * arrow keys the pattern requires. Selecting is what the caller does with the
 * key it is handed — this only owns the control's own semantics.
 */
function wireTabs(
  tabs: readonly HTMLButtonElement[],
  keyOf: (tab: HTMLButtonElement) => string | undefined,
  select: (key: string) => void,
  vertical: boolean,
): void {
  const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
  const next = vertical ? 'ArrowDown' : 'ArrowRight';
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => {
      const key = keyOf(tab);
      if (key !== undefined) select(key);
    });
    tab.addEventListener('keydown', (event) => {
      let target = -1;
      if (event.key === previous) target = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === next) target = (index + 1) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      if (target === -1) return;
      event.preventDefault();
      const moved = tabs[target];
      if (moved === undefined) return;
      const key = keyOf(moved);
      if (key !== undefined) select(key);
      moved.focus();
    });
  }
}

/** Reflect the selected tab on every button in one tablist. */
function markTabs(tabs: readonly HTMLButtonElement[], keyOf: (t: HTMLButtonElement) => string | undefined,
  active: string, onClass: string): void {
  for (const tab of tabs) {
    const on = keyOf(tab) === active;
    tab.classList.toggle(onClass, on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  }
}

function boot(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-settings]');
  const bar = document.getElementById('savebar');
  // The save bar marks an editor page; everything else here is the display
  // page's own chrome (the e-paper design page has none of it).
  if (bar === null) return;

  // ---- Layout | Wall settings -------------------------------------------

  const modeTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode]'));
  const modePanels = Array.from(document.querySelectorAll<HTMLElement>('[data-mode-panel]'));
  const modeOf = (tab: HTMLButtonElement): string | undefined => tab.dataset['mode'];
  const selectMode = (name: string): void => {
    markTabs(modeTabs, modeOf, name, 'on');
    for (const panel of modePanels) panel.hidden = panel.dataset['modePanel'] !== name;
    remember(MODE_KEY, name);
  };
  if (modeTabs.length > 0) wireTabs(modeTabs, modeOf, selectMode, false);

  // ---- the settings categories ------------------------------------------

  const root = document.querySelector<HTMLElement>('[data-wset-root]');
  const catTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-wset]'));
  const catPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-wset-panel]'));
  const catOf = (tab: HTMLButtonElement): string | undefined => tab.dataset['wset'];
  /*
   * `drilled` is only meaningful below 1200px, where the rail and the panel are
   * one column and you are in either the list or a category. Above it both are
   * on screen and the class is inert — which is why the width is a CSS
   * question here and not a `matchMedia` this script has to keep in step.
   */
  const selectCategory = (name: string, drill: boolean, focus: boolean): void => {
    markTabs(catTabs, catOf, name, 'is-on');
    for (const panel of catPanels) panel.hidden = panel.dataset['wsetPanel'] !== name;
    root?.classList.toggle('is-drilled', drill);
    remember(CATEGORY_KEY, drill ? name : '');
    if (!focus) return;
    const heading = catPanels
      .find((panel) => panel.dataset['wsetPanel'] === name)
      ?.querySelector<HTMLElement>('h3');
    heading?.focus();
  };
  if (catTabs.length > 0) {
    wireTabs(catTabs, catOf, (name) => selectCategory(name, true, true), true);
  }
  for (const back of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-wset-back]'))) {
    back.addEventListener('click', () => {
      const panel = back.closest<HTMLElement>('[data-wset-panel]');
      const name = panel?.dataset['wsetPanel'];
      root?.classList.remove('is-drilled');
      remember(CATEGORY_KEY, '');
      // Back to the row you came in through, not to the top of the document.
      catTabs.find((tab) => catOf(tab) === name)?.focus();
    });
  }

  // Reopen where this browser left off — unless the server chose the mode
  // itself, which it does when a save came back with something to fix.
  const serverMode = modeTabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  if (modeOf(serverMode ?? modeTabs[0] ?? document.createElement('button')) === 'layout') {
    const saved = recall(MODE_KEY);
    if (saved === 'settings' || saved === 'layout') selectMode(saved);
  }
  const savedCategory = recall(CATEGORY_KEY);
  if (savedCategory !== null && savedCategory !== '' && catTabs.some((t) => catOf(t) === savedCategory)) {
    selectCategory(savedCategory, true, false);
  }

  // ---- progressive disclosure -------------------------------------------

  /*
   * A control that does nothing is worse than a control that is not offered.
   * Two shapes of that here, and both are presentation only — the stored
   * shapes and the handler's reading of them are untouched.
   */

  // A block shown only while the named select holds a real value. `empty` names
  // the value that counts as "nothing chosen" when it is not the empty string
  // (the household form spells its own "no daytime theme" as `none`).
  for (const block of Array.from(document.querySelectorAll<HTMLElement>('[data-reveal-if]'))) {
    const name = block.dataset['revealIf'];
    const empty = block.dataset['revealEmpty'] ?? '';
    const control = name === undefined ? null : document.querySelector<HTMLSelectElement>(`[name="${name}"]`);
    if (control === null) continue;
    const sync = (): void => {
      block.hidden = control.value === '' || control.value === empty;
    };
    control.addEventListener('change', sync);
    sync();
  }

  // "Use the household default" — on, and the number is not asked for; the
  // input is disabled so the browser sends nothing at all, which is exactly
  // the blank the handler reads as "follow the household".
  for (const toggle of Array.from(
    document.querySelectorAll<HTMLInputElement>('[data-inherit-toggle]'),
  )) {
    const name = toggle.dataset['inheritToggle'];
    const field = document.querySelector<HTMLElement>(`[data-inherit-field="${name}"]`);
    if (field === null) continue;
    const input = field.querySelector<HTMLInputElement>('input');
    const sync = (): void => {
      field.hidden = toggle.checked;
      if (input !== null) input.disabled = toggle.checked;
    };
    toggle.addEventListener('change', () => {
      sync();
      if (toggle.checked || input === null) return;
      // An empty override is not an override — the handler reads a blank as
      // "follow the household", so the switch would spring back on at the next
      // save. Seed it with the value it was following.
      if (input.value === '') input.value = field.dataset['inheritDefault'] ?? '';
      // Turning inheritance off asks for a number, so put the cursor in it.
      input.focus();
      input.select();
    });
    sync();
  }

  // ---- the overflow menu -------------------------------------------------

  // A <details>, so it opens with no script; this only adds what a menu owes a
  // keyboard: Escape closes it and hands focus back to the control that opened
  // it, and a click anywhere else closes it too.
  const overflow = document.querySelector<HTMLDetailsElement>('[data-overflow]');
  if (overflow !== null) {
    const summary = overflow.querySelector('summary');
    document.addEventListener('click', (event) => {
      if (!overflow.open) return;
      if (!overflow.contains(event.target as Node)) overflow.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !overflow.open) return;
      overflow.open = false;
      (summary as HTMLElement | null)?.focus();
    });
  }

  // ---- "?" help popovers ------------------------------------------------

  const closeHelp = (except?: HTMLElement): void => {
    for (const pop of document.querySelectorAll<HTMLElement>('.helppop')) {
      if (pop !== except) pop.hidden = true;
    }
  };
  for (const help of document.querySelectorAll<HTMLButtonElement>('.fieldhelp[data-help]')) {
    help.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = help.dataset['help'];
      const pop = id === undefined ? null : document.getElementById(id);
      if (pop === null) return;
      const willOpen = pop.hidden;
      closeHelp();
      pop.hidden = !willOpen;
    });
  }
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('.helppop') === null && target?.closest('.fieldhelp') === null) closeHelp();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeHelp();
  });

  // ---- the one save -----------------------------------------------------

  const flag = bar.querySelector<HTMLElement>('[data-dirty-flag]');
  const saveButton = bar.querySelector<HTMLButtonElement>('[data-action="save"]');
  const discardButton = bar.querySelector<HTMLButtonElement>('[data-action="discard"]');
  const message = bar.querySelector<HTMLElement>('.msg');

  let settingsDirty = false;
  let editorDirty = false;
  // True while we are intentionally leaving (a save, a discard, a link, a form
  // submit) so the beforeunload guard does not second-guess a deliberate action.
  let navigating = false;

  const isDirty = (): boolean => settingsDirty || editorDirty;
  const refresh = (): void => {
    if (flag !== null) flag.hidden = !isDirty();
    // Nothing to save reads as nothing to save, and nothing to throw away
    // reads as no Discard at all.
    if (saveButton !== null) saveButton.disabled = !isDirty();
    if (discardButton !== null) discardButton.hidden = !isDirty();
  };

  // The layout editor reports its dirty flag here whenever it flips.
  (window as EditorWindow).mwEditorState = (state): void => {
    editorDirty = state.dirty;
    refresh();
  };

  // Any edit to a settings field marks the page dirty — in any category, since
  // they are all panels of the one form.
  const markSettings = (): void => {
    settingsDirty = true;
    refresh();
  };
  form?.addEventListener('input', markSettings);
  form?.addEventListener('change', markSettings);

  const editor = (): EditorBridge | undefined => (window as EditorWindow).mwEditor;

  if (saveButton !== null) {
    saveButton.addEventListener('click', () => {
      void (async (): Promise<void> => {
        if (message !== null) message.textContent = '';
        saveButton.disabled = true;
        const bridge = editor();
        // Save the layout canvas first; a failure keeps us on the page with the
        // reason, rather than submitting the settings over a lost layout.
        const outcome = bridge === undefined ? { ok: true } : await bridge.saveCurrent();
        if (!outcome.ok) {
          if (message !== null) message.textContent = outcome.message ?? 'The layout did not save.';
          saveButton.disabled = false;
          return;
        }
        // Then persist the settings. The POST redirects back to this page, which
        // reloads the freshly saved canvas and settings — a clean slate. With no
        // settings form (the e-paper page), a plain reload is that clean slate.
        navigating = true;
        if (form !== null) form.submit();
        else window.location.reload();
      })();
    });
  }

  if (discardButton !== null) {
    discardButton.addEventListener('click', () => {
      navigating = true;
      window.location.reload();
    });
  }

  window.addEventListener('beforeunload', (event) => {
    if (!isDirty() || navigating) return;
    event.preventDefault();
    event.returnValue = '';
  });

  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// No runtime imports, so mark this a module (not a global script) to keep `boot`
// out of the shared script scope the other bundles compile into.
export {};
