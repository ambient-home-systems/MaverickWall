/**
 * The admin's component layer.
 *
 * `html.ts` exported fifteen helpers and eleven of them were form fields, so
 * everything a settings screen is actually *made of* — a card, a list row, a
 * table, a badge, a section, an empty state, a page header, a destructive
 * control — was re-typed as literal HTML on forty-nine routes. The measured
 * consequence was not a matter of taste: 379 of 384 spacing declarations
 * bypassed `--mw-s-1..7`, which are declared in `html.ts` and were read five
 * times between them, and a third of `border-radius` and half of `font-size`
 * were raw pixels against token sets that already existed.
 *
 * That is not carelessness. A screen has to compose *something*, and with no
 * component to inherit from the only thing left to copy is the screen next
 * door — so every new feature restates the whole vocabulary from scratch and
 * gets a little of it wrong. Sweeping the declarations without building the
 * thing they should have been reaching for buys a green run and one feature's
 * worth of drift back.
 *
 * ## What these must not become
 *
 * The admin was Material Design 3 and deliberately is not any more, and the
 * objection recorded in `design-tokens.ts` was never that the implementation
 * was unfaithful — it was faithful, which was the problem. So none of these
 * reintroduces what came out with it: no elevation ladder (a card is a
 * hairline and a surface step, and the two shadows in the system belong to the
 * modal drawer and the widget sheet, which genuinely float), no tonal state
 * layer, no fully rounded rectangle, no icon beside a heading and none as
 * decoration in an empty state. `admin-design-system.test.ts`,
 * `admin-icon-rules.test.ts` and `admin-button-states.test.ts` pin those
 * absences, and an absence is exactly what somebody reinstates while tidying.
 *
 * ## Why the styles are in this file
 *
 * `COMPONENT_STYLE` is interpolated into the one admin stylesheet, which keeps
 * the served structure exactly as it was — an ETag'd `assets/admin.css` for
 * the shell, an inline copy for the wizard and sign-in, which must work before
 * anything else does. What it buys is that a component's markup and the rules
 * that draw it are one edit apart and one file, and that
 * `admin-components.test.ts` has a subject: **every declaration in this string
 * spends tokens and no raw pixels**, which is a claim that cannot be made
 * about a stylesheet with forty-nine screens' worth of one-offs in it.
 *
 * That constraint is why several values below are written as `calc()` over two
 * rungs rather than as the number they come to. `calc(var(--mw-touch) +
 * var(--mw-s-1))` is 48px, and saying it that way says *why* it is 48: the
 * pointer minimum plus one step of the spacing scale. A literal `48px` is the
 * same pixel and a decision nobody can review.
 */

import { escapeHtml } from "./escape.js";
import { icon } from "./icons.js";

/* ---- 1. pageHeader -------------------------------------------------------- */

export interface PageHeaderOptions {
  /** The page's own name — the `<h1>`. */
  readonly heading: string;
  /**
   * The kicker above it: which part of the admin this is. Ignored when `back`
   * is given, because then the crumb *is* the back link.
   */
  readonly crumb: string;
  /**
   * Where this page sits inside its section — one wall inside Walls. Turns the
   * crumb into a real back link.
   */
  readonly back?: { readonly label: string; readonly href: string } | undefined;
  /** A single primary action for the top-right. Already-escaped href. */
  readonly action?:
    | { readonly label: string; readonly href: string }
    | undefined;
}

