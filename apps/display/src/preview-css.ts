/**
 * The wall's stylesheet, scoped so it works inside a preview's shadow root.
 *
 * Both admin previews — the template gallery's cards and the layout editor's
 * live canvas — draw the wall through `renderFreeform` into a shadow root, with
 * `display.css` injected beside it. That is what keeps the wall's CSS off the
 * admin page, and it has one consequence nobody had measured: **a shadow root
 * has no `<html>`, so `:root` matches nothing inside it.**
 *
 * Some fifty rules in `display.css` are written against `:root`, and every one
 * of them was silently dead in both previews. Measured on a Classic wall, in
 * the gallery card and in the editor alike:
 *
 *  - the whole token block — `--t-floor`, `--t-micro`, `--t-event`, `--t-base`,
 *    the `--s1..--s5` spacing scale, every `--ls-*` tracking and `--disp` —
 *    computed to the **empty string**, so `.hz-head`, `.hz-num` and `.dr-num`
 *    fell through to an inherited 12px (14.5px in the editor) where the wall
 *    draws them at 22.1, 26.5 and 44.9px, and every padding and gap spending a
 *    spacing token collapsed;
 *  - `:root[data-theme="…"]` set `--disp` per theme, so no preview ever drew a
 *    numeral in its theme's display face — Almanac's Fraunces, Blueprint's
 *    condensed — and every card in the gallery came out in the same fallback
 *    `Roboto`;
 *  - and with it every theme *shape* rule: Almanac's 400-weight numerals and
 *    italic date, Panels' card borders.
 *
 * `applyTheme` writes its colour tokens and `data-theme` onto the preview's own
 * wall element, which is why colour was the one thing that did survive — and
 * why it read as "close but not quite" rather than as a broken preview.
 *
 * So the wall element *is* the preview's root, and this says so to the
 * stylesheet. **`.preview-wall` is (0,1,0), exactly as `:root` is**, which is
 * the property that makes a textual substitution safe here rather than clever:
 * every pair in the file keeps the specificity it had, so nothing changes which
 * rule wins. (This codebase has already shipped one bug where a (0,3,0)
 * selector quietly beat a (0,2,0) one; a rewrite that moved specificity would
 * be that bug across fifty rules.) Compound selectors carry through the same
 * way — `:root[data-theme="almanac"] .dr-num` and
 * `:root:not([data-blocks~="next"]) .horizon` are (0,2,0) either side.
 *
 * **`body` is the same fault and the same element**, and it carries the six
 * declarations that decide what the wall's type *is*: `--f-sans`, so every run
 * that does not name its own face fell back to whatever the admin page sets;
 * `font-variant-numeral`'s `tabular-nums`, which this product treats as a
 * reflow requirement rather than a preference, since a figure that changes
 * width changes a row's geometry; the `GRAD` axis; and `line-height: 1.15`,
 * which is calibrated — `normal` resolves between 1.148 and 1.178 depending on
 * the face, and a preview laying out at `normal` is a preview whose rows move
 * when a font file finishes downloading. It maps to the same element, and the
 * two cannot collide: every `:root` block in the file declares custom
 * properties only and `body` declares none.
 *
 * The one declaration a preview must **not** take is `cursor: none`, which is
 * right on a wall nobody points at and wrong on a card somebody is about to
 * click and a canvas somebody drags boxes on. It is restored at the end of the
 * sheet, where source order settles it, rather than by excluding `body` — a
 * preview that is honest about five of six declarations is worth more than one
 * that keeps a pointer by keeping none of them.
 *
 * `html { font-size: var(--root-size, …) }` is deliberately **not** rewritten.
 * A preview's rem cannot come from an element inside the shadow root — `rem`
 * always resolves against the *document* root — so both callers instead draw at
 * the resolution where the document's own rem already is one percent of the
 * canvas height, and scale the result down with a transform. Rewriting this one
 * would put a second, disagreeing opinion about the rem basis into a tree that
 * has no way to honour it. `body`'s own `height: 100vh` is harmless for the
 * same reason the rest of it is wanted: `layoutPreviewRoot` writes the frame as
 * an inline style, which outranks any rule in this sheet.
 *
 * One module rather than the same `replace` in two scripts, because two
 * renderers holding one rule is this project's most repeated bug and the cure
 * each time was to resolve it once.
 */

