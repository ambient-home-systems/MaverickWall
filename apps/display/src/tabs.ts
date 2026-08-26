/**
 * One tablist, wired the way the pattern requires.
 *
 * Both of the admin's client-side apps draw tabs: `display-editor.ts` has
 * Layout / Wall settings and the settings categories, and `layout-editor.ts`
 * has the inspector's Content / Style and the ink lane's On the wall / On ink.
 * The second of those set a roving `tabindex` and bound no arrow keys, which is
 * the worst of both — the inactive tab leaves the tab order, and nothing else
 * reaches it. The Style tab and the whole ink lane were unreachable by keyboard
 * for as long as that stood.
 *
 * So the wiring lives here and both import it, rather than one of them owning a
 * copy the other half-repeats. A roving tabindex without `wireTabs` is the bug;
 * `markTabs` is what sets it, so the two ship together.
 */

/**
 * Click, arrow keys, Home and End over one tablist.
 *
 * Selecting is the caller's — this owns the control's own semantics and nothing
 * about what a tab means. `vertical` picks which pair of arrows moves along it:
 * a rail of categories reads down, a row of tabs reads across, and the keys have
 * to follow the drawing or they are a second layout nobody can see.
 */
export function wireTabs(
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

/**
 * Reflect the selected tab on every button in one tablist.
 *
 * The class, `aria-selected` and the roving `tabindex` are three halves of one
 * fact, and a control that draws the selection without announcing it lies to
 * everybody who cannot see it.
 */
export function markTabs(
  tabs: readonly HTMLButtonElement[],
  keyOf: (tab: HTMLButtonElement) => string | undefined,
  active: string,
  onClass: string,
): void {
  for (const tab of tabs) {
    const on = keyOf(tab) === active;
    tab.classList.toggle(onClass, on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  }
}