/**
 * The app bar: the compact-width menu button, the crumb, the heading, and at
 * most one action.
 *
 * **This is the one place that decides whether a screen has a back link**, and
 * that is the whole of why it is a component rather than five lines inside
 * `page()`. The rule it enforces is the wall editor's, which had it right: a
 * page nested one level down gets its back affordance *in the app bar*, as the
 * crumb, and therefore adds no header of its own — and in particular no second
 * hamburger, which is what a "Walls" button in the page would read as beside
 * the navigation drawer's. Under a real Home Assistant supervisor there is
 * already one of the supervisor's own stacked against the drawer's; a third
 * would be the third of three.
 *
 * It introduces no styles. The app bar's geometry is `.topbar` in the shell
 * section of the stylesheet, where it was, and it is the one part of the admin
 * this brief's audit did not find drifted — its type and its colours are
 * already roles. Restating its five geometry values as `calc()` chains over
 * the spacing scale would move the shell gutter by four pixels, take the app
 * bar out of alignment with the content beneath it, and buy nothing; what was
 * missing here was the decision, not the tokens.
 */
export function pageHeader(options: PageHeaderOptions): string {
  const action =
    options.action === undefined
      ? ""
      : `<a class="btn btn-sm" href="${options.action.href}">` +
        `${escapeHtml(options.action.label)}</a>`;

  return (
    `<header class="topbar">` +
    // The app bar's leading icon, and the only way to the navigation below
    // 900px. It sits in the sticky bar rather than at the top of the document
    // so it is one tap away at any scroll depth; at this width it is not drawn.
    `<label class="navbtn" for="mw-nav" title="Navigation menu">${icon("menu")}</label>` +
    `<div class="topbar-title">` +
    (options.back === undefined
      ? `<div class="crumb">${escapeHtml(options.crumb)}</div>`
      : `<a class="crumb crumb-back" href="${options.back.href}">${icon("back")}` +
        `${escapeHtml(options.back.label)}</a>`) +
    `<h1>${escapeHtml(options.heading)}</h1>` +
    `</div>${action}</header>`
  );
}

/* ---- 2. section ----------------------------------------------------------- */

/**
 * A run of a screen under its own heading, and the vertical rhythm between
 * them.
 *
 * The idiom this replaces is `<h2 class="add">…</h2><p class="hint">…</p>`
 * followed by whatever, repeated six times down `/admin/system` alone — which
 * put the rhythm in the *heading's* margins, so a section's spacing depended
 * on what the last one happened to end with and a screen that wanted no
 * heading had nowhere to put its gap. Here the section owns it.
 *
 * `help` is prose above the controls rather than under them, because it is
 * usually the reason the section exists ("Two files, and you need both to
 * restore everything") rather than a note about one field. A note about one
 * field is `textField`'s `hint`, and that is the distinction.
 *
 * **No icon beside the heading, ever.** It is not offered as an option, which
 * is the only way an absence survives: this admin bans an icon that stands
 * beside the thing that already names it, and a `section(title, icon, …)`
 * would be four screens away from having one.
 */
export function section(
  title: string,
  help: string | undefined,
  children: string,
  /**
   * A fragment somebody can link to — `admin/calendars#add`.
   *
   * On the `<section>` rather than on the heading, so the anchor lands on the
   * whole run rather than on one line of it, and so a screen that wants to
   * point at a section does not have to reach inside this component to do it.
   */
  id?: string,
): string {
  return (
    `<section class="mw-sect"${id === undefined ? "" : ` id="${escapeHtml(id)}"`}>` +
    `<h2>${escapeHtml(title)}</h2>` +
    (help === undefined
      ? ""
      : `<p class="mw-sect-help">${escapeHtml(help)}</p>`) +
    `<div class="mw-sect-body">${children}</div>` +
    `</section>`
  );
}

/* ---- 3. card -------------------------------------------------------------- */

/** The status hues a card may be tinted with. `neutral` is the ordinary card. */
export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export interface CardOptions {
  readonly tone?: Tone;
  /** Extra classes for a screen that has its own treatment — `is-paused`. */
  readonly className?: string;
}

