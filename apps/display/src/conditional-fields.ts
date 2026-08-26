/**
 * Progressive disclosure for a form field driven by another field's value
 * (RFC 009 Phase 7).
 *
 * Chores rendered all nine field groups at once — including all five
 * mutually-exclusive schedule fields — and said so on the form itself: "Pick
 * how it repeats, then fill in only the boxes that belong to it." The eInk
 * add form did the same with Width/Height, which apply only to a Custom
 * panel. A household should not have to read past the choice they just made
 * to find which boxes it left live.
 *
 * **Script is allowed here, decided rather than assumed** (RFC 009, Decisions
 * taken) — the no-script fence covers only the wizard and sign-in. **It must
 * still degrade to today's behaviour**, and the markup is what guarantees
 * that: every group renders without `hidden`, so a household who blocks
 * script sees every field, exactly as before, and can still tell which ones
 * apply from the hint text already on the form. This script only ever adds
 * `hidden`; it never removes a field script cannot see.
 *
 * The vocabulary is generic on purpose — a `data-cond` select and one or more
 * `data-cond-show` groups scoped to its own form — so the same script serves
 * both screens rather than one bespoke toggle per form.
 */

function apply(select: HTMLSelectElement): void {
  const form = select.closest('form');
  if (form === null) return;
  const groups = form.querySelectorAll<HTMLElement>('[data-cond-show]');
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (group === undefined) continue;
    const shownFor = (group.getAttribute('data-cond-show') ?? '').split(' ');
    group.hidden = !shownFor.includes(select.value);
  }
}

function boot(): void {
  const selects = document.querySelectorAll<HTMLSelectElement>('select[data-cond]');
  for (let index = 0; index < selects.length; index++) {
    const select = selects[index];
    if (select === undefined) continue;
    select.addEventListener('change', () => apply(select));
    apply(select);
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