/**
 * The class the preview's root element carries. Exported so a caller sets the
 * element and the rewrite from one value rather than from two string literals
 * that agree today.
 */
export const PREVIEW_ROOT_CLASS = 'preview-wall';

/**
 * `display.css` with every `:root` selector pointed at the preview's own root.
 *
 * A blunt textual substitution, which is the right shape for it: `:root` is a
 * selector token and nothing else in CSS syntax, so the only other place the
 * eight characters occur is prose inside a comment, where rewriting them is
 * inert. Anything narrower would need a parser, and a parser here is a second
 * implementation of the cascade.
 */
export function previewStylesheet(css: string): string {
  return (
    css
      .replace(/:root\b/g, `.${PREVIEW_ROOT_CLASS}`)
      /*
       * `body` is anchored to the start of a selector rather than matched as a
       * word: the file's prose says "the wall's body face" and a blunt `\bbody\b`
       * would rewrite that too. There is exactly one `body` selector in it.
       */
      .replace(/^body\b/gm, `.${PREVIEW_ROOT_CLASS}`) +
    `\n.${PREVIEW_ROOT_CLASS}{cursor:auto}\n`
  );
}

/**
 * The height of the portrait wall this design is calibrated against.
 *
 * `display.css` states it at the landscape rem override — "the rem is
 * calibrated against the design's 1920-tall portrait screen" — and it is the
 * only thing that turns `--t-floor`'s absolute pixels into a share of a frame.
 */
const DESIGN_WALL_H = 1920;

/**
 * Size a preview's root element so the wall inside it draws at wall
 * proportions, then scale the whole thing down to the box it has to fit.
 *
 * **The reference resolution is the fix, and the transform is only how it gets
 * back into the card.** Every reused section states its type in `rem`, and on a
 * real wall `orientation.ts` makes one rem worth one percent of the canvas
 * height. Inside a shadow root that relation cannot be restored at all — `rem`
 * resolves against the *document* root whatever any element here declares — so
 * a wall drawn at the box's own small pixel size comes out with its rem-sized
 * type at `documentRootPx / (boxHeight / 100)` times its proper share of the
 * frame. Measured on a 179x319 gallery card against the same Classic wall
 * paired at 1080x1920: **5.02x**, which is 16 / 3.19 exactly. Drawing instead
 * at the height where the document's own rem already *is* one percent of it
 * (`height = rem x 100`) restores the proportion, and the transform is visual
 * only — everything the renderer measures, the density tiers included, is the
 * untransformed layout at wall scale.
 *
 * **`--t-floor` is the one thing that does not follow**, because it is the one
 * size on the wall stated in absolute pixels rather than in rem: the calendar
 * widget's legibility floor, for a wall whose household has not said how large
 * it is or how far away they stand. A floor in pixels is a different share of a
 * 1600-tall frame than of a 1920-tall one, so left alone it binds harder in the
 * preview than on the wall — measured, `.hz-head` and `.hz-num` at **1.20x**
 * their proper share with everything around them exact, which is that ratio
 * (1920 / 1600). It is restated here as the share the design's own reference
 * wall would give it, which is what makes the card a picture of a wall rather
 * than of a smaller screen.
 */
export function layoutPreviewRoot(
  wall: HTMLElement,
  box: { readonly width: number; readonly height: number },
  aspect: number,
): void {
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const refH = rootPx * 100;
  const refW = refH * aspect;
  wall.style.width = `${refW}px`;
  wall.style.height = `${refH}px`;
  wall.style.setProperty('--frame-w', `${refW}px`);
  wall.style.setProperty('--frame-h', `${refH}px`);
  wall.style.setProperty('--root-size', `${rootPx}px`);
  wall.style.setProperty('--t-floor', `${(22 * refH) / DESIGN_WALL_H}px`);
  // Out of flow, so the full-resolution box cannot push the host around before
  // the transform fits it to the card; both share the box's aspect, so one
  // uniform scale fits width and height together.
  wall.style.position = 'absolute';
  wall.style.top = '0';
  wall.style.left = '0';
  wall.style.transformOrigin = 'top left';
  wall.style.transform = `scale(${box.height / refH})`;
}