/**
 * A hairline, a surface step, and never a shadow.
 *
 * The two shadows in this system are `--mw-shadow-2` on the modal drawer and
 * the widget sheet, both of which cover the page and have to look like they
 * do. A card does not float; it is a region of the page with an edge, and an
 * elevation ladder is how a settings screen starts reading as a corporate
 * dashboard. `admin-design-system.test.ts` counts the shadow tokens and
 * refuses a stacked one.
 *
 * A tone moves the card's *edge* to a status hue and leaves the ground alone.
 * A tinted card is a 400px region drawn in a colour sized for a chip, and
 * whatever inside it says the same thing in words — an `errorBlock`, a `tag` —
 * is drawn on that same `-soft` ground and disappears into it. The edge is the
 * signal, the words inside are the meaning, and the two do not fight.
 */
export function card(children: string, options: CardOptions = {}): string {
  const tone = options.tone ?? "neutral";
  return (
    `<article class="card` +
    (tone === "neutral" ? "" : ` is-${tone}`) +
    (options.className === undefined ? "" : ` ${options.className}`) +
    `">${children}</article>`
  );
}

/* ---- 4. listRow ----------------------------------------------------------- */

export interface ListRowBody {
  readonly title: string;
  /** The second line: what this row is, in a sentence. */
  readonly detail?: string;
  /**
   * Where the row goes. Relative, so the single `<base>` carries it through
   * ingress. Given one, the **whole row** becomes the hit target.
   */
  readonly href?: string;
}

/**
 * One row of a list: something identifying on the left, a name and a line of
 * prose in the middle, and at most one control on the right.
 *
 * Two properties are the reason this is a component and not markup.
 *
 * **The whole row is the target where the row navigates.** A 12-character link
 * inside a 600px row is a tap somebody misses and a pointer somebody has to
 * aim; the anchor's `::after` is stretched over the row so the target is the
 * row's own rectangle. A control in the trail is still its own target, and it
 * is worth knowing *why*: every button in this admin is `position:relative` for
 * its own stretched pointer target, so it is a positioned descendant later in
 * the document than the overlay and paints over it. That is a coupling rather
 * than a declaration here, and `browser-components.test.ts` is what holds it —
 * it taps the row's own button and reads back what is under the finger.
 *
 * **48px minimum, and it is written as the pointer minimum plus a step.**
 * `--mw-touch` is 44px, which is what a finger needs; the row is one rung of
 * the spacing scale above it, which is where the drawer's own rows sit and is
 * what leaves the second line room. Written as `calc()` rather than as `48px`
 * so the relationship survives somebody retuning either.
 */
export function listRow(
  lead: string,
  body: ListRowBody,
  trail?: string,
): string {
  const title =
    body.href === undefined
      ? `<b>${escapeHtml(body.title)}</b>`
      : `<b><a class="mw-row-link" href="${body.href}">${escapeHtml(body.title)}</a></b>`;
  return (
    `<div class="mw-row">` +
    (lead === "" ? "" : `<div class="mw-row-lead">${lead}</div>`) +
    `<div class="mw-row-body">${title}` +
    (body.detail === undefined
      ? ""
      : `<small>${escapeHtml(body.detail)}</small>`) +
    `</div>` +
    (trail === undefined || trail === ""
      ? ""
      : `<div class="mw-row-trail">${trail}</div>`) +
    `</div>`
  );
}

/* ---- 5. dataTable --------------------------------------------------------- */

export interface DataColumn {
  readonly label: string;
  /** Right-align this column. For a figure, which reads off its last digit. */
  readonly numeric?: boolean;
}

/**
 * A table of facts, with tabular figures and its own horizontal scroll.
 *
 * Both of those are the point. **Figures are tabular by declaration here**
 * rather than by inheritance from `body`: a figure that changes width changes
 * a column's geometry, and a table is the one place in the admin where a
 * reader compares two numbers by looking at where they start. The wall states
 * the same rule as a reflow requirement; here it is legibility.
 *
 * **The wrapper scrolls, not the page.** A table is the one element in this
 * admin whose intrinsic width is set by its content, so on a 390px phone a
 * four-column table pushes the *document* sideways — and once the body scrolls
 * horizontally the sticky app bar and the fixed save bar slide off with it.
 * `overflow-x:auto` on a wrapper keeps the sideways scroll inside the thing
 * that is too wide.
 *
 * Cells are already-escaped markup, because a cell often holds a tag or a
 * host; the column labels are text and are escaped here.
 */
