import { describe, expect, it } from 'vitest';
import { adminStylesheet as stylesheet, rulesOf } from './admin-stylesheet.js';

/**
 * A segmented control's labels are the choices, so they have to be readable.
 *
 * Reported from a real screen: the Clock widget's "Time format" control drew
 * "ollow the househ" — 142px of label centred in a 111px segment, clipped at
 * *both* ends. The rule that produced it looked like a graceful degradation and
 * was not one:
 *
 *   .le-cfg-field .seg button{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 *
 * `text-overflow` needs inline content in a block container. A segment is
 * `display:inline-flex` with `justify-content:center`, so its label is an
 * anonymous *flex item* — the ellipsis never had anything to act on, and
 * nothing anywhere said so. The declaration read as a safety net that had not
 * been in place since it was written.
 *
 * An ellipsis would not have been a fix either. These labels *are* the options:
 * "Follow the hou…" is a choice a household cannot make. They wrap now.
 *
 * So this pins the absence, the way `admin-mobile-nav.test.ts` pins the absence
 * of the rules its redesign deleted — because there the absence is the fix, and
 * reinstating any of them would read as tidying up.
 *
 * ---
 *
 * **And then the fix for that clipping caused the fault it was meant to
 * prevent, which is why this file gained a second half.** Reported from a real
 * screen again, with a picture: the Calendar widget's four-up "Events in a day"
 * drew "Na/mes", "Dots", "Labelle/d pills", "Swiss/rows" — the *shortest* label
 * broken mid-word.
 *
 * Two declarations were needed to produce it and neither is wrong on its own.
 * The global rule gives a segment `flex:1`, which is `flex:1 1 0%` — every
 * segment takes the same share whatever is written on it. This scope then said
 * `overflow-wrap:anywhere`, which does two things: it lets a line break fall
 * between any two characters, *and* it drops a flex item's min-content
 * contribution to a single glyph, so nothing in the row resists being squeezed.
 * Together: four 64px segments in a 258px inspector, with 60px of slack going
 * to "Dots" rather than to the label that needed it, and "Labelled" chopped in
 * the middle to make it fit a box that never had to be that narrow.
 *
 * `break-word` is the value that means "break a word only when it genuinely
 * cannot fit". A mid-word break is still reachable and still correct — one word
 * wider than its own segment has nowhere else to go — it is simply no longer
 * the first thing that happens while there is a space to break at.
 *
 * The other two are about where the row's space *goes*, and both were kept
 * because a measurement says what each buys. Swept across every segmented
 * control the inspector draws, at nine widths, counting the times a label
 * wrapped while a single-line sibling had more room than it did:
 *
 *   flex:1 (equal shares)                17
 *   flex:1 1 auto, min-width:auto         4
 *   flex:1 1 auto, min-width:0            0
 *
 * `flex:1 1 auto` shares the *free* space rather than the whole width, so a
 * segment starts from what is written on it. `min-width:0` then lets the row
 * shrink past its own words, which is what closes the last four: without it a
 * segment cannot go below its longest word, so the space a wrapped neighbour
 * needs is held by a sibling that does not. Its cost is three labels drawn 2-5px
 * wider than their content box, absorbed by the 8px padding either side — which
 * is the second reason `overflow:visible` matters here, beyond the focus ring.
 * `browser-inspector.test.ts` is where all of those numbers are measured, and
 * that split is the point: this file can only say what the stylesheet declares,
 * and the fault above was invisible to every source-text assertion in it.
 */

/** The declarations of the one rule that styles a segment in the inspector. */
function segmentRule(css: string): string {
  for (const rule of rulesOf(css)) {
    if (rule.selectors.length === 1 && rule.selectors[0] === '.le-cfg-field .seg button') {
      return rule.body;
    }
  }
  throw new Error('no rule for a segment inside the inspector — has it been renamed?');
}

describe('a segmented control in the widget inspector', () => {
  it('lets a long label wrap instead of clipping it', async () => {
    const body = segmentRule(await stylesheet());

    // The fault itself: a label that cannot wrap in a 111px segment is a label
    // clipped at both ends, because the segment centres it.
    expect(body, 'a segment label must be able to wrap').not.toMatch(/white-space\s*:\s*nowrap/);

    // And the declaration that made the clipping look intentional. It cannot
    // work here — the segment is a flex container — so having it back would
    // once again read as a safety net that is not in place.
    expect(body, 'text-overflow does nothing on a flex container').not.toMatch(/text-overflow/);

    // Growing is what wrapping needs; a fixed height would clip the second line
    // instead of the second half of the word, which is not an improvement.
    expect(body).toMatch(/height\s*:\s*auto/);
    expect(body).toMatch(/min-height\s*:/);

    /*
     * The global rule avoids `overflow:hidden` deliberately — it would clip the
     * focus ring, which on a wall editor is the only affordance a keyboard has.
     * This scope had quietly put it back.
     */
    expect(body, 'overflow:hidden clips the focus ring').not.toMatch(/overflow\s*:\s*hidden/);
  });

  it('breaks at a space before it breaks a word', async () => {
    const body = segmentRule(await stylesheet());

    /*
     * `anywhere` is the value that produced the reported mid-word breaks, and
     * it is banned rather than merely not-preferred: it is the only spelling
     * that also collapses the item's min-content contribution, which is what
     * let four segments be squeezed to an equal quarter of a column that had
     * room for their words.
     */
    expect(body, 'overflow-wrap:anywhere breaks inside a word by preference').not.toMatch(
      /overflow-wrap\s*:\s*anywhere/,
    );
    // A single unbreakable word still has to stay inside its segment, since
    // there is no ellipsis to fall back on — so the wrap is not simply removed.
    expect(body).toMatch(/overflow-wrap\s*:\s*break-word/);

    // And the two that decide where the row's space goes. Removing either puts
    // labels back on two lines beside a sibling with room to spare — 17 of them
    // without the first, 4 without the second, measured next door.
    expect(body, 'a segment must size from its own label').toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(body, 'a segment must be able to shrink past its longest word').toMatch(/min-width\s*:\s*0/);
  });
});
