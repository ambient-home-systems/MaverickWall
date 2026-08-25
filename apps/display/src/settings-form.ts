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
 * The form whose submit is taking the page away, if one is.
 *
 * Not a boolean, and that is the whole of a judgement this went round twice on.
 * A settings form rarely has a page to itself: Weather carries five "Turn off"
 * rule cards beside it, Calendars a Sync now and a Remove per row, System a
 * "Check for updates now", and every admin page the sidebar's Sign out.
 *
 * Armed only by a form's *own* submit, pressing any of those raised that form's
 * "Changes you made may not be saved" — read as a question about the button
 * just pressed, which it is not. Armed by *any* submit it never asked, and the
 * edits went silently, which is the loss this whole phase exists to remove.
 * Neither is the answer: what matters is not which button was pressed but
 * **whose work is about to go**. Saving this form is not leaving without
 * saving; submitting anything else on the page is, for every other dirty form
 * — including a sibling settings form, where the warning is exactly right and
 * lets the household save that one first.
 *
 * Set only by a submit — deliberately not by a document-level link or click
 * listener, which is the shape that let one stray click on a nav link disarm
 * the editor's guard for good (RFC 009, 1.7). A submit is unambiguous where a
 * click is not, and native constraint validation blocks the event outright, so
 * a submission the browser refuses never reaches it. Captured, so a handler
 * that stops propagation cannot hide one.
 */
let leaving: HTMLFormElement | null = null;

/**
 * A submit that takes nothing with it: a response served as an attachment.
 *
 * The browser fires `beforeunload` when the navigation *starts*, before the
 * headers can say `Content-Disposition`, so a download is indistinguishable
 * from a departure at the moment the guard has to decide — and System carries
 * three of them (database, key, diagnostics) beside two of these forms. Without
 * this, pressing Download diagnostics with an unsaved timezone asks whether you
 * mean to abandon it, about a navigation that abandons nothing.
 *
 * A form says so with `data-download`, which `downloadForm()` in `html.ts`
 * writes so nobody has to remember it. Cleared in the guard, so it cannot latch
 * even on an engine that does not fire `beforeunload` here at all.
 */
let downloading = false;

/** Every wired form, for the one guard below to ask. */
const wired: { form: HTMLFormElement; isDirty(): boolean }[] = [];

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
  /*
   * The server's word is sticky; the DOM's is live.
   *
   * `data-dirty="dirty"` means the markup itself is an echo of something not
   * saved, so it holds for the life of the page — editing back to what is on
   * screen does not make it saved. Everything else is measured on every edit,
   * both ways: typing "Paris" and then "London" again leaves a form with
   * nothing to save, and a Save that stays live over it is the flag meaning
   * nothing.
   */
  const echoed = form.dataset['dirty'] === 'dirty';
  let dirty = echoed || looksEdited(form);

  const refresh = (): void => {
    for (const save of parts.saves) save.disabled = !dirty;
    if (parts.cancel !== null) parts.cancel.hidden = !dirty;
    if (parts.flag !== null) parts.flag.hidden = !dirty;
  };

  const sync = (): void => {
    const now = echoed || looksEdited(form);
    if (now === dirty) return;
    dirty = now;
    refresh();
  };
  // Both events: `input` covers typing, `change` covers a checkbox, a select
  // and a file input, which fire no `input` in every browser this has to run on.
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);

  if (parts.cancel !== null) {
    parts.cancel.addEventListener('click', () => {
      // Discarding this form's own work, which is not "leaving without saving".
      leaving = form;
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

  wired.push({ form, isDirty: () => dirty });
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
   * Which form is leaving, so the guard can ask whose work goes with it.
   *
   * A download is marked and takes nothing with it — see `downloading`.
   */
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement | null;
      if (form !== null && form.hasAttribute('data-download')) downloading = true;
      else leaving = form;
    },
    true,
  );

  /*
   * One guard for the document, asking every form.
   *
   * Registered once rather than per form, and that is what lets it answer the
   * only question worth asking: is anybody's unsaved work about to go? A
   * listener each could only ever answer for its own form, which is how this
   * managed to be wrong in both directions before — silent on a sibling's
   * submit, or asking about a save the household had just deliberately made.
   *
   * Both flags are cleared here rather than by whoever set them. If the
   * navigation goes ahead the document is gone and they never mattered; if
   * anything cancels it — another form's prompt, answered "Stay" — the guard is
   * armed again rather than dead for the life of the page.
   */
  window.addEventListener('beforeunload', (event) => {
    const departing = leaving;
    const wasDownload = downloading;
    leaving = null;
    downloading = false;
    if (wasDownload) return;
    // Everything dirty that is *not* the form being submitted. Saving a form is
    // not losing it; submitting anything else on the page loses every other.
    if (!wired.some((one) => one.isDirty() && one.form !== departing)) return;
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