export function dataTable(
  cols: readonly DataColumn[],
  rows: readonly (readonly string[])[],
): string {
  const head = cols
    .map(
      (col) =>
        `<th${col.numeric === true ? ' class="is-num"' : ""}>${escapeHtml(col.label)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>` +
        row
          .map(
            (cell, index) =>
              `<td${cols[index]?.numeric === true ? ' class="is-num"' : ""}>${cell}</td>`,
          )
          .join("") +
        `</tr>`,
    )
    .join("");
  return (
    `<div class="mw-table-wrap">` +
    `<table class="mw-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    `</div>`
  );
}

/* ---- 6. tag --------------------------------------------------------------- */

/**
 * A state, as a word on a tinted ground.
 *
 * The grounds are the `-soft` roles that already exist for exactly this, and
 * the text is the hue itself rather than a fill — a solid status chip is loud
 * on a page carrying six of them, and `.tag-ok` shipped once as
 * `background: var(--mw-ok); color: var(--mw-ok)`, an invisible word on a
 * green chip, which is why `admin-design-system.test.ts` checks for a token
 * painted on itself.
 *
 * **The label is required and carries the whole meaning**, so the tone is
 * never the only signal (WCAG 1.4.1). What this deliberately does *not* do is
 * put a status glyph in front of it. An icon here would be the third thing
 * this admin has banned outright — decoration standing beside the word that
 * already says it — and it is the shape of every mistake this codebase keeps
 * recording: the `.ic` tile, and the emoji vocabulary that got written down as
 * forbidden and added four times anyway. A tag reads "Not syncing", which a
 * colour-blind reader and a monochrome screenshot both get right; a tick in
 * front of it adds nothing either of them can use.
 */
export function tag(text: string, tone: Tone = "neutral"): string {
  const cls =
    tone === "neutral" ? "" : ` tag-${tone === "danger" ? "bad" : tone}`;
  return `<span class="tag${cls}">${escapeHtml(text)}</span>`;
}

/* ---- 7. emptyState -------------------------------------------------------- */

export interface EmptyAction {
  readonly label: string;
  /** Relative href, so the single `<base>` carries it through ingress. */
  readonly href: string;
}

/**
 * Nothing here yet: what is missing, and the one thing to do about it.
 *
 * Three rules, and all three are about not lying.
 *
 * **Name the thing.** "Nothing to show" is true of every empty screen in the
 * product and useful on none of them; "No calendars yet" says which list is
 * empty and therefore what the page is for.
 *
 * **Check the branch it is on.** An empty state is a claim, and this admin has
 * already shipped three claims that were simply false — "Syncing now" for a
 * calendar whose sync switch is off, a green "Checked for a newer version"
 * drawn directly above the red box saying the check had failed, and "Calendar
 * removed" for an id that never existed. "There are none" and "the query
 * failed" and "you have filtered them all out" are three different sentences,
 * and a handler with an early return needs the one that matches its branch.
 *
 * **No illustration, no exclamation mark, no cheer.** An icon here is banned
 * outright and `admin-icon-rules.test.ts` walks a fresh install — which *is*
 * the empty state on every screen — looking for one. The voice is the same as
 * the rest of the product's: written for somebody standing in a kitchen, not
 * for somebody being onboarded.
 */
export function emptyState(what: string, action?: EmptyAction): string {
  return (
    `<div class="mw-empty">` +
    `<p class="mw-empty-what">${escapeHtml(what)}</p>` +
    (action === undefined
      ? ""
      : `<a class="btn" href="${action.href}">${escapeHtml(action.label)}</a>`) +
    `</div>`
  );
}

/* ---- 8. destructive ------------------------------------------------------- */

export interface DestructiveTarget {
  /** What is destroyed, named — a calendar's own name, a person's. */
  readonly thing: string;
  /**
   * The GET that draws the confirmation. It must answer with
   * `confirmDestroyPage`, which is what names the loss and offers the
   * non-destructive alternative; this control's whole job is to lead there
   * rather than to act.
   */
  readonly confirmAction: string;
  /**
   * `menu` is the overflow row every card's ⋮ holds — the default, and where a
   * destructive action belongs. `button` is a standalone control for a page
   * that has no overflow to put it in.
   */
  readonly variant?: "menu" | "button";
}

/**
 * The one way to offer destroying something.
 *
 * `confirmDestroyPage` in `html.ts` is the other half and is already
 * exemplary: it names exactly what is lost, offers the non-destructive
 * alternative beside it where there is one — Pause rather than Remove for a
 * chore, because pausing keeps its history and that is the entire difference —
 * and a plain "Keep it". What had no convention was the *control that leads
 * there*, so each screen wrote its own and the interesting properties were
 * re-derived or missed.
 *
 * Three of them, and none is visible in the markup a screen would otherwise
 * type by hand:
 *
 *  - **It is a GET, never a POST.** The confirmation is not a nicety bolted on
 *    the front; it is where the naming happens. A one-click POST is the
 *    variant this exists to make harder to write than the right thing.
 *  - **The ellipsis is the promise.** "Remove…" says a tap here is not the end
 *    of it, which is the wording the wall header's "Reset layout…" and "Unpair
 *    wall…" already use for the two other actions that ask before they act.
 *  - **The accessible name says what, not just which verb.** A screen reader
 *    moving down eight calendar rows hears "Remove" eight times otherwise.
 */
export function destructive(label: string, what: DestructiveTarget): string {
  const menu = (what.variant ?? "menu") === "menu";
  return (
    `<form method="get" action="${escapeHtml(what.confirmAction)}">` +
    `<button class="${menu ? "ovf-item is-danger" : "btn-danger"}" type="submit"` +
    ` aria-label="${escapeHtml(`${label} ${what.thing}`)}">${escapeHtml(label)}…</button>` +
    `</form>`
  );
}

/* ---- The styles ----------------------------------------------------------- */

/**
 * Every rule the eight components above draw with, spending tokens and no raw
 * pixels.
 *
 * Interpolated into the one admin stylesheet by `html.ts`, so the served
 * structure is unchanged: an ETag'd `assets/admin.css` for the shell and an
 * inline copy for the wizard and sign-in, which must work before a second
 * request can succeed. It is a separate string only so
 * `admin-components.test.ts` has something to hold to the constraint — a claim
 * about tokens cannot be made about a sheet with forty-nine screens' worth of
 * one-offs in it, and a claim nothing can check is how the spacing scale ended
 * up declared seven times and read five.
 *
 * `.card` and `.tag` were already in the sheet and are *moved* here rather
 * than restated beside it, tokenised to the pixel: `1rem` is `--mw-s-4`,
 * `0.5rem` is `--mw-s-2`, `4px 12px` is `--mw-s-1 --mw-s-3`, and `1px` is
 * `--mw-hairline`. Nothing on any screen moves. Two rules with the same
 * selector, one of them "the token version", is the drift this file exists to
 * end rather than a step towards ending it.
 *
 * It sits late in the sheet on purpose. Every value here is identical to what
 * it replaced, so source order decides nothing today — but a component is the
 * thing a screen is built out of, and a screen's own override should win
 * without needing a second class to do it with.
 */
export const COMPONENT_STYLE = `
/* ---- Component layer ------------------------------------------------------
 * See components.ts. Tokens only, in here: no raw length, no raw colour, no
 * shadow, nothing rounder than --mw-r-4. */

/* card() — a hairline and a surface step. Never a shadow: the two in this
 * system belong to the modal drawer and the widget sheet, which cover the page
 * and have to look like they do. */
.card{position:relative;background:var(--mw-surface);
  border:var(--mw-hairline) solid var(--mw-line);
  border-radius:var(--mw-r-3);padding:var(--mw-s-4);margin:var(--mw-s-4) 0}
.card h2{font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);margin:0;
  display:flex;align-items:center;gap:var(--mw-s-2)}
.card p{margin:var(--mw-s-2) 0}
/* A tone moves the *edge* to the hue and leaves the ground alone. It is not a
 * fill and it is not a wash: a card is a 400px region and the -soft grounds
 * are sized for a chip, so a tinted card would swallow the error block or the
 * tag inside it that says the same thing in words — two tints, one on the
 * other, and the more specific one loses. Separation here is a hairline, and a
 * hairline can carry a hue without competing with anything it contains. */
.card.is-ok{border-color:var(--mw-ok)}
.card.is-warn{border-color:var(--mw-warn)}
.card.is-danger{border-color:var(--mw-danger)}
.card.is-accent{border-color:var(--mw-accent)}

/* section() — the rhythm lives on the section, not in a heading's margins, so
 * a run of them spaces the same whatever the last one ended with and a section
 * with no heading still has its gap. */
.mw-sect{margin-top:var(--mw-s-6);padding-top:var(--mw-s-5);
  border-top:var(--mw-hairline) solid var(--mw-line-strong)}
.mw-sect:first-child{margin-top:0;padding-top:0;border-top:0}
.mw-sect>h2{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);
  color:var(--mw-ink);margin:0}
