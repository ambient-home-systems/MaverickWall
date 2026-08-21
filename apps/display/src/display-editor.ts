/**
 * The display editor's page chrome — the second (and smaller) of the admin's
 * client-side apps, beside `layout-editor.ts`.
 *
 * Vanilla TS, ES2019, same-origin: it ships in the image and loads on the two
 * admin pages that host the layout editor — the per-display page and the
 * e-paper design page. The server renders the shell (on the display page a
 * two-pane layout with tabbed settings; on the e-paper page the preview and
 * the editor alone) and one sticky save bar at the foot. This wires that
 * chrome:
 *
 *   - the Look / Content / Device tabs (when the page has them),
 *   - the "?" help popovers that replaced the old prose paragraphs, and
 *   - the single save action.
 *
 * There used to be two saves: the layout editor's own button, and the settings
 * form's submit. There is one now. The layout editor publishes a bridge on
 * `window` (`mwEditor`); this bar saves the layout through it, then submits the
 * settings form — so the canvas and every tab persist together. Dirty state is
 * the union of the editor's and the form's, and the leave-guard keys off it.
 *
 * The settings form is optional on purpose: the e-paper design page has no
 * settings beside the canvas, so there the save bar saves the layout and
 * reloads — the same clean-slate the display page gets from its settings
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

function boot(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-settings]');
  const bar = document.getElementById('savebar');
  // The save bar marks an editor page; the settings form is the display
  // page's extra (the e-paper design page has none).
  if (bar === null) return;

  // ---- tabs -------------------------------------------------------------

  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.tabpanel[data-tabpanel]'));
  const selectTab = (name: string): void => {
    for (const tab of tabs) tab.classList.toggle('is-on', tab.dataset['tab'] === name);
    for (const panel of panels) panel.hidden = panel.dataset['tabpanel'] !== name;
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const name = tab.dataset['tab'];
      if (name !== undefined) selectTab(name);
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
  };

  // The layout editor reports its dirty flag here whenever it flips.
  (window as EditorWindow).mwEditorState = (state): void => {
    editorDirty = state.dirty;
    refresh();
  };

  // Any edit to a settings field marks the page dirty.
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

  // A real navigation (a link, a submitted form such as Reset) is deliberate.
  document.addEventListener('submit', () => { navigating = true; }, true);
  document.addEventListener(
    'click',
    (event) => {
      const el = event.target as Element | null;
      if (el?.closest('a[href]') !== null) navigating = true;
    },
    true,
  );

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
