/**
 * HTML escaping, alone in a file.
 *
 * It sat in `html.ts` for as long as that file was the only thing building
 * markup. `components.ts` also builds markup and `html.ts` builds pages *out
 * of* components, so leaving it there would make the two files import each
 * other — and a cycle between two modules of string builders is resolved by
 * whichever the bundler happens to evaluate first, which is not a property
 * anybody should have to reason about in order to add a button.
 *
 * `html.ts` re-exports it, so every call site that already imports it from
 * there is untouched.
 */

/** Escape for HTML text and quoted attributes. Everything echoed back goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