/* Prose above the controls rather than under them: it is usually the reason
 * the section exists, not a note about one field. A note about one field is
 * textField's hint. 64ch is a line length, not a spacing decision. */
.mw-sect-help{font:var(--mw-t-body);
  letter-spacing:var(--mw-t-body-tracking);
  color:var(--mw-ink-2);max-width:64ch;margin:var(--mw-s-2) 0 0}
.mw-sect-body{margin-top:var(--mw-s-4)}
.mw-sect-body>:first-child{margin-top:0}

/* listRow() — 48px, written as the pointer minimum plus one rung of the
 * spacing scale, which is what it is. A literal 48 is the same pixel and a
 * decision nobody can review. */
.mw-row{position:relative;display:flex;align-items:center;flex-wrap:wrap;
  gap:var(--mw-s-3);min-height:calc(var(--mw-touch) + var(--mw-s-1));
  padding:var(--mw-s-2) 0}
.mw-row+.mw-row{border-top:var(--mw-hairline) solid var(--mw-line)}
.mw-row-lead{flex:0 0 auto;display:flex;align-items:center;line-height:0}
.mw-row-body{flex:1 1 auto;min-width:0}
.mw-row-body>b{display:block;font:var(--mw-t-label);
  letter-spacing:var(--mw-t-label-tracking);color:var(--mw-ink)}
