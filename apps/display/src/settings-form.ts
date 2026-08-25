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
   * The Weather screen's form holds three submits and only one is marked. The
   * visible Save is. The Home Assistant button is not — disabling a control
   * whose whole job is to fill a field in, until a field has been filled in,
   * is a control that does nothing. And the clipped first submit
   * (`defaultSubmit()`, which is what "press Enter" resolves to) is not marked
   * *deliberately*: the spec says implicit submission does nothing when the
   * first submit is disabled, engines have not always agreed, and one that
   * walks on to the first enabled submit would reach the Home Assistant button
   * and overwrite the coordinates being typed. Enter must mean Save on every
   * engine, so that one stays live even while Save is greyed.
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

/**
 * Does this form already hold something different from what the server sent?
 *
 * The dirty flag cannot come from the server alone, because a *browser* can put
 * edits back on screen without telling anyone: reload a page with an unsaved
 * change and Chromium restores the controls, so the timezone select comes back
 * reading "Europe/Paris" over a database that still says London — with Save
 * disabled, no Cancel, no "Not saved yet", and the leave guard down. That is
 * precisely the "the fields show the new value" ambiguity this phase exists to
 * remove, reintroduced by the fix for it.
 *
 * So it is measured rather than assumed: every control against the value the
 * markup declared. `defaultValue` / `defaultChecked` / `defaultSelected` are the
 * DOM's words for "what the attribute said", which is exactly the server's copy
 * — a comparison against the live value with nothing else to consult.
 *
 * File inputs are skipped: a server cannot set one, so there is no default to
 * differ from.
 */
function looksEdited(form: HTMLFormElement): boolean {
  const controls = Array.prototype.slice.call(form.elements) as Element[];
  for (const control of controls) {
    if (control instanceof HTMLInputElement) {
      if (control.type === 'checkbox' || control.type === 'radio') {
        if (control.checked !== control.defaultChecked) return true;
      } else if (control.type === 'color') {
        /*
         * `<input type="color">` normalises: it lowercases the hex it is given,
         * while `defaultValue` hands back the attribute as written. The
         * calendar rows ship `#4C7FD1`, so a plain string compare made *every*
         * unowned row boot dirty — Save live and "Not saved yet" showing on a
         * page nobody had touched, and a leave prompt on the way out.
         */
        if (control.value.toLowerCase() !== control.defaultValue.toLowerCase()) return true;
      } else if (control.type !== 'file' && control.value !== control.defaultValue) {
        return true;
      }
    } else if (control instanceof HTMLTextAreaElement) {
      if (control.value !== control.defaultValue) return true;
    } else if (control instanceof HTMLSelectElement) {
      const options = Array.prototype.slice.call(control.options) as HTMLOptionElement[];
      for (const option of options) {
        if (option.selected !== option.defaultSelected) return true;
      }
    }
  }
  return false;
}

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
   *
   * The second source is the browser itself — see `looksEdited`.
   */
  let dirty = form.dataset['dirty'] === 'dirty' || looksEdited(form);

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
   * Any submit on the page is a deliberate departure — not just this form's.
   *
   * A settings form rarely has a page to itself. Weather carries five
   * "Turn off" rule cards beside it, Calendars a Sync now, a Remove and an Add
   * per row, System a "Check for updates now", and every admin page carries the
   * sidebar's Sign out. Armed only by the wired forms' own submits, the guard
   * asked "Changes you made may not be saved" when a household changed Units
   * and then pressed Turn off on a rule — and answering Stay cancelled the
   * POST, so the rule stayed on with nothing said. That is the fault the shared
   * flag fixed between sibling settings forms, left open for everything else
   * beside them.
   *
   * A *submit* is the right signal and a click is not: RFC 009 1.7's lesson was
   * a document-level listener on `a[href]` clicks, which armed on any stray
   * click in a link and disarmed the guard for good. A form being submitted is
   * unambiguous, and native constraint validation blocks the event entirely, so
   * a submission the browser refuses never reaches this. In the capture phase,
   * so a handler that stops propagation cannot hide one.
   */
  document.addEventListener('submit', () => {
    navigating = true;
  }, true);

  /*
   * There is deliberately no second way to re-arm the guard.
   *
   * One was tried: any pointer or key on the page means the household is still
   * here, so the last submit took them nowhere. It was a belt for engines this
   * box cannot drive — the concern being that a submit whose response is an
   * attachment might not fire `beforeunload` (System carries three downloads
   * beside two of these forms). Measured, Chromium fires it when the navigation
   * *starts*, before the headers can say `Content-Disposition`, and that
   * reasoning is about what an engine cannot yet know, so it should hold
   * everywhere.
   *
   * The belt's own cost turned out to be worse than the fault it guarded, and
   * it is not hypothetical: `POST /admin/weather/use-ha-location` waits on a
   * request to Home Assistant, so a household who clicks anything while it is
   * in flight would re-arm the guard and be asked "Changes you made may not be
   * saved" about a save they had just made — and answering Stay cancels the
   * navigation after the write has already committed. There is no way to tell
   * "this navigation is pending" from "this navigation was abandoned" without
   * a timer, and a timer on a Raspberry Pi is the same bug wearing a delay.
   */

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
