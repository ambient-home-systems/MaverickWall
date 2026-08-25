/**
 * Dirty state for the server-rendered settings forms (RFC 009 Phase 3.2).
 *
 * Save was always enabled and there was no Cancel, on every settings form in
 * the product — except the wall editor, which gets it exactly right: Save
 * disabled until dirty, Discard hidden until there is something to discard, and
 * a flag that says so. This is that pattern lifted out of
 * `display-editor.ts`'s save bar rather than written a second time beside it.
 *
 * The difference is what it is attached to. The editor's bar saves *two*
 * things — a canvas through a bridge on `window`, then a settings form — so it
 * owns a two-source dirty flag and an async save. A settings page has one
 * form and a submit button, so the whole of this is: watch for an edit, reflect
 * it on three controls, and guard the leave. Everything else there stays there.
 *
 * **Script is allowed here, and it was decided rather than assumed** (RFC 009,
 * Decisions taken). The no-script fence covers the wizard and sign-in — the
 * screens that must work before anything else does, and the two
 * `wizard-noscript.test.ts` holds to it — and nothing else. The Home
 * Assistant, Themes and wall pages already ship script.
 *
 * **It must still degrade to today's behaviour**, and the markup is what
 * guarantees that rather than any care taken here: the server renders Save as
 * a plain enabled submit and renders Cancel and the flag `hidden`. A household
 * who blocks script gets the form exactly as it has always been. Everything
 * below is an enhancement applied *after* that markup arrives — which is why
 * Save is disabled here, on boot, and never in the HTML.
 */

/** Every control this manages, resolved once per form. */
interface Parts {
  readonly form: HTMLFormElement;
  readonly saves: readonly HTMLButtonElement[];
  readonly cancel: HTMLElement | null;
  readonly flag: HTMLElement | null;
}

function partsOf(form: HTMLFormElement): Parts {
  /*
   * Every control marked `data-dirty-save`, and there can be two.
   *
   * A form with a second submit posting elsewhere — the Weather screen's "Use
   * my Home Assistant home location", which carries a `formaction` so it
   * travels with the unsaved fields — also carries a clipped first submit, so
   * that pressing Enter means Save rather than that button. Both are marked,
   * and they have to enable and disable together or the form has two answers
   * to "is there anything to save".
   *
   * What is *not* marked is that Home Assistant button itself: disabling it
   * would be a control whose whole job is to fill a field in refusing to work
   * until a field has been filled in.
   */
  const saves: HTMLButtonElement[] = [];
  const found = form.querySelectorAll<HTMLButtonElement>('[data-dirty-save]');
  for (let index = 0; index < found.length; index++) {
    const one = found[index];
    if (one !== undefined) saves.push(one);
  }
  return {
    form,
    saves,
    cancel: form.querySelector<HTMLElement>('[data-dirty-cancel]'),
    flag: form.querySelector<HTMLElement>('[data-dirty-flag]'),
  };
}

/**
 * Whether the page is leaving on purpose — one flag for the whole document, not
 * one per form.
 *
 * The System screen carries two of these forms, and a per-form flag made
 * pressing Save on one raise the *other* one's "Changes you made may not be
 * saved" prompt: the household presses Save, is asked whether they meant it,
 * and answering "Stay" cancels the save. Pressing Save is not leaving without
 * saving, so it must not be second-guessed by a sibling form. The cost is
 * honest and is what HTML does anyway — two forms on a page are two
 * submissions, and saving one has always discarded edits typed into the other
 * (with script off it still does, silently). The strip then says which one
 * saved.
 *
 * Set only by a submit and by Cancel — deliberately not by a document-level
 * link or click listener, which is the shape that let one stray click on a nav
 * link disarm the editor's guard for good (RFC 009, 1.7).
 */
let navigating = false;

/** Every wired form, for the one guard below to ask. */
const wired: { isDirty(): boolean }[] = [];

function wire(form: HTMLFormElement): void {
  const parts = partsOf(form);
  // Nothing to enhance: a form marked dirty-aware with no Save is a markup
  // mistake, and disabling nothing quietly would hide it rather than fix it.
  if (parts.saves.length === 0) return;

  /*
   * A form re-rendered at 400 arrives already dirty, and only the server knows
   * it: the markup carries the household's echoed, *unsaved* values, so booting
   * clean would disable Save, hide Cancel and disarm the leave guard on exactly
   * the page where all three matter most — and would leave an error they cannot
   * fix by editing a field ("Home Assistant is not connected") staring at a
   * Save they cannot press.
   */
  let dirty = form.dataset['dirty'] === 'dirty';

  const refresh = (): void => {
    for (const save of parts.saves) save.disabled = !dirty;
    if (parts.cancel !== null) parts.cancel.hidden = !dirty;
    if (parts.flag !== null) parts.flag.hidden = !dirty;
  };

  const mark = (): void => {
    if (dirty) return;
    dirty = true;
    refresh();
  };
  // Both events: `input` covers typing, `change` covers a checkbox, a select
  // and a file input, which fire no `input` in every browser this has to run on.
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);

  /*
   * Submit rather than the Save button's click.
   *
   * Enter in a text field submits the form without the button being pressed at
   * all, and the second submit button (`formaction`) posts this form too. Both
   * are deliberate departures, and both would otherwise trip the leave guard on
   * the way out.
   */
  form.addEventListener('submit', () => {
    navigating = true;
  });

  if (parts.cancel !== null) {
    parts.cancel.addEventListener('click', () => {
      navigating = true;
      /*
       * Where the page says, not where the browser happens to be.
       *
       * A form re-rendered at 400 leaves the address bar on the POST URL, so
       * `reload()` would re-submit the very edits Cancel is meant to throw away
       * and `location.pathname` would ask for a route that only answers POST.
       * The attribute names the settings page itself, and it is relative — the
       * one `<base>` element is what carries it through Home Assistant ingress.
       */
      const target = parts.cancel?.getAttribute('data-dirty-cancel');
      if (target === null || target === undefined || target === '') window.location.reload();
      else window.location.assign(target);
    });
  }

  wired.push({ isDirty: () => dirty });
  refresh();
}

function boot(): void {
  const forms = document.querySelectorAll<HTMLFormElement>('form[data-dirty]');
  for (let index = 0; index < forms.length; index++) {
    const form = forms[index];
    if (form !== undefined) wire(form);
  }
  if (wired.length === 0) return;

  /*
   * One guard for the document, asking every form.
   *
   * Registered once rather than per form, which is what makes the shared
   * `navigating` flag work: with a listener each, the first to run would clear
   * the flag and the second would then see a false one and prompt on a
   * deliberate save.
   */
  window.addEventListener('beforeunload', (event) => {
    if (navigating) {
      /*
       * Disarmed for one navigation, not for good.
       *
       * `navigating` used to latch — set by a submit and cleared by nothing —
       * so a navigation that was cancelled left the guard dead for the rest of
       * the page's life. Clearing it here is the natural place: if the
       * navigation goes ahead the document is gone and the flag never mattered,
       * and if anything cancels it the guard is armed again.
       */
      navigating = false;
      return;
    }
    if (!wired.some((form) => form.isDirty())) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// No runtime imports, so mark this a module (not a global script) to keep `boot`
// out of the shared script scope the other bundles compile into.
export {};