.mw-row-body>small{display:block;font:var(--mw-t-body-sm);
  letter-spacing:var(--mw-t-body-sm-tracking);
  color:var(--mw-ink-muted);margin-top:var(--mw-s-1)}
/* The trail is deliberately not stacked above the row's stretched link, and it
 * does not need to be: button/.btn in this sheet is already position:relative
 * for its own pointer target, so a control in the trail is a positioned
 * descendant later in the document than the overlay and paints over it unaided.
 * A position:relative;z-index:1 here was written first and reverted — measured,
 * it changed nothing any assertion could see, and a line nothing can contradict
 * is not a fix. What keeps the coupling honest is browser-components.test.ts,
 * which taps the row's own button and reads back what is under the finger.
 * (No backticks anywhere in here: this whole block is a template literal.) */
.mw-row-trail{flex:0 0 auto;display:flex;
  align-items:center;gap:var(--mw-s-2)}
.mw-row-trail form{margin:0}
.mw-row-link{color:var(--mw-ink);text-decoration:none}
/* The whole row is the target. A 12-character link inside a 600px row is a tap
 * somebody misses and a pointer somebody has to aim. */
.mw-row-link::after{content:"";position:absolute;inset:0}
.mw-row-link:hover{text-decoration:underline}
.mw-row:has(.mw-row-link):hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.mw-row:has(.mw-row-link):active{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-press),transparent)}

/* dataTable() — the wrapper scrolls, never the page. A table is the one
 * element here whose width is set by its content, and once the body scrolls
 * sideways the sticky app bar and the fixed save bar go with it. */
.mw-table-wrap{overflow-x:auto;margin:var(--mw-s-4) 0}
/* A card's own padding is the gap under its last child, so a table that ends
 * one would otherwise draw two of them stacked. Seen by looking at the version
 * card: 32px under the last row against 16px at every other edge. */
.mw-table-wrap:last-child{margin-bottom:0}
.mw-table{width:100%;border-collapse:collapse;
  font:var(--mw-t-body);
  letter-spacing:var(--mw-t-body-tracking);
  /* Declared, not inherited: a table is where a reader compares two numbers by
   * where they start, and a figure that changes width moves the column. */
  font-variant-numeric:tabular-nums}
.mw-table th{text-align:left;font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);text-transform:uppercase;
  color:var(--mw-ink-muted);
  padding:var(--mw-s-2) var(--mw-s-3);
  border-bottom:var(--mw-hairline) solid var(--mw-line-strong);
  white-space:nowrap}
.mw-table td{padding:var(--mw-s-3);color:var(--mw-ink);vertical-align:middle;
  border-bottom:var(--mw-hairline) solid var(--mw-line)}
.mw-table tr:last-child td{border-bottom:0}
.mw-table th:first-child,.mw-table td:first-child{padding-left:0}
.mw-table th:last-child,.mw-table td:last-child{padding-right:0}
/* A figure reads off its last digit. */
.mw-table .is-num{text-align:right;white-space:nowrap}

/* tag() — a tinted ground and the hue's own text, never a fill. The word is
 * the whole meaning, so the colour is never the only signal; there is
 * deliberately no glyph in front of it. */
.tag{display:inline-flex;align-items:center;gap:var(--mw-s-2);
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  padding:var(--mw-s-1) var(--mw-s-3);border-radius:var(--mw-r-2);
  background:var(--mw-surface-3);
  color:var(--mw-ink-2)}
.tag-ok{background:var(--mw-ok-soft);
  color:var(--mw-ok)}
.tag-bad{background:var(--mw-danger-soft);
  color:var(--mw-danger)}
.tag-accent{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
.tag-warn{background:var(--mw-warn-soft);
  color:var(--mw-warn)}

/* emptyState() — the thing that is missing, and the one action. No
 * illustration and no icon: a fresh install is the empty state on every
 * screen, which is what admin-icon-rules.test.ts walks. */
.mw-empty{display:flex;flex-direction:column;align-items:flex-start;
  gap:var(--mw-s-4);padding:var(--mw-s-7) var(--mw-s-5);
  border:var(--mw-hairline) dashed var(--mw-line-strong);
  border-radius:var(--mw-r-3);margin:var(--mw-s-4) 0}
.mw-empty-what{font:var(--mw-t-body-lg);
  letter-spacing:var(--mw-t-body-lg-tracking);
  color:var(--mw-ink-2);max-width:64ch;margin:0}

/* Below the shell's own breakpoint a row gives its trail a line of its own
 * rather than squeezing the name it belongs to. */
@media(max-width:560px){
  .mw-row{align-items:flex-start}
  .mw-row-body{flex:1 1 100%}
  .mw-empty{padding:var(--mw-s-6) var(--mw-s-4)}
}
`;
