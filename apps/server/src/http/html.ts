/**
 * Server-rendered pages.
 *
 * The wizard and the sign-in form are plain HTML with no script and no build
 * step, because they are the screens that must work before anything else does.
 * A bundle that fails to build or fails to load would otherwise take the only
 * route into the application down with it.
 *
 * Rule three still applies: nothing here loads a font, a stylesheet or an image
 * from anywhere. The styles are inline and the palette is hand-picked
 * (design-tokens.ts) rather than generated from a seed, so the setup flow reads
 * as a fixture in a house rather than as an app wearing a wallpaper colour.
 */

import { ADMIN_SCHEMES, adminColorVars, adminTypeVars } from './design-tokens.js';
import { SAVED_MESSAGES, type Saved } from './saved.js';
import { contentEtag } from './static.js';

/** Escape for HTML text and quoted attributes. Everything echoed back goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
/*
 * Self-hosted, first-party, no network. Rule three forbids fetching a web font,
 * so Roboto Condensed ships in the image and is served same-origin; the src is
 * relative, so the single <base> carries it through Home Assistant ingress.
 * This face backs only the wordmark's fallback stack here — the file itself
 * stays bundled
 * because the display's custom themes are served from the same directory.
 */
@font-face{font-family:'Roboto Condensed';font-style:normal;font-weight:400 700;
  font-display:swap;src:url('assets/fonts/roboto-condensed.woff2') format('woff2')}

/*
 * Roboto — the admin's text face, bundled the same way:
 * the variable font's latin subset, weight axis 100-900, so the scale's
 * 400/500/700 come from one same-origin file. system-ui first in the fallback
 * stack below because on Android system-ui IS Roboto.
 */
@font-face{font-family:'Roboto';font-style:normal;font-weight:100 900;
  font-display:swap;src:url('assets/fonts/roboto.woff2') format('woff2')}

/*
 * Oswald, for the brand lockup and nothing else.
 *
 * The wordmark in docs/brand is set in this face, and the name beside the mark
 * in the sidebar and the wizard IS that wordmark — rendered as live text
 * rather than as an image so it stays selectable and crisp at any zoom. Set in
 * a different face it reads as a near-miss of the logo, which is worse than an
 * obvious difference. Every other heading is on the Roboto type scale: this is
 * the identity, not a new heading style.
 */
@font-face{font-family:'Oswald';font-style:normal;font-weight:700;
  font-display:swap;src:url('assets/fonts/oswald-700.woff2') format('woff2')}

:root{
  --wordmark:'Oswald','Roboto Condensed','Arial Narrow',system-ui,sans-serif;
  --sans:'Roboto',system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}

/*
 * Foundations: type, shape, line, motion.
 *
 * What is *not* here is the point of it. There is no elevation ladder, because
 * five stacked shadow levels is how a settings page starts looking like a
 * corporate dashboard; separation is a hairline rule and a surface step, and
 * the two shadows that remain are for things that genuinely float above the
 * page and must detach from it. There is no tonal state-layer system either —
 * a hover is a named ground, not a percentage of a role composited at runtime.
 *
 * The shape scale tops out at 8px and starts at 2. A wall calendar's admin
 * should read as something built into a house: geometric, flat, square-ish.
 * '--mw-r-full' survives for the handful of things that are actually circles —
 * a status dot, an avatar, a spinner — and for nothing that is a rectangle.
 */
:root{
  ${adminTypeVars()};

  /* Shape. Small numbers on purpose: see above. */
  --mw-r-0:0;
  --mw-r-1:2px;
  --mw-r-2:4px;
  --mw-r-3:6px;
  --mw-r-4:8px;
  --mw-r-full:999px;

  /* Two shadows, both single-layer. '1' is for a control that lifts on press
   * or a card that is being dragged; '2' is for the modal drawer and the
   * widget sheet, which cover the page and have to look like they do. */
  --mw-shadow-0:none;
  --mw-shadow-1:0 1px 2px rgba(0,0,0,.16);
  --mw-shadow-2:0 8px 24px rgba(0,0,0,.28);

  /* Hairline. 1px at any density: a rule that resolves to 0.5 disappears
   * entirely on some Android WebViews, and a missing divider reads as a
   * rendering fault rather than as a quieter design. */
  --mw-hairline:1px;

  /* Interaction washes. These are the amounts a control tints itself by when
   * hovered or pressed — kept as percentages because several controls sit on
   * grounds the stylesheet cannot name in advance (a row inside a card inside
   * a sheet), so the mix has to happen against 'currentColor''s ground rather
   * than against a fixed token. */
  --mw-wash-hover:6%;
  --mw-wash-press:11%;

  /* Motion. Three durations, because a settings page has three kinds of
   * change: a control acknowledging a press, a panel opening, and a sheet
   * travelling the height of a phone. */
  --mw-ease:cubic-bezier(.2,0,0,1);
  --mw-ease-out:cubic-bezier(.05,.7,.1,1);
  --mw-ease-in:cubic-bezier(.3,0,.8,.15);
  --mw-dur-1:120ms;
  --mw-dur-2:180ms;
  --mw-dur-3:260ms;

  /* Spacing. A balanced step, neither the 4px enterprise grid nor the airy
   * mobile one: the brief is a household setting up a calendar on a phone or a
   * laptop, so controls are comfortable to hit and the page still shows a
   * screen's worth of settings at a time. */
  --mw-s-1:4px;
  --mw-s-2:8px;
  --mw-s-3:12px;
  --mw-s-4:16px;
  --mw-s-5:24px;
  --mw-s-6:32px;
  --mw-s-7:48px;

  /* The minimum a finger can reliably hit. Every control below this size
   * stretches its pointer target to it with the shared ::after extension. */
  --mw-touch:44px;
}

/*
 * The short token names the pages are written against.
 *
 * Several thousand lines of server-rendered HTML carry these class names and
 * these variables, so the aliases are what let the whole admin restyle without
 * a markup edit. They point at the '--mw-*' roles below, which flip per scheme;
 * an alias re-resolves against whichever set is live.
 *
 * New styles should reach for '--mw-*' directly. These stay for what is already
 * written, and because '--bg'/'--ink'/'--accent' are also the wall's own token
 * names — the two bundles share no code, but a person reading both should not
 * have to learn two vocabularies for the same four ideas.
 */
:root{
  --bg:var(--mw-bg);
  --panel:var(--mw-surface);
  --panel2:var(--mw-surface-2);
  --rule:var(--mw-line-strong);
  --ruleSoft:var(--mw-line);
  --ink:var(--mw-ink);
  --muted:var(--mw-ink-2);
  --faint:var(--mw-ink-3);
  --accent:var(--mw-accent);
  --accentInk:var(--mw-accent-ink);
  --danger:var(--mw-danger);
  --ok:var(--mw-ok);
  --warn:var(--mw-warn);
  --night:var(--mw-night);
}

/*
 * Dark by default, light on request, auto following the device.
 *
 * The choice is per-browser (localStorage, applied by a tiny inline script
 * before first paint, so there is no flash) and only ever styles the admin,
 * never the wall. 'color-mix()' is fine here: this is a phone or a desktop, not
 * the locked-down tablet rule two is about.
 */
:root{
  color-scheme:dark;
  ${adminColorVars(ADMIN_SCHEMES.dark)};
}
:root[data-theme="light"]{
  color-scheme:light;
  ${adminColorVars(ADMIN_SCHEMES.light)};
}
@media (prefers-color-scheme: light){
  :root:not([data-theme]){
    color-scheme:light;
    ${adminColorVars(ADMIN_SCHEMES.light)};
  }
}
*{box-sizing:border-box}
*::selection{background:color-mix(in srgb,var(--accent) 32%,transparent)}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--sans);
  font-size:var(--mw-t-body-size);
  line-height:var(--mw-t-body-lh);
  letter-spacing:var(--mw-t-body-tracking);
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}

/* ---- App shell: navigation drawer, scrolling main ------------------------ */
/* The drawer is 264px: wide enough for this admin's longest label at the nav
 * row's type size, and 16px back from the 280px the pill anatomy needed. It is
 * separated by a hairline down its trailing edge rather
 * than by a different ground: one fewer surface in play, and the rule reads at
 * a glance in both schemes where a 4-point luminance step does not. */
body.shell{display:grid;grid-template-columns:264px 1fr;min-height:100vh}
.side{background:var(--mw-surface);
  border-right:1px solid var(--mw-line);
  display:flex;flex-direction:column;min-height:100vh;position:sticky;top:0;
  max-height:100vh;overflow:hidden}
.side .brand{display:flex;align-items:center;gap:12px;padding:20px 20px 16px;
  text-decoration:none;color:inherit}
.side .brand svg{width:34px;height:34px;flex:0 0 auto;border-radius:8px}
.side .brand b{font-family:var(--wordmark);font-weight:700;font-size:var(--mw-t-h2-size);
  letter-spacing:.02em;line-height:1;display:block}
.side .brand small{display:block;color:var(--faint);font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;margin-top:4px}
.nav{flex:1;overflow-y:auto;padding:8px 12px 12px}
.nav-group{margin-top:16px}
/* Drawer section headers: the eyebrow role, in caps. A group of navigation
 * links needs its heading to be unmistakably not a link. */
.nav-group>span{display:block;padding:0 12px 8px;text-transform:uppercase;
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  color:var(--mw-ink-3)}
/* Drawer items: a 48px row with a 4px corner and 20px icons. 48 is the touch
 * minimum and 8px denser than the 56px pill this replaced, which bought back
 * most of a nav item on a phone. The active row is a tinted ground with a 2px
 * accent bar down its leading edge — a bar states "you are here" at a glance
 * from further away than a fill does, and it survives both schemes. */
.nav-item{position:relative;display:flex;align-items:center;gap:12px;height:48px;
  padding:0 12px;margin:0;
  border-radius:var(--mw-r-2);
  color:var(--mw-ink-2);
  text-decoration:none;font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);line-height:1.2}
.nav-item svg{width:20px;height:20px;flex:0 0 auto}
.nav-item:hover{color:var(--mw-ink);background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.nav-item:active{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-press),transparent)}
.nav-item.active{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
/* The leading bar. Inset by the row's own radius at each end so it reads as
 * part of the row rather than as a tick floating beside it. */
.nav-item.active::before{content:"";position:absolute;left:0;top:4px;bottom:4px;
  width:2px;border-radius:var(--mw-r-1);background:var(--mw-accent)}
.nav-item.active:hover{background:color-mix(in srgb,
  var(--mw-accent-soft-ink) var(--mw-wash-hover),
  var(--mw-accent-soft))}
/* An installed module's nav entry: a generic module glyph (the row stores no
 * icon) and a small "Off" badge when the household has disabled it. */
.nav-item .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-badge{flex:0 0 auto;
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  color:var(--mw-ink-2);
  background:var(--mw-surface-3);
  border-radius:var(--mw-r-1);padding:4px 8px}
.side-foot{border-top:1px solid var(--rule);padding:16px 16px;display:flex;
  flex-direction:column;gap:12px}
.side-foot-id{display:flex;align-items:center;gap:12px}
.side-foot .fmark{width:32px;height:32px;flex:0 0 auto}
.side-foot .fmark svg{width:32px;height:32px;border-radius:7px;display:block}
.side-foot .who{min-width:0;flex:1}
.side-foot .who b{font-size:var(--mw-t-label-size);font-weight:600;display:block;line-height:1.2}
.side-foot .who small{font-size:11px;color:var(--faint)}
.side-foot form{margin:0;flex:0 0 auto}
/* An icon button: 40px visual, 4px corner, and a 48px pointer target from the
 * shared ::after extension. */
.signout{margin:0;padding:0;width:40px;height:40px;display:grid;place-items:center;
  background:transparent;color:var(--mw-ink-2);border:0;
  border-radius:var(--mw-r-2);cursor:pointer}
.signout:hover{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.signout::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.signout svg{width:24px;height:24px}
/* Admin theme toggle: styled with the segmented buttons further down. */

.main{min-width:0;display:flex;flex-direction:column}
/* A small top app bar: 64px container, title-large, on the surface-container
 * page ground with a hairline under it. These pages carry no script, so the
 * bar cannot restyle itself on scroll — the rule is there always, which is
 * honest and costs nothing: no blur, no translucency, no shadow. */
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;
  justify-content:space-between;gap:16px;min-height:64px;padding:8px 28px;
  background:var(--mw-surface)}
.topbar .crumb{font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-2);margin:0 0 4px}
/* The same crumb as a real link back up a level, with the arrow that says so.
 * Its pointer target is stretched the way every sub-48px control here is. */
.crumb-back{position:relative;display:inline-flex;align-items:center;gap:4px;
  color:var(--mw-accent);text-decoration:none}
.crumb-back::after{content:"";position:absolute;left:-6px;right:-6px;top:50%;
  height:44px;transform:translateY(-50%)}
.crumb-back:hover{text-decoration:underline}
.crumb-back svg{width:15px;height:15px}
.topbar h1{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);
  color:var(--mw-ink);margin:0}
/* The kicker and title take the slack, so the bar reads the same whether or
 * not a page supplies an action: the pair sits left, the action right. It has
 * to be said rather than left to justify-content once a third child — the
 * compact width's leading icon — joins them. */
.topbar-title{flex:1;min-width:0}
/* The modal drawer's three parts, all of them placement below 900px and none
 * of them drawn at this width, where the drawer is in flow and always there. */
.nav-toggle,.nav-scrim,.navbtn{display:none}
.content{padding:24px 28px 52px;max-width:1180px;width:100%}
.content>form:first-child,.content>.card:first-child,.content>.note:first-child{margin-top:0}
/* The page's lead line. Used to sit in the topbar as .sub; moved into the
 * content so the sticky bar stays a compact kicker+title and gives ~40px back. */
.note{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 20px;max-width:64ch}

/* ---- Compact width: the same drawer, modal ------------------------------
 * 900px, up from 820: the drawer is 264px, and the main column must keep at
 * least what it had when the drawer was 216.
 *
 * Below it the drawer used to be recast in place — a wrapping field of pills
 * with its group headings hidden, its pills cut to 40px, and its foot removed
 * outright. That put eleven-plus destinations, ungrouped, above the content of
 * every page: on a phone the page began below the fold, and because each admin
 * screen is a fresh document the whole field came back on every tap. Sign-out
 * and the theme toggle simply were not reachable.
 *
 * The answer at this width is a *modal* drawer, and it is the same panel
 * rather than a redrawn one: fixed, off-canvas, over a scrim, opened from the
 * app bar's leading icon. Everything here is placement, so the headings, the
 * 56px pills and the foot all come back by not being overridden, and navBar()
 * keeps rendering one markup for both widths.
 *
 * None of it runs any script. The open state is a checkbox the CSS reads, so
 * the drawer works on a page whose JavaScript never arrived — and since every
 * link is a full page load, the next document arrives with the box unchecked,
 * which closes the drawer on navigation with nothing to remember and nothing
 * to restore. */
@media(max-width:900px){
  body.shell{grid-template-columns:1fr}
  /* Above the savebar and the layers popover (20, 30), below the layout
   * editor's modal dialog (50): a dialog outranks a navigation drawer, and
   * while one is open it covers the button that would open this. 86vw leaves a
   * strip of the page showing on a narrow phone, which is what says the drawer
   * is a layer over the page rather than a new one. */
  .side{position:fixed;top:0;left:0;bottom:0;z-index:41;
    width:min(280px,86vw);min-height:0;max-height:none;
    box-shadow:var(--mw-shadow-1);
    transform:translateX(-100%);visibility:hidden}
  .nav{overscroll-behavior:contain}
  /* visibility, not the transform alone: a panel that is merely translated off
   * the canvas is still in the tab order, so a keyboard would walk into a
   * drawer nobody can see. */
  .nav-toggle:checked~.side{transform:none;visibility:visible}
  /* margin:0 because both of these are <label>, and the generic form-label
   * rule further up carries a margin of 1rem/.35rem. On a fixed inset:0 scrim
   * that margin is not cosmetic: it held the sheet 16px clear of the top of
   * the viewport, leaving a strip across the app bar where a tap fell through
   * to the page behind an open drawer. Measured, not read. */
  .nav-scrim{display:block;position:fixed;inset:0;z-index:40;margin:0;
    background:var(--mw-scrim);opacity:0;visibility:hidden}
  /* touch-action so a drag on the scrim does not scroll the page underneath,
   * which is the one part of "modal" that CSS alone can still honour. */
  /* opacity is the fade channel only — the *density* of the scrim lives in
   * --mw-scrim, which is already an rgba. Multiplying the two is how this
   * ended up at 19% black and dimming nothing you could see. */
  .nav-toggle:checked~.nav-scrim{opacity:1;visibility:visible;touch-action:none}
  /* Focusable and invisible. The control a person sees is the label in the app
   * bar, so the focus ring is drawn there — the same move the theme cards make
   * for their hidden radio — and opacity:0 takes this one's own ring with it. */
  .nav-toggle{display:block;position:fixed;top:0;left:0;width:48px;height:48px;
    margin:0;opacity:0;pointer-events:none}
  .nav-toggle:focus-visible~.main .navbtn{
    outline:3px solid var(--mw-accent);outline-offset:2px}
  /* The app bar's leading icon: 40px visual with the 48px pointer target every
   * control under 48px extends to, and 12px of bar padding, which lands the
   * 24px glyph's left edge on the content's own 20px margin below it. */
  .navbtn{display:grid;place-items:center;position:relative;flex:0 0 auto;margin:0;
    width:40px;height:40px;border-radius:var(--mw-r-2);
    color:var(--mw-ink-2);cursor:pointer}
  .navbtn::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
    transform:translate(-50%,-50%)}
  .navbtn svg{width:24px;height:24px}
  .navbtn:hover{color:var(--mw-ink);background:color-mix(in srgb,
    var(--mw-ink-2) var(--mw-wash-hover),transparent)}
  .navbtn:active{background:color-mix(in srgb,
    var(--mw-ink-2) var(--mw-wash-press),transparent)}
  .topbar{padding:8px 20px 8px 12px;gap:8px}
  .content{padding:20px 20px 48px}
}

/* ---- Wizard / sign-in: a centred column, no sidebar --------------------- */
body.wiz{display:flex;align-items:flex-start;justify-content:center;
  padding:40px 20px;min-height:100vh}
.wizbox{width:100%;max-width:520px}
.wizbox .brand{display:flex;align-items:center;gap:12px;text-decoration:none;
  color:inherit;margin:0 0 4px}
.wizbox .brand svg{width:34px;height:34px;border-radius:8px}
.wizbox .brand b{font-family:var(--wordmark);font-weight:700;font-size:var(--mw-t-h2-size)}
/* The step indicator as a plain linear measure: a 4px square-ended
 * track per step on surface-container-highest, filled primary once a step is
 * reached. Captions are label-medium mixed case, coloured by state — the
 * current step primary, done steps on-surface-variant, upcoming ones
 * outline. */
.steps{display:flex;gap:8px;margin:24px 0 28px;padding:0;list-style:none}
.steps .step{flex:1;text-align:center}
.steps .step .bar{height:4px;border-radius:var(--mw-r-0);
  background:var(--mw-surface-3)}
.steps .step.done .bar,.steps .step.on .bar{background:var(--mw-accent)}
.steps .step span{display:block;margin-top:8px;
  font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-3)}
.steps .step.on span{color:var(--mw-accent)}
.steps .step.done span{color:var(--mw-ink-2)}
.wizbox .card{margin:0}
.wizbox>form,.wizbox>.error{margin-top:20px}

/* ---- Typography ----------------------------------------------------------
 * Mapped onto the M3 scale: page titles are headline roles, section heads are
 * title-large, card heads title-medium, controls label-large, kickers the
 * label roles. The uppercase kicker treatment is retired — the foundations
 * pass kept it as a brand device, and the component pass's fidelity decision
 * (docs/m3-adoption-prompts.md, kept outside the repo like the design file)
 * reversed that: kickers, labels and tags are mixed case on the roles' own
 * tracking, the way an M3 application writes them. The surfaces pass finished
 * the job: every component style is on the scale, the --cond token is gone,
 * and Roboto Condensed survives only in the wordmark's fallback stack. */
h1{font:var(--mw-t-h1);
  letter-spacing:var(--mw-t-h1-tracking);margin:0 0 4px}
p{color:var(--muted);margin:.5rem 0;line-height:1.55}
a.link{color:var(--accent);text-decoration:none;font-weight:600}
a.link:hover{text-decoration:underline}
/* Any inline arrow inside a link (list "Open →", "Manage →") stays small. */
.link{display:inline-flex;align-items:center;gap:4px}
.link svg{width:14px;height:14px;flex:0 0 auto}
.kick{font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-2)}
/* overflow-wrap so a pasted URL or long code wraps instead of widening the
 * page — a phone must never scroll sideways for a release address. */
.code{font-family:var(--mono);font-size:16px;letter-spacing:.08em;
  background:var(--panel2);padding:0.25rem 0.5rem;border-radius:.25rem;color:var(--accent);
  overflow-wrap:anywhere}

/* ---- Forms --------------------------------------------------------------- */
form{margin:1.5rem 0 0}
/* Bare labels outside the .field system (bundle-built rows, specialist
 * controls). Mixed case: the uppercase kicker treatment is retired. */
label{display:block;margin:1rem 0 0.25rem;
  font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);color:var(--muted)}
/* The generic input skin stays for inputs the display bundle builds at
 * runtime (.hep-search, the layout editor's controls); everything
 * server-rendered sits inside a .field below, which overrides this. Fields
 * are body-large: the one place the M3 spec names a role outright. */
input[type=text],input[type=email],input[type=password],input[type=number],
input[type=time],select,textarea{
  width:100%;padding:0.5rem 0.75rem;border-radius:var(--mw-r-1);
  border:1px solid var(--mw-ink-3);
  background:transparent;color:var(--mw-ink);font-family:inherit;
  font-size:var(--mw-t-body-lg-size)}
textarea{resize:vertical;line-height:1.45}
input::placeholder,textarea::placeholder{color:var(--mw-ink-2)}
input[type=color]{width:100%;height:2.6rem;padding:0.25rem;
  border-radius:var(--mw-r-1);
  border:1px solid var(--mw-ink-3);background:transparent}
input[type=file]{width:100%;padding:0.5rem;border-radius:var(--mw-r-1);
  border:1px solid var(--mw-ink-3);background:transparent;
  color:var(--mw-ink-2);font-size:var(--mw-t-body-size)}

/* ---- Text fields: a label above a bordered input --------------------------
 * This replaced Material's outlined field with the floating label. The label
 * sits above the control at full size, which is the whole point: in the old
 * anatomy the name of the field was 12.5px riding the border, the smallest
 * text on a page whose brief is glanceability.
 *
 * The ground is transparent and the border does the defining. A filled input
 * was tried first and reads as *disabled* on the light scheme's white card —
 * a grey box is what a browser draws for a control you cannot type in. Letting
 * the field take whatever it sits on also means one rule works on a card, in a
 * compact settings row and in the wizard, which sit on three different grounds.
 *
 * The border is --mw-ink-3, not the divider colour: an input's edge is the
 * boundary of a control, which WCAG holds to 3:1, while a divider inside a
 * card is meant to be near-invisible. They are different jobs and the palette
 * keeps them as different roles.
 *
 * The control is a 40px box with a 1px border and a 2px corner. Focus swaps
 * the border to the accent and thickens it to 2px, and compensates the padding
 * so nothing shifts by a pixel when it does — that is the one thing a drawn
 * border has to get right and the reason the old field notched an outline
 * rather than growing one.
 *
 * There is no .field-static any more, and no placeholder=" " on every input:
 * both existed only so :placeholder-shown could tell an empty field from a
 * prefilled one, and nothing floats now. */
.field{position:relative;display:block;margin:var(--mw-s-4) 0 0;color:var(--mw-ink)}
.field-label{display:block;margin:0 0 var(--mw-s-1);color:var(--mw-ink-2);
  font:var(--mw-t-label);letter-spacing:var(--mw-t-label-tracking)}
.field .field-input{width:100%;height:40px;padding:0 12px;
  border:1px solid var(--mw-ink-3);border-radius:var(--mw-r-2);
  background:transparent;
  color:var(--mw-ink);caret-color:var(--mw-accent);
  font-family:var(--sans);
  font-size:var(--mw-t-body-size);
  letter-spacing:var(--mw-t-body-tracking)}
.field .field-input::placeholder{color:var(--mw-ink-3)}
.field:hover .field-input{border-color:var(--mw-ink-2)}
/* The border grows by 1px on focus; padding used to shrink by the same
 * amount so the text held still, but that 1px offset has no representation on
 * the 4px spacing grid, so both states now share one padding value and the
 * text shifts by the border's 1px alone. The shared focus ring stands down
 * inside a .field — the border is the focus affordance here, and two rings on
 * one control reads as a fault. */
.field .field-input:focus,.field .field-input:focus-visible{outline:none;
  border:2px solid var(--mw-accent);padding:0 12px}
.field:focus-within .field-label{color:var(--mw-accent)}
/* The error variant, for pages that re-render with a field at fault. */
.field.field-error .field-input{border-color:var(--mw-danger)}
.field.field-error .field-label,
.field.field-error:focus-within .field-label{color:var(--mw-danger)}
.field.field-error .field-input:focus{border-color:var(--mw-danger)}
/* Selects hide the native chrome and get a drawn caret in the wrapper. The
 * caret is offset by the label's height so it lands on the control, not on
 * the label above it. */
.field select.field-input{appearance:none;-webkit-appearance:none;padding-right:36px}
.field-select::after{content:"";position:absolute;right:14px;bottom:16px;width:7px;height:7px;
  border-right:2px solid var(--mw-ink-2);
  border-bottom:2px solid var(--mw-ink-2);
  transform:rotate(45deg);pointer-events:none}
.field textarea.field-input{height:auto;min-height:80px;padding:8px 12px;resize:vertical;
  line-height:var(--mw-t-body-lh)}
.field textarea.field-input:focus{padding:8px 12px}
.field input[type=color].field-input{padding:4px 8px}
.field input[type=file].field-input{padding:8px 12px;height:auto;
  color:var(--mw-ink-2)}
/* Supporting text, aligned to the field edge rather than indented — there is
 * no 16px inset to line up with any more. */
.field-hint{margin:var(--mw-s-1) 0 0;color:var(--mw-ink-2);
  font:var(--mw-t-body-sm);letter-spacing:var(--mw-t-body-sm-tracking)}
.field-hint.is-error{color:var(--mw-danger)}
/* A field with a "?" riding it as a trailing icon (left of a select's caret);
 * its popover opens under the field. Both offsets are measured from the
 * bottom of the control, so the label above never moves them. */
.field-with-help{position:relative}
.field-with-help .fieldhelp{position:absolute;right:32px;bottom:8px}
.field-with-help .helppop{top:auto;bottom:-8px;left:auto;right:0;
  transform:translateY(100%)}


/* ---- Checkboxes and switches, on the native input, no script --------------
 * appearance:none leaves the real checkbox in the form; only the paint is
 * ours. The 18px box grows its pointer target to 48px with a pseudo-element
 * that also carries the hover state layer, drawn as a radial so the visible
 * circle stays 40px inside the 48px square target. */
.checks{margin-top:1rem}
.checks label{display:flex;gap:.75rem;align-items:center;margin:0;min-height:48px;
  font-family:var(--sans);font-weight:400;font-size:14px;letter-spacing:0;
  color:var(--mw-ink);cursor:pointer}
.checks input[type=checkbox],.hep-row input[type=checkbox],
.le-cfg-check input[type=checkbox]{
  appearance:none;-webkit-appearance:none;position:relative;flex:0 0 auto;margin:0;
  width:18px;height:18px;border-radius:2px;cursor:pointer;background:transparent;
  border:2px solid var(--mw-ink-2)}
.checks input[type=checkbox]::before,.hep-row input[type=checkbox]::before,
.le-cfg-check input[type=checkbox]::before{
  content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.checks input[type=checkbox]:hover::before,.hep-row input[type=checkbox]:hover::before,
.le-cfg-check input[type=checkbox]:hover::before{
  background:radial-gradient(circle 20px at 50% 50%,color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent) 0 20px,
  transparent 20px)}
.checks input[type=checkbox]:checked,.hep-row input[type=checkbox]:checked,
.le-cfg-check input[type=checkbox]:checked{
  background:var(--mw-accent);border-color:var(--mw-accent)}
.checks input[type=checkbox]:checked:hover::before,.hep-row input[type=checkbox]:checked:hover::before,
.le-cfg-check input[type=checkbox]:checked:hover::before{
  background:radial-gradient(circle 20px at 50% 50%,color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-hover),transparent) 0 20px,
  transparent 20px)}
/* The check glyph: a drawn tick, on-primary, centred in the 14px inner box. */
.checks input[type=checkbox]:checked::after,.hep-row input[type=checkbox]:checked::after,
.le-cfg-check input[type=checkbox]:checked::after{
  content:"";position:absolute;left:3px;top:6px;width:8px;height:4px;
  border-left:2px solid var(--mw-accent-ink);
  border-bottom:2px solid var(--mw-accent-ink);
  transform:rotate(-45deg);transform-origin:center}

/* A row of checkboxes that is one *selection* rather than seven settings —
 * days of the week being the case that exists. Stacked, they are seven 48px
 * rows: on a 390px phone the picker alone was taller than the viewport, and a
 * list of chores stopped being a list. Wrapped, the 48px pointer targets are
 * untouched; only the flow changes. */
.checks-inline{display:flex;flex-wrap:wrap;gap:0 20px}
.checks-inline legend{width:100%}
.checks-inline label{min-width:4.5rem}

/* A paused chore's card. Quieter, not hidden: it is still a chore the household
   set up and the screen it lives on is where they go to bring it back. The tag
   in the heading is what says so; this only stops it competing with the ones
   that are actually running. */
.card.is-paused>*:not(.row){opacity:.62}
.card.is-paused h2 .tag{margin-left:12px;vertical-align:middle}
/* The action row keeps full contrast. Dimming the whole card also dimmed
   *Resume*, which is the one control somebody opens a paused chore to press —
   quieting the content is the point, quieting the way back out is not. */
.card.is-paused .row{opacity:1}

/* A card's editor, folded away until asked for. A <details>, so it costs no
 * script — the same reason the overflow menu is one. The point is that a list
 * of things reads as a list: the summary carries the affordance and the card's
 * own heading above it carries the facts, so nothing has to be opened to scan. */
.disclose{margin-top:1rem;border-top:1px solid var(--mw-line);padding-top:.25rem}
.disclose>summary{list-style:none;display:inline-flex;align-items:center;gap:8px;
  min-height:48px;padding:0 4px;cursor:pointer;font-family:var(--sans);font-size:14px;
  font-weight:500;color:var(--mw-accent)}
.disclose>summary::-webkit-details-marker{display:none}
.disclose>summary::marker{content:""}
.disclose>summary::after{content:"";width:8px;height:8px;
  border-right:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(45deg) translate(-2px,-2px)}
.disclose[open]>summary::after{transform:rotate(-135deg) translate(-2px,-2px)}
.disclose>summary:hover{text-decoration:underline}

/* A switch where one checkbox means one on/off setting. Still an
 * input[type=checkbox] with its original name, so form handling never knows;
 * the input itself is the 52x32 track and its ::before is the thumb, growing
 * from 16px (outline colour) to 24px (on-primary) when checked. The row is
 * 48px tall, which is the pointer target. */
.switch{display:flex;align-items:center;justify-content:space-between;gap:16px;
  min-height:48px;margin:0.25rem 0;cursor:pointer;
  font:var(--mw-t-body);
  letter-spacing:var(--mw-t-body-tracking);text-transform:none}
.switch .switch-text{min-width:0}
.switch .switch-text b{display:block;font-weight:500;font-size:14px;
  color:var(--mw-ink)}
.switch .switch-text small{display:block;font-size:12px;line-height:1.4;
  color:var(--mw-ink-2)}
.switch input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;
  flex:0 0 auto;margin:0;width:52px;height:32px;cursor:pointer;
  border-radius:var(--mw-r-full);
  background:var(--mw-surface-3);
  border:2px solid var(--mw-ink-3)}
.switch input[type=checkbox]::before{content:"";position:absolute;top:50%;left:6px;
  width:16px;height:16px;border-radius:50%;background:var(--mw-ink-3);
  transform:translateY(-50%)}
.switch input[type=checkbox]:checked{background:var(--mw-accent);
  border-color:var(--mw-accent)}
.switch input[type=checkbox]:checked::before{left:22px;width:24px;height:24px;
  background:var(--mw-accent-ink)}
.switch input[type=checkbox]:active::before{width:22px;height:22px}
.switch input[type=checkbox]:checked:active::before{width:28px;height:28px;left:20px}

.row-fields{display:flex;gap:1rem;flex-wrap:wrap}
.row-fields span,.row-fields .field{flex:1 1 12rem}
.row-fields .field{margin-top:1rem}

/* ---- Buttons ---------------------------------------------------------------
 * The default is a filled button: 40px container, 4px corner, 20px of side
 * padding, 14px beside a leading icon. Square-ish is the point — a fully
 * rounded button is the single loudest Material tell, and a wall calendar's
 * settings should read as a fixture rather than as a phone app.
 *
 * .secondary/.btn-ghost are outlined, .tonal/.btn-tonal is a tinted fill for a
 * secondary action that deserves more weight, .btn-danger is outlined on the
 * error role. Hover and pressed tint the container with its own label colour
 * rather than filter:brightness, which would also dim the text. Every compact
 * variant is the same anatomy at 32px, and every control smaller than 48px
 * extends its pointer target with an ::after pseudo, never its visual. */
button,.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;
  gap:8px;margin-top:1.5rem;height:40px;padding:0 24px;
  border-radius:var(--mw-r-2);border:1px solid transparent;
  background:var(--mw-accent);color:var(--mw-accent-ink);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  cursor:pointer;line-height:1;text-decoration:none;white-space:nowrap;user-select:none}
/* The pointer target, stretched to at least 48px in both axes for every
 * button — 40px is the visual, not the target. The pseudo
 * is absolute, so flex layouts inside the button never see it; variants with
 * their own ::after (segments, icon buttons) override this one. */
button::after,.btn::after{content:"";position:absolute;left:50%;top:50%;
  width:max(100%,48px);height:max(100%,48px);transform:translate(-50%,-50%)}
button:hover,.btn:hover{background:color-mix(in srgb,
  var(--mw-accent-ink) var(--mw-wash-hover),
  var(--mw-accent))}
button:active,.btn:active{background:color-mix(in srgb,
  var(--mw-accent-ink) var(--mw-wash-press),
  var(--mw-accent))}
button:has(svg),.btn:has(svg){padding-left:16px}
button svg,.btn svg{width:18px;height:18px}
button.secondary,.btn-ghost{background:transparent;color:var(--mw-accent);
  border-color:var(--mw-ink-3)}
button.secondary:hover,.btn-ghost:hover{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-hover),transparent)}
button.secondary:active,.btn-ghost:active{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-press),transparent)}
button.tonal,.btn-tonal{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink);border-color:transparent}
button.tonal:hover,.btn-tonal:hover{background:color-mix(in srgb,
  var(--mw-accent-soft-ink) var(--mw-wash-hover),
  var(--mw-accent-soft))}
button.tonal:active,.btn-tonal:active{background:color-mix(in srgb,
  var(--mw-accent-soft-ink) var(--mw-wash-press),
  var(--mw-accent-soft))}
/* A text button: no container at rest, accent label, a tint on interaction —
 * the lowest-emphasis action, e.g. the wizard's "Skip for now". */
button.text,.btn-text{background:transparent;color:var(--mw-accent);
  border-color:transparent;padding:0 12px}
button.text:hover,.btn-text:hover{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-hover),transparent)}
button.text:active,.btn-text:active{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-press),transparent)}
.btn-danger{background:transparent;color:var(--mw-danger);
  border-color:var(--mw-ink-3)}
.btn-danger:hover{background:color-mix(in srgb,
  var(--mw-danger) var(--mw-wash-hover),transparent)}
.btn-danger:active{background:color-mix(in srgb,
  var(--mw-danger) var(--mw-wash-press),transparent)}
/* Compact density: the same button at a 32px container, with the pointer
 * target stretched back to 48px by a pseudo-element. */
.btn-sm{margin-top:0;height:32px;padding:0 16px}
/* ---- Segmented buttons: .seg (Store alerts), .le-orient, .themebar --------
 * One outlined container, full corner on the outer ends, 40px height; the
 * selected segment is secondary-container with a leading check drawn in CSS.
 * No overflow:hidden — it would clip the focus ring — so the end radii live on
 * the end segments themselves. */
.seg,.le-orient,.themebar{display:inline-flex;margin:0;border:1px solid var(--mw-ink-3);
  border-radius:var(--mw-r-2);background:transparent;overflow:visible}
.seg button,.le-orient-btn,.themebtn{position:relative;flex:1;margin:0;height:38px;
  padding:0 16px;border:0;border-left:1px solid var(--mw-ink-3);border-radius:0;
  background:transparent;color:var(--mw-ink);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.seg button:first-child,.le-orient-btn:first-child,.themebtn:first-child{border-left:0;
  border-radius:var(--mw-r-2) 0 0 var(--mw-r-2)}
.seg button:last-child,.le-orient-btn:last-child,.themebtn:last-child{
  border-radius:0 var(--mw-r-2) var(--mw-r-2) 0}
.seg button:hover,.le-orient-btn:hover,.themebtn:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.seg button:active,.le-orient-btn:active,.themebtn:active{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-press),transparent)}
.seg button.on,.le-orient-btn.is-on,.themebtn[data-active="true"]{
  background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
.seg button.on:hover,.le-orient-btn.is-on:hover,.themebtn[data-active="true"]:hover{
  background:color-mix(in srgb,
  var(--mw-accent-soft-ink) var(--mw-wash-hover),
  var(--mw-accent-soft))}
/* The selected segment's leading check, drawn rather than fetched: a small box
 * with two borders, rotated into a tick. */
.seg button.on::before,.le-orient-btn.is-on::before,.themebtn[data-active="true"]::before{
  content:"";width:9px;height:5px;margin-top:-4px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}
/* The sidebar's theme toggle fills its row, and its segments carry short
 * labels in a tight column, so they trade the 16px padding for 10px. */
.themebar{display:flex}
.themebtn{padding:0 12px}
.seg button::after,.le-orient-btn::after,.themebtn::after{content:"";position:absolute;
  left:0;right:0;top:50%;height:48px;transform:translateY(-50%)}

/* ---- Errors and disclaimers (the .error box) -----------------------------
 * A tinted error container, 6px corner,
 * everything in it on-error-container. The old left accent border retired
 * with the rest of the blueprint identity. */
/* color on the container itself, so bare text (the wizard's errors) gets the
 * on-error-container role too — not just the strong/span children below. */
.error{background:var(--mw-danger-soft);
  color:var(--mw-danger);
  padding:1rem 1rem;border-radius:var(--mw-r-3);margin:1rem 0}
.error strong{color:var(--mw-danger);display:block;
  font-size:14px;font-weight:600;margin-bottom:4px}
.error span{color:var(--mw-danger);font-size:var(--mw-t-label-size);line-height:1.5}

/* ---- The confirmation strip (RFC 009 Phase 3.1) --------------------------
 * The .error box's calm twin: the same tinted container and 6px corner, on the
 * ok pair rather than the danger one, so a save and a failure are the same
 * shape in two colours and neither has to be read to be told apart. Deliberately
 * one line and no heading — a confirmation that needs a title is a confirmation
 * doing too much.
 *
 * The dismiss control clears its background, so it declares its own hover and
 * pressed states: button,.btn is the *filled* variant and its state rules
 * would otherwise fill this with the accent and draw the glyph gold on gold
 * (see test/admin-button-states.test.ts). */
.saved{display:flex;align-items:center;gap:.75rem;
  background:var(--mw-ok-soft);color:var(--mw-ok);
  padding:0.75rem 0.75rem 0.75rem 1rem;border-radius:var(--mw-r-3);margin:0 0 1rem}
.saved-text{flex:1;font-size:14px;font-weight:600;line-height:1.4}
.saved-x{display:inline-flex;align-items:center;justify-content:center;
  flex:none;width:32px;height:32px;background:none;border:0;padding:0;
  border-radius:var(--mw-r-2);color:var(--mw-ok);cursor:pointer;text-decoration:none}
.saved-x svg{width:18px;height:18px}
.saved-x:hover{background:var(--mw-surface-2)}
.saved-x:active{background:var(--mw-surface-3)}
/* The glyph stays 18px; the target does not. A dismiss is the one thing on
 * this strip somebody taps, and 32px on a phone is under the minimum — so the
 * box grows and the icon does not, which is the distinction Phase 7's sweep is
 * about. A new control shipping under the bar would be one more line for that
 * sweep to find. */
@media(max-width:900px){.saved-x{width:44px;height:44px}}

/* ---- The foot of a settings form (RFC 009 Phase 3.2) ---------------------
 * [hidden] is spelled out against the class rather than left to the browser:
 * button,.btn declares display:inline-flex, which beats the user agent's
 * [hidden]{display:none} outright — so a Cancel marked hidden would sit there
 * in plain sight on every form that has nothing to cancel. (0,2,0) over
 * (0,0,1), the same reason the editor's panels each carry their own rule. */
/* The clipped default submit (see defaultSubmit): out of sight, out of the
 * accessibility tree, and still the first submit in tree order — which is the
 * only thing that decides what Enter does. Clipped rather than display:none or
 * [hidden], because what a non-rendered submit does on implicit submission
 * varies by browser, and the whole point of this element is that it is not in
 * any doubt. Proven by pressing Enter in a real one (browser-admin.test.ts). */
.formdefault{position:absolute;width:1px;height:1px;min-height:0;padding:0;margin:0px;
  border:0;overflow:hidden;clip-path:inset(50%)}
.saverow{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:1rem}
.saverow>button{margin-top:0}
.saverow [hidden]{display:none}
.dirtyflag{font:var(--mw-t-label-sm);letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-warn)}

/* ---- Cards ----------------------------------------------------------------
 * One kind, two states. A card is a flat panel on the surface with a hairline
 * border and a 6px corner — no shadow, because a settings page stacked with
 * floating slabs is the look this design system exists to get away from.
 *
 * A card that navigates (a.card, the stat tiles) says so by lifting its ground
 * one step and taking a stronger border on hover, not by casting a shadow. The
 * distinction still reads, and it survives at any elevation of the page. */
.card{position:relative;background:var(--mw-surface);
  border:1px solid var(--mw-line);
  border-radius:var(--mw-r-3);padding:var(--mw-s-4);margin:1rem 0}
.card h2{font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);margin:0;
  display:flex;align-items:center;gap:.5rem}
.card p{margin:0.5rem 0}
.card .host,.host{color:var(--faint);font-size:12.5px;font-family:var(--mono);
  margin:0.25rem 0}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.row form{margin:.75rem 0 0}
.row button{margin-top:0}
h2.add{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);
  margin:2rem 0 0;padding-top:1.5rem;border-top:1px solid var(--rule)}
p.hint,.hint{font-size:12.5px;color:var(--mw-ink-2);margin:0.25rem 0 0;line-height:1.5}

/* ---- Grids and section headers ------------------------------------------ */
.grid{display:grid;gap:16px;margin:1rem 0}
.g3{grid-template-columns:repeat(3,1fr)}
.g2{grid-template-columns:repeat(2,1fr)}
@media(max-width:1040px){.g3{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.g3,.g2{grid-template-columns:1fr}}
.sect{margin-top:32px}
.sect:first-child{margin-top:0}
.sect-head{display:flex;align-items:baseline;justify-content:space-between;
  gap:1rem;margin-bottom:16px}
.sect-head h2{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);margin:0}

/* ---- Stat cards: the kind that navigate --------------------------------- */
a.card{display:block;text-decoration:none;color:inherit}
a.card:hover{background:var(--mw-surface-2);border-color:var(--mw-line-strong)}
a.card:active{background:var(--mw-surface-3)}
.stat .top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.stat .subrow .link{display:inline-flex;align-items:center;gap:4px}
.stat .subrow .link svg{width:13px;height:13px}
.ic{width:34px;height:34px;border-radius:var(--mw-r-2);display:grid;place-items:center;
  background:var(--panel2);border:1px solid var(--rule);color:var(--accent);flex:0 0 auto}
.ic svg{width:18px;height:18px}

/* ---- Overview status + today cards --------------------------------------- */
.status-card .frow{display:flex;align-items:center;gap:12px;padding:12px 0;
  border-top:1px solid var(--ruleSoft)}
.status-card .frow:first-child{padding-top:0;border-top:0}
.status-card .frow:last-child{padding-bottom:0}
.status-card .frow .ic{width:30px;height:30px}
.status-card .frow .ic svg{width:16px;height:16px}
.rname{font-weight:600;font-size:14px}
.status-card .frow .link{display:inline-flex;align-items:center;gap:4px}
.status-card .frow .link svg{width:13px;height:13px}
.today-card{display:flex;flex-direction:column}
/* line-height guards: body's role line-height is a px length, which inherits
 * as-is into any larger text that does not set its own. */
.today-big{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);margin:8px 0 4px}
.stat .ic{width:34px;height:34px;border-radius:var(--mw-r-2);display:grid;place-items:center;
  background:var(--panel2);border:1px solid var(--rule);color:var(--accent)}
.stat .ic svg{width:18px;height:18px}
.stat .big{font:var(--mw-t-h1);
  letter-spacing:var(--mw-t-h1-tracking);margin:12px 0 4px}
.stat .lab{color:var(--muted);font-size:13.5px}
.stat .subrow{margin-top:12px;padding-top:12px;border-top:1px solid var(--ruleSoft);
  font-size:12.5px;color:var(--faint);display:flex;align-items:center;
  justify-content:space-between;gap:.5rem}

/* ---- Status dots and tags ------------------------------------------------ */
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.dot-ok{background:var(--ok)}.dot-bad{background:var(--danger)}
.dot-idle{background:var(--faint)}
.pulse{position:relative}
/* The ring itself; its animation binds in the Motion section, so a reduced-
 * motion setting stills it to a plain ring. */
.pulse::after{content:"";position:absolute;inset:-4px;border-radius:50%;
  border:1px solid var(--ok);opacity:.6}
@keyframes pl{0%{transform:scale(.6);opacity:.7}100%{transform:scale(1.7);opacity:0}}
/* Status tags: a tinted ground and the hue's own text, never a solid fill.
 * Set in the eyebrow role, which is small and tracked out — mixed case, not
 * caps: "On, working out your zones" is a sentence, and a sentence in caps on
 * a settings page reads as an alarm. */
.tag{display:inline-flex;align-items:center;gap:8px;
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  padding:4px 12px;border-radius:var(--mw-r-2);
  background:var(--mw-surface-3);
  color:var(--mw-ink-2)}
.tag-ok{background:var(--mw-ok-soft);
  color:var(--mw-ok)}
.tag-bad{background:var(--mw-danger-soft);
  color:var(--mw-danger)}
.tag-accent{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;
  background:var(--swatch);flex:0 0 auto;vertical-align:baseline}
img.avatar{width:1.7rem;height:1.7rem;border-radius:50%;object-fit:cover;
  margin-right:0.5rem;vertical-align:-.4rem;background:var(--panel2)}

/* ---- Sub-view switcher (per-wall Appearance | Layout) -------------------- */
/* ---- Store card glyph preview ("screenshot" spelled out in glyphs) -------- */
/* A little inset tile beside the icon, styled like a wall stat panel: a big
 * headline line then a caption or two. First-party glyphs only, no image. */
.cpreview{flex:0 0 auto;width:118px;min-height:64px;display:flex;flex-direction:column;
  justify-content:center;gap:4px;padding:8px 12px;border-radius:var(--mw-r-2);
  background:var(--panel2);border:1px solid var(--rule);overflow:hidden}
.cpreview b{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);
  color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpreview i{font-style:normal;font-size:11px;line-height:1.25;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:560px){.cpreview{display:none}}

/* ---- Theme builder (custom themes) --------------------------------------- */
.theme-builder{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start;margin-top:.5rem}
/* 1000px, not the shell's 900: below this the 320px preview column starves
 * the controls beside the 264px drawer. */
@media(max-width:1000px){.theme-builder{grid-template-columns:1fr}}
.tb-controls{min-width:0}
.tb-controls>.tb-group{display:block;margin:1.5rem 0 0.25rem;
  font:var(--mw-t-h4);
  letter-spacing:var(--mw-t-h4-tracking);
  color:var(--mw-ink-2)}
.tf-row{display:flex;align-items:center;gap:12px;margin:8px 0}
.tf-row input[type=color]{width:46px;height:34px;flex:0 0 auto;padding:4px;margin:0}
.tf-row b{display:block;font-size:14px;font-weight:600}
.tf-row small{display:block;color:var(--faint);font-size:12px;line-height:1.35}
.tb-preview{position:sticky;top:88px}
#theme-preview{width:300px;max-width:100%;min-height:220px;border:1px solid var(--rule);
  border-radius:var(--mw-r-2);overflow:hidden;background:var(--panel2)}
#theme-contrast{margin-top:12px}

/* ---- Theme picker cards (Display) ---------------------------------------- */
.themegrid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:0.5rem}
@media(max-width:560px){.themegrid{grid-template-columns:1fr}}
/* A selectable filled card: the swatch strip bleeds to the corner, the chosen
 * one carries a 2px primary ring (a shadow, so nothing shifts). */
.themecard{position:relative;display:block;
  background:var(--mw-surface-3);
  border-radius:var(--mw-r-3);overflow:hidden;cursor:pointer}
.themecard input{position:absolute;opacity:0;pointer-events:none}
.themecard .sw{height:60px;display:flex}
.themecard .sw i{flex:1}
.themecard .cap{padding:12px 16px}
.themecard .cap b{
  font:var(--mw-t-h4);
  letter-spacing:var(--mw-t-h4-tracking);display:block;
  color:var(--mw-ink)}
.themecard .cap small{color:var(--mw-ink-2);font-size:var(--mw-t-label-xs-size)}
.themecard:hover .cap{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.themecard:has(input:checked){box-shadow:0 0 0 2px var(--mw-accent)}

/* ---- Preview panel (calendar test, update-available, shift preview) ------ */
.preview{position:relative;border:1px solid var(--rule);border-radius:var(--mw-r-2);
  padding:16px 20px;margin:1rem 0;background:var(--panel2)}
.preview h3{font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);margin:0 0 0.25rem}
.preview ul{list-style:none;margin:0.5rem 0 0;padding:0}
.preview li{display:flex;gap:1rem;padding:.5rem 0;font-size:14px;
  border-top:1px solid var(--ruleSoft)}
.preview li:first-child{border-top:0}
.preview .when{color:var(--faint);flex:0 0 12rem;font-family:var(--mono);font-size:12.5px}
.preview .warn{color:var(--warn);font-size:var(--mw-t-body-size);margin-top:0.5rem}
ul.plain{margin:0.5rem 0 0.5rem 1rem;color:var(--muted)}
ul.plain li{margin:0.5rem 0}
ul.plain strong{color:var(--ink)}
/* The log block on the inverse roles: the one deliberately inverted surface,
 * which is what makes it read as a terminal in either scheme. */
pre.log{background:var(--mw-ink);
  border-radius:var(--mw-r-2);padding:0.75rem 1rem;
  font-family:var(--mono);font-size:var(--mw-t-body-sm-size);line-height:var(--mw-t-body-sm-lh);color:var(--mw-bg);
  max-height:22rem;overflow:auto;white-space:pre-wrap;word-break:break-word}

/* ---- QR + short code (pairing) ------------------------------------------ */
/* Deliberately white in both schemes: a QR needs its quiet zone on a light
 * plate, or half the phones in the house refuse to read it. */
.qr{background:#fff;padding:0.75rem;border-radius:var(--mw-r-3);
  display:inline-block;margin:0.5rem 0}
.qr svg{display:block}
/* The e-paper preview stands on the same argument as the QR plate: the
 * physical panel is white paper in either scheme, so its frame is shown on
 * white — the one other place a literal white is the honest colour. */
.ep-paper{max-width:100%;border:1px solid var(--rule);
  image-rendering:pixelated;background:#fff}

/* Copy-paste config blocks (the e-paper recipes): the shared mono on a quiet
 * container — not the log's inverse plate, because this is text to copy into
 * an editor, not terminal output. */
pre.code{background:var(--mw-surface-2);
  border-radius:var(--mw-r-2);padding:12px;
  font-family:var(--mono);font-size:var(--mw-t-body-sm-size);line-height:var(--mw-t-body-sm-lh);color:var(--mw-ink);
  overflow-x:auto;white-space:pre}

/* ---- Shift slot pickers -------------------------------------------------- */
.slots{display:flex;flex-wrap:wrap;gap:.5rem}
.slots span{flex:0 0 6.2rem}
.slots label{margin:0.5rem 0 0.25rem;font-size:var(--mw-t-label-xs-size);color:var(--faint);
  font-weight:600;letter-spacing:.04em}
.slots select{padding:0.5rem 0.25rem;font-size:var(--mw-t-body-size)}
.title-cell{display:flex;align-items:center;font-weight:600;min-width:0;
  overflow-wrap:anywhere}

/* ---- Shift preview / cycle grid ------------------------------------------ */
.pv-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:0.75rem}
.pv-cell{background:var(--panel2);border-radius:5px;padding:8px 4px;text-align:center;
  border-top:3px solid var(--accent)}
.pv-cell.pv-off{border-top-color:var(--ok);
  background:color-mix(in srgb,var(--ok) 8%,var(--panel2))}
.pv-cell.pv-unknown{border-top-color:var(--rule);background:var(--panel2);opacity:.6}
.pv-dow{display:block;font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);color:var(--faint)}
.pv-num{display:block;font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);margin:4px 0}
.pv-code{display:block;font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);color:var(--accent)}
.pv-off .pv-code{color:var(--ok)}
.pv-unknown .pv-code{color:var(--faint)}

/* ---- Wall switcher above the layout editor ------------------------------- */
/* The wall switcher is a row of filter chips: the current wall is the
 * selected chip. Same anatomy as .hep-chip above. */
.walls{display:flex;flex-wrap:wrap;gap:8px;margin:0.5rem 0 1rem}
.walls a{position:relative;height:32px;display:inline-flex;align-items:center;gap:8px;
  padding:0 16px;border-radius:var(--mw-r-2);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  text-decoration:none;color:var(--mw-ink-2);
  background:transparent;border:1px solid var(--mw-ink-3)}
.walls a::after{content:"";position:absolute;left:0;right:0;top:50%;height:48px;
  transform:translateY(-50%)}
.walls a:hover{color:var(--mw-ink);background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent)}
.walls a.active{color:var(--mw-accent-soft-ink);
  background:var(--mw-accent-soft);border-color:transparent}
.walls a.active::before{content:"";width:9px;height:5px;margin-top:-4px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}

/* ---- Layout editor (behaviour lives in the display bundle; this styles it) */
/* position:relative so a popover can never anchor on <body> and float over
 * the settings pane; the row inside is what they actually anchor to. */
.le-toolbar{position:relative;display:flex;flex-direction:column;align-items:stretch;
  gap:12px;margin:0 0 12px}
/* One row (RFC 009 Phase 5): which canvas, add a widget, undo, the layers
 * list, and the canvas's own settings behind one button. It was two rows and
 * four clusters, two of whose items duplicated the page overflow menu a few
 * pixels above — 124px of an 844px phone before the canvas began.
 * position:relative so the Layers and Layout popovers anchor to the row. */
.le-bar-main{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
/* The canvas's shape, on the Layout button. Hidden on a phone (below), where
 * the row has to fit and the popover states it anyway. */
.le-tool-note{color:var(--mw-ink-2)}
.le-orient{flex:0 0 auto}
/* Toolbar tools are compact outlined buttons — the shared anatomy at 32px
 * density, targets stretched back to 48px. */
.le-tool-link,.le-tool-btn,.le-layers-btn{position:relative;margin:0;height:32px;
  padding:0 16px;background:transparent;color:var(--mw-accent);
  border:1px solid var(--mw-ink-3);border-radius:var(--mw-r-2);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  cursor:pointer;text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;line-height:1}
.le-tool-link::after,.le-tool-btn::after,.le-layers-btn::after{content:"";position:absolute;
  left:50%;top:50%;width:max(100%,48px);height:48px;transform:translate(-50%,-50%)}
.le-tool-link:hover,.le-tool-btn:hover,.le-layers-btn:hover{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-hover),transparent)}
.le-layers-btn.is-on{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink);border-color:transparent}
/* Nothing to undo reads as nothing to undo. A disabled control that is
 * pixel-identical to a live one is worse than no control: .saverow shipped
 * exactly that once, and the assertion for it is on the computed colour rather
 * than on the disabled property.
 * (No backticks in this file's CSS — the stylesheet is a template literal.) */
.le-tool-btn:disabled{color:color-mix(in srgb,var(--mw-ink) 38%,transparent);
  border-color:color-mix(in srgb,var(--mw-ink) 12%,transparent);cursor:default}
.le-tool-btn:disabled:hover{background:transparent}
.le-reset-form{margin:0}
/* Each popover hangs off its own button — the anchor is the offsetParent, so
   it opens under the control that opened it rather than at the end of the row,
   and never floats over the settings pane. Right-aligned: both buttons sit at
   the end of the toolbar, where a left-aligned 320px panel would run off. */
.le-pop-anchor{position:relative;display:inline-flex}
/* A menu surface: 4px corner, a bordered panel, and the one heavy shadow —
 * it genuinely floats over the page, so it is allowed to say so. */
.le-layers-pop{position:absolute;top:calc(100% + 6px);right:0;width:320px;z-index:30;
  background:var(--mw-surface);
  border-radius:var(--mw-r-1);
  box-shadow:var(--mw-shadow-1);overflow:hidden}
.le-layers-pop[hidden]{display:none}
.le-layers-head{padding:12px 16px;border-bottom:1px solid var(--ruleSoft)}
.le-layers-title{font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);color:var(--ink)}
.le-layers-sub{font-size:12px;color:var(--faint);margin-top:4px}
.le-layers-empty{padding:16px 16px;font-size:var(--mw-t-label-size);color:var(--faint)}
.le-layer-swatch{flex:0 0 auto;width:12px;height:12px;border-radius:3px}
/* Deliberately under the 48px target rule: the editor toolbar is compact
 * density (32px buttons whose pointer targets stretch via ::after), and a
 * select is a replaced element that cannot carry a pseudo target — stretching
 * the control itself to 48px would break the toolbar's rhythm. The written
 * exception the target audit allows. */
.le-aspect{width:auto;padding:0.5rem 0.5rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
/* Portrait | Landscape: styled with the segmented buttons above. */
/* The palette sits inline in the toolbar (the display bundle builds it there),
   so it is a row of dashed add-chips rather than the mockup's side column. */
.le-palette{display:flex;flex-wrap:wrap;gap:8px}
.le-add{position:relative;display:inline-flex;align-items:center;gap:8px;margin:0;
  height:32px;padding:0 16px;border:1px solid var(--mw-ink-3);
  border-radius:var(--mw-r-2);background:none;
  color:var(--mw-accent);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);cursor:pointer;text-align:left}
.le-add::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,48px);
  height:48px;transform:translate(-50%,-50%)}
.le-add{text-decoration:none}
.le-add:hover{background:color-mix(in srgb,
  var(--mw-accent) var(--mw-wash-hover),transparent)}
.le-add svg{width:18px;height:18px;flex:0 0 auto}
/* The single "+ Add widget" button reads as the primary action, not another
   outlined chip — it opens the add-widget modal below, so it is filled. */
.le-add-primary{border-color:transparent;color:var(--mw-accent-ink);
  background:var(--mw-accent)}
.le-add-primary:hover{background:color-mix(in srgb,
  var(--mw-accent-ink) var(--mw-wash-hover),
  var(--mw-accent))}
/* The add-widget modal: a centred card of first-party widget types, on the
 * shared scrim token rather than its own hard-coded black — the dark scheme
 * needs a heavier scrim than the light one to separate a panel from the page,
 * and one literal cannot be both. */
.le-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;
  justify-content:center;padding:24px;background:var(--mw-scrim)}
.le-modal[hidden]{display:none}
.le-modal-card{width:min(560px,100%);max-height:85vh;overflow:auto;
  background:var(--mw-surface-2);
  border:1px solid var(--mw-line-strong);
  border-radius:var(--mw-r-4);
  box-shadow:var(--mw-shadow-2)}
.le-modal-head{display:flex;align-items:center;justify-content:space-between;
  padding:20px 24px 12px;
  font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking);
  color:var(--mw-ink)}
.le-modal-close{position:relative;margin:0;padding:0;width:40px;height:40px;
  display:grid;place-items:center;background:none;border:0;
  border-radius:var(--mw-r-2);
  color:var(--mw-ink-2);font-size:var(--mw-t-h2-size);line-height:1;cursor:pointer}
.le-modal-close::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.le-modal-close:hover{color:var(--mw-ink);background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent)}
.le-modal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:20px}
@media(max-width:520px){.le-modal-grid{grid-template-columns:repeat(2,1fr)}}
.le-modal-item{display:flex;align-items:center;justify-content:center;text-align:center;
  min-height:64px;padding:12px;background:var(--mw-surface-3);
  color:var(--mw-ink);border:0;
  border-radius:var(--mw-r-3);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);cursor:pointer}
.le-modal-item:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),
  var(--mw-surface-3))}
/* Canvas settings: size, match screen, snap and the canvas background, behind
 * one button. They are real choices, and they are not everyday ones — a row of
 * outlined buttons for each gave a canvas control the same weight as "add a
 * widget", which is the whole complaint the redesign answers. */
.le-canvas-pop{position:absolute;top:calc(100% + 6px);right:0;width:min(340px,92vw);z-index:30;
  padding:16px 16px 16px;background:var(--mw-surface);
  border-radius:var(--mw-r-1);
  box-shadow:var(--mw-shadow-1)}
.le-canvas-pop[hidden]{display:none}
.le-pop-title{
  font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);color:var(--ink);margin-bottom:4px}
.le-pop-sub{font-size:12px;color:var(--mw-ink-2);margin-bottom:12px}
.le-pop-row{display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:44px;font-size:var(--mw-t-label-size);color:var(--mw-ink)}
.le-pop-row>span:first-child{flex:1;min-width:0}
.le-pop-row select{width:auto;max-width:60%}
.le-pop-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:12px;
  border-top:1px solid var(--ruleSoft)}
.le-pop-sep{height:1px;margin:12px 0;background:var(--ruleSoft)}
/* The tools row's own switch, at the row density the popover uses. */
.le-pop-row .switch{flex:1;margin:0;min-height:44px}
/* The state of the canvas, stated once on the preview header rather than
 * repeated under every widget panel. */
.le-canvas-state{font-size:12px;color:var(--mw-ink-2)}
/* No min-height: the canvas is width-driven and must not push into the settings
   pane. The stage sizes to whatever the canvas needs. */
.le-stage{display:flex;justify-content:center;align-items:flex-start;padding:16px;
  background:var(--panel2);border:1px solid var(--rule);border-radius:10px}
.le-canvas{position:relative;background:var(--bg);border-radius:6px;overflow:hidden;
  box-shadow:inset 0 0 0 1px var(--rule);touch-action:none}
/* The snap grid, on the overlay so it sits over the live preview but under the
 * draggable boxes. Shown only while snapping; background-size is set in script to
 * the snap step as a percentage. A placement aid, never on the wall. */
.le-overlay.is-snapping{background-repeat:repeat;
  background-image:linear-gradient(to right,var(--ruleSoft) 1px,transparent 1px),
    linear-gradient(to bottom,var(--ruleSoft) 1px,transparent 1px)}
.le-preview{position:absolute;inset:0;z-index:0;pointer-events:none}
/* What a panel shows instead of the wall's orientation tabs and aspect list:
 * its geometry, stated. Read-only on purpose — 800x480 landscape is a fact
 * about the hardware, not a choice. */
.le-panel-chip{display:inline-flex;align-items:center;height:38px;padding:0 16px;
  border:1px solid var(--mw-line);border-radius:var(--mw-r-2);
  color:var(--mw-ink-2);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  white-space:nowrap}
/* The e-paper designer's backdrop: the panel's own 1-bit frame. Stretched to
 * fill rather than letterboxed, on purpose — the widgets are fractions of the
 * canvas and of the panel alike, so filling makes the drag boxes sit exactly
 * over the shapes they will become. Pixelated: this is 1-bit art, not a photo.
 * (No backticks in this file's CSS — the stylesheet is a template literal.) */
.le-epaper-preview{position:absolute;inset:0;width:100%;height:100%;
  object-fit:fill;image-rendering:pixelated;background:#fff}
.le-preview .preview-wall{overflow:hidden}
.le-overlay{position:absolute;inset:0;z-index:1}
/* An unselected box is neutral, not green. It used to be --ok, which is the
 * hue this admin uses for "healthy" everywhere else — a status dot, the All
 * syncing tag — so a canvas of eight widgets read as eight passing checks.
 * Neutral also keeps the artwork underneath legible, which is the whole job of
 * a live preview: the boxes say where the widgets are, the wall says what they
 * look like. Selection is the only thing that takes a colour. */
.le-widget{position:absolute;background:color-mix(in srgb,var(--mw-ink) 7%,transparent);
  border:1px solid color-mix(in srgb,var(--mw-ink-2) 70%,transparent);border-radius:var(--mw-r-2);
  cursor:move;touch-action:none;overflow:hidden;user-select:none}
.le-widget:hover{background:color-mix(in srgb,var(--mw-ink) 14%,transparent)}
/* Over an e-paper frame the fill would tint the 1-bit art it is meant to show,
 * and the panel already draws each widget's own border underneath — so the box
 * is an outline until you point at it. Selection keeps its accent regardless. */
.le-overlay.is-epaper .le-widget{background:transparent;
  border-color:color-mix(in srgb,var(--mw-ink-2) 80%,transparent)}
.le-overlay.is-epaper .le-widget:hover{background:color-mix(in srgb,var(--mw-ink) 10%,transparent)}
.le-widget.is-selected{border-color:var(--accent);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}
.le-widget-label{position:absolute;top:0;left:0;
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  color:var(--mw-bg);
  background:var(--mw-ink-2);padding:4px 8px;border-radius:0 0 var(--mw-r-2) 0;
  pointer-events:none;user-select:none}
.le-widget.is-selected .le-widget-label{background:var(--accent);color:var(--accentInk)}
/* On a panel the frame underneath already says what each box is — it draws the
 * widget. So the name steps back out of the artwork until you point at it or
 * select it, which is the same argument as the transparent fill above. It is
 * dimmed rather than removed: a widget with nothing to draw yet (an empty note)
 * would otherwise be an unlabelled outline. */
.le-overlay.is-epaper .le-widget-label{opacity:.45}
.le-overlay.is-epaper .le-widget:hover .le-widget-label,
.le-overlay.is-epaper .le-widget.is-selected .le-widget-label{opacity:1}
/* A widget the wall will not draw (RFC 009 Phase 2): the household has nothing
 * set up behind it, so the manifest omits it. The box stays here — it has to be
 * grabbable, and this is the screen where they find out why — but it says so.
 * A dashed edge and a flag rather than a colour: this is not an error, and the
 * status hues are spoken for. */
/* Style only, never colour. The .is-selected rule is the same specificity and
 * declared above, so repainting the border here would quietly take the accent
 * off a flagged widget the moment it was selected — and the rule three up
 * still promises that selection keeps its accent regardless. A dash reads
 * against either colour. */
.le-widget.is-not-drawn{border-style:dashed}
/* Bottom-left, not top-right: the top strip is the widget's own name, and the
 * boxes that are actually flagged on a fresh install are the narrow ones —
 * Classic's shift and weather — where a second chip on that row paints over it.
 * Bottom-right is the resize handle, so the remaining corner is the free one. */
.le-widget-flag{position:absolute;left:0;bottom:0;
  font:var(--mw-t-label-xs);
  letter-spacing:var(--mw-t-label-xs-tracking);
  color:var(--mw-bg);background:var(--mw-ink-2);opacity:.85;
  padding:4px 8px;border-radius:0 var(--mw-r-2) 0 0;
  pointer-events:none;user-select:none}
/* The reason, at the head of the inspector — read before any of its options,
 * because none of them matter while nothing draws the widget. */
.le-not-drawn{margin:0 0 12px;padding:12px 12px;border-radius:var(--mw-r-2);
  background:var(--mw-surface-2);border:1px solid var(--mw-line);
  font:var(--mw-t-body-sm);color:var(--mw-ink-2)}
.le-handle{position:absolute;right:2px;bottom:2px;width:12px;height:12px;background:var(--accent);
  border-radius:3px 0 3px 0;cursor:se-resize;touch-action:none}
/* A 12px corner is a pointer target on a mouse and nothing at all on a
 * phone — in an editor this project redesigned for phones. The mark stays
 * 12px and the *target* grows around it, which moves nothing and paints
 * nothing: the chore tick's idiom, one screen along.
 *
 * It does not reach the full 44px, and the reason is worth stating rather
 * than discovering: .le-widget above is overflow:hidden, which clips
 * hit-testing as well as painting, so the half of this that reaches outside
 * the box is not reachable — about 30x30 inside the corner, up from 12x12.
 * Growing it further inward would reach 44 and swallow a small widget's own
 * drag area whole (a 5% box on a phone canvas is about 20px), and removing
 * the clip would let a long name chip paint over the neighbouring box. The
 * test measures what is actually reachable rather than trusting this line. */
.le-handle::before{content:"";position:absolute;inset:-16px}
/* The canvas background control — none / solid / gradient, per canvas. */
.le-bg{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0 0}
.le-bg-label{
  font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-2)}
.le-bg select{width:auto;padding:0.5rem 0.5rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
.le-bg input[type=color]{width:36px;height:32px;padding:4px;border:1px solid var(--rule);
  border-radius:7px;background:var(--panel2)}
.le-bg input[type=number]{width:5rem;padding:0.5rem 0.5rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
.le-bg .le-media{flex-basis:100%}

/* The image picker — a grid of uploaded pictures plus an upload input. */
.le-media{display:flex;flex-direction:column;gap:12px;margin-top:4px}
.le-media-grid{display:flex;flex-wrap:wrap;gap:8px}
.le-media-item{width:64px;height:64px;padding:0;margin:0;border-radius:var(--mw-r-2);cursor:pointer;
  border:2px solid var(--rule);background-size:cover;background-position:center}
.le-media-item:hover{border-color:var(--faint)}
.le-media-item.is-on{border-color:var(--accent)}
.le-media-upload{display:inline-flex;align-items:center;gap:8px;font-size:var(--mw-t-label-size);color:var(--muted)}
.le-media-upload input{font-size:12px}
.le-media-status{font-family:var(--mono);font-size:12px;color:var(--faint)}

/* The layers list — every widget, front on top; drag a row to restack. It is
   the body of the anchored popover above. */
.le-layers{max-height:340px;overflow:auto;padding:8px}
.le-layer{display:flex;align-items:center;gap:12px;padding:8px 12px;
  border-radius:var(--mw-r-1);
  cursor:pointer;user-select:none}
.le-layer:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.le-layer.is-selected{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
.le-layer-grip{flex:0 0 auto;color:var(--faint);cursor:grab;letter-spacing:-2px;
  font-size:14px;touch-action:none;padding:0 4px}
.le-layer-name{flex:1;min-width:0;
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/*
 * The field ladder: what a widget says, in the order it matters.
 *
 * One list whether a row is on or off, so there is nowhere else to look and no
 * add/remove mode to be in. "is-off" is a row not on the ladder; "is-cut" is a
 * row the box is currently too small to draw, read back out of the real
 * preview rather than predicted — the editor and the wall must not hold two
 * opinions about what fits. (No backticks in here: this stylesheet lives in a
 * template literal, and one would end it.)
 */
.le-ladder{display:flex;flex-direction:column;gap:4px;
  border:1px solid var(--mw-line);
  border-radius:var(--mw-r-2);padding:4px}
.le-ladder-row{display:flex;align-items:center;gap:8px;padding:8px 8px;
  border-radius:var(--mw-r-1);min-height:40px}
.le-ladder-row.is-off{opacity:.55}
.le-ladder-row.is-off .le-ladder-eg{visibility:hidden}
/* Dashed, not hidden: the row is still on the ladder and comes back the moment
   the box grows. Struck through says "not drawn here" without saying "gone". */
.le-ladder-row.is-cut{opacity:.6;
  border:1px dashed var(--mw-ink-3);padding:4px 8px}
.le-ladder-row.is-cut .le-ladder-name{text-decoration:line-through}
.le-ladder-name{flex:0 0 auto;
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking)}
.le-ladder-eg{flex:1;min-width:0;text-align:right;color:var(--faint);
  font-size:var(--mw-t-body-sm-size);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Per-widget options — the body of the contextual inspector, which is itself
 * the card. On the e-paper design page there is no inspector column, so the
 * same panel is built into .le-inspect-card under the stage instead. */
.le-config{margin:0}
.le-config>.kick{margin-bottom:12px}
.le-inspect-card{margin-top:16px;border:1px solid var(--rule);
  border-radius:var(--mw-r-3);background:var(--panel)}
.le-inspect-card .insp-head{background:var(--panel);
  border-radius:var(--mw-r-3) var(--mw-r-3) 0 0}
.le-inspect-card .insp-empty{padding:16px 20px}
/* A segmented control inside the inspector fills the column rather than
 * hugging its labels — the boxes are the target, and the column is narrow.
 *
 * Its labels *wrap*, and that is the fix for a real fault rather than a
 * preference. This rule used to say nowrap plus overflow:hidden plus
 * text-overflow:ellipsis, which reads like a graceful degradation and is not
 * one: a segment is display:inline-flex with justify-content:center, so the
 * label is an anonymous flex item and text-overflow has nothing to act on.
 * The label was simply clipped at *both* ends, centred — "Follow the household"
 * came out as "ollow the househ" in a 111px segment measuring 142px of text.
 * An ellipsis would not have been much better: these labels are the choices
 * themselves, and a choice you cannot read is a choice you cannot make.
 *
 * So: two lines when it needs them, every segment growing together because the
 * row stretches, and overflow-wrap for a single long word that cannot break at
 * a space. overflow:hidden is gone with it — the global rule above avoids it
 * deliberately so a focus ring is not clipped, and this scope had quietly put
 * it back. */
.le-cfg-field .seg{display:flex;width:100%;max-width:100%}
.le-cfg-field .seg button{padding:0 8px;white-space:normal;overflow-wrap:anywhere;
  height:auto;min-height:38px;line-height:1.15;text-align:center;overflow:visible}
.le-config .switch{margin:.5rem 0}
.le-cfg-field{display:block;margin:12px 0 0}
.le-cfg-field>span{display:block;
  font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-2);margin-bottom:8px}
.le-cfg-field select,.le-cfg-field input[type=number]{width:auto;min-width:9rem}
/* Position and size, in per cent of the canvas — the unit that is stored, so
 * what is typed is what is saved. Four across on a column inspector, two by two
 * when the inspector is a phone's sheet. */
.le-box-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.le-box-cell{display:flex;flex-direction:column;gap:4px;margin:0;min-width:0}
.le-box-cell span{font-size:11px;color:var(--mw-ink-2);letter-spacing:.02em}
/* 16px, like every other field here: below that iOS Safari zooms the page on
 * focus, and a settings screen that jumps on every tap is its own bug. */
.le-box-cell input[type=number]{width:100%;min-width:0;box-sizing:border-box;
  height:40px;padding:0 8px;font-size:16px;
  background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:var(--mw-r-1)}
/* A view a widget cannot change: stated, not offered as a dropdown of one. */
.le-cfg-fact{font-size:14px;line-height:1.4;color:var(--mw-ink)}
.le-cfg-field textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px 12px;
  border:1px solid var(--rule);border-radius:var(--mw-r-1);background:var(--panel2);color:var(--ink);
  resize:vertical;line-height:1.4}
.le-cfg-checks{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:4px}
.le-cfg-check{display:inline-flex;align-items:center;gap:0.5rem;font-size:14px;
  color:var(--mw-ink);cursor:pointer;margin:0}

/* ---- Home Assistant entity picker (first-party JS) ----------------------- */
#ha-entity-picker{margin-top:0.5rem}
/* 48px pointer targets: the picker's search box and its "show as" row are
 * script-built bare controls (no .field construction), so the height that the
 * 56px fields get from their anatomy is set here directly. */
.hep-search{width:100%;margin-bottom:12px;min-height:48px}
#ha-entity-picker select{min-height:48px}
.hep-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
/* Filter chips: 32px, 4px corner, outlined at rest; selected fills with
 * secondary-container and gains a drawn leading check. The pointer target is
 * stretched to 48px tall by a pseudo-element. */
.hep-chip{position:relative;margin:0;height:32px;display:inline-flex;align-items:center;
  gap:8px;padding:0 16px;border-radius:var(--mw-r-2);
  border:1px solid var(--mw-ink-3);
  background:transparent;color:var(--mw-ink-2);
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);cursor:pointer}
.hep-chip::after{content:"";position:absolute;left:0;right:0;top:50%;height:48px;
  transform:translateY(-50%)}
.hep-chip:hover{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.hep-chip.active{background:var(--mw-accent-soft);border-color:transparent;
  color:var(--mw-accent-soft-ink)}
.hep-chip.active::before{content:"";width:9px;height:5px;margin-top:-4px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}
.hep-chip.active:hover{background:color-mix(in srgb,
  var(--mw-accent-soft-ink) var(--mw-wash-hover),
  var(--mw-accent-soft))}
.hep-selected{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;min-height:1.4rem}
/* Input chips: outlined, 32px, a trailing remove icon button whose pointer
 * target is 48px even though the visual glyph is 18px. */
.hep-pill{display:inline-flex;align-items:center;gap:0.5rem;height:32px;
  padding:0 8px 0 12px;border-radius:var(--mw-r-2);
  background:transparent;border:1px solid var(--mw-ink-3);
  color:var(--mw-ink);font-size:var(--mw-t-label-size)}
.hep-pill-x{position:relative;margin:0;padding:0;width:18px;height:18px;
  display:grid;place-items:center;border:0;border-radius:var(--mw-r-full);
  background:transparent;color:var(--mw-ink-2);
  cursor:pointer;font-size:14px;line-height:1}
.hep-pill-x::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.hep-pill-x:hover{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.hep-list{border:1px solid var(--rule);border-radius:8px;background:var(--panel2);
  max-height:22rem;overflow-y:auto}
.hep-row{display:flex;align-items:center;gap:12px;padding:0.5rem 0.75rem;cursor:pointer;
  border-top:1px solid var(--ruleSoft);margin:0}
.hep-row:first-child{border-top:0}
.hep-row:hover{background:var(--panel)}
/* The row's checkbox takes the shared checkbox styling above. */
.hep-main{flex:1;min-width:0}
.hep-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hep-id{font-family:var(--mono);font-size:var(--mw-t-label-sm-size);color:var(--faint);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hep-state{font-family:var(--mono);font-size:12.5px;color:var(--muted);flex:0 0 auto;
  max-width:10rem;overflow:hidden;text-overflow:ellipsis;text-align:right}
.hep-footer{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;margin-top:16px}
.hep-field{display:flex;flex-direction:column;gap:8px;margin:0}
.hep-field>span{
  font:var(--mw-t-label-sm);
  letter-spacing:var(--mw-t-label-sm-tracking);
  color:var(--mw-ink-2)}
.hep-field select,.hep-field input{width:auto;min-width:14rem}
.hep-footer .btn-primary{margin-top:0}
.hep-status{font-family:var(--mono);font-size:12.5px;color:var(--faint)}
.hep-status.is-error{color:var(--danger)}

/* ---- Template gallery (RFC 005) — blueprint cards ----------------------- */
.tpl-cat{
  font:var(--mw-t-h4);
  letter-spacing:var(--mw-t-h4-tracking);
  color:var(--mw-ink-2);margin:28px 0 16px}
.tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px}
/* Template cards are ordinary cards: a flat panel with a hairline border. */
.tpl-card{position:relative;display:flex;flex-direction:column;gap:16px;
  background:var(--mw-surface);border:1px solid var(--mw-line);
  border-radius:var(--mw-r-3);padding:var(--mw-s-4)}
.tpl-thumb{position:relative;width:100%;aspect-ratio:3/4;background:var(--panel2);
  overflow:hidden;border-radius:var(--mw-r-2);
  display:flex;align-items:center;justify-content:center}
.tpl-thumb .tpl-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  padding:12px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--faint)}
.tpl-body{padding:0;display:flex;flex-direction:column;gap:8px;flex:1}
.tpl-name{font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking)}
.tpl-blurb{font-size:13.5px;color:var(--muted);line-height:1.45;flex:1;margin:0}
.tpl-card form{margin:0}
.tpl-card .btn-sm{align-self:flex-start;margin-top:4px}
.tpl-copy{margin-top:36px;padding-top:24px;border-top:1px solid var(--rule)}
.tpl-copy .row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}

/* ---- Wall editor: local header, two modes, canvas + inspector -----------
 * The editor used to be one continuous page: status and pairing, the canvas,
 * whichever widget was selected, and every wall-wide setting, all at one
 * visual weight. On a phone that is a scroll with no landmarks — nobody could
 * tell whether they were editing the wall, a widget, or the screen it hangs
 * on. It is three contexts now: Layout, the selected widget's inspector, and
 * Wall settings, and only one of them is on screen at a time. */
/* Room for the sticky save bar, plus the phone's home indicator. */
.disp-editor{padding-bottom:calc(96px + env(safe-area-inset-bottom))}

/* The wall's identity is the app bar's: the crumb links back to Walls and the
 * heading is the wall's name, so the page adds no second header and no second
 * hamburger. What it does add is one row — what you are editing, whether the
 * screen is up, and an overflow for the infrequent and the destructive. */
.wall-status{flex:1 1 210px;margin:0;display:flex;align-items:center;gap:8px;
  font-size:12.5px;color:var(--mw-ink-2);min-width:0}
.wall-status>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wall-status b{color:var(--mw-ink);font-weight:500}

/* The overflow menu. A <details>, so it opens with no script at all; the page
 * chrome only adds Escape, outside-click and focus return on top. */
.ovf{position:relative;flex:0 0 auto}
.ovf-btn{list-style:none;display:grid;place-items:center;width:48px;height:48px;
  border-radius:var(--mw-r-2);cursor:pointer;
  color:var(--mw-ink-2)}
.ovf-btn::-webkit-details-marker{display:none}
.ovf-btn::marker{content:""}
.ovf-btn svg{width:22px;height:22px}
.ovf-btn:hover,.ovf[open] .ovf-btn{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.ovf-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;width:min(280px,88vw);
  padding:8px 0;background:var(--mw-surface);
  border-radius:var(--mw-r-1);
  box-shadow:var(--mw-shadow-1)}
.ovf-menu form{margin:0}
.ovf-item{position:static;display:flex;width:100%;align-items:center;gap:12px;margin:0;
  height:48px;padding:0 16px;background:none;border:0;border-radius:0;
  color:var(--mw-ink);text-decoration:none;text-align:left;
  justify-content:flex-start;
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking);cursor:pointer}
.ovf-item::after{content:none}
.ovf-item:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.ovf-item.is-danger{color:var(--mw-danger)}
.ovf-item.is-danger:hover{background:color-mix(in srgb,
  var(--mw-danger) var(--mw-wash-hover),transparent)}
.ovf-sep{height:1px;margin:8px 0;background:var(--ruleSoft)}

/* Layout | Wall settings. Two contexts, one control, and it is the segmented
 * button the rest of the admin already uses. */
.modebar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:0 0 16px}
.modeswitch{flex:1 1 260px;max-width:440px;display:flex}
.modebar .ovf{margin-left:auto}
.mode[hidden]{display:none}

/* ---- Layout mode ------------------------------------------------------- */
/* Canvas left, the selected widget's inspector right. The inspector is a
 * sheet below 1200px — see the compact block at the foot of this section. */
.lay-panes{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,.9fr);
  gap:24px;align-items:start}
.lay-canvas{min-width:0}
/* Said once, here — it used to be repeated under every widget panel. */
.prev-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  flex-wrap:wrap;margin:0 0 12px}
.prev-head b{font:var(--mw-t-h4);
  letter-spacing:var(--mw-t-h4-tracking);color:var(--ink)}
.prev-head small{font-size:12px;color:var(--mw-ink-2)}
.lay-inspector{position:sticky;top:96px;min-width:0;
  background:var(--panel);border:1px solid var(--rule);
  border-radius:var(--mw-r-3);
  max-height:calc(100vh - 150px);overflow:auto}
.insp-empty{padding:24px 20px;font-size:var(--mw-t-label-size);
  color:var(--mw-ink-2);line-height:1.55}
.insp-empty[hidden],.insp-head[hidden],.insp-body[hidden]{display:none}
/* The inspector's own header: which widget this is, and the way out. */
.insp-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;
  padding:12px 8px 12px 20px;background:var(--panel);
  border-bottom:1px solid var(--ruleSoft)}
.insp-title{flex:1;min-width:0;
  font:var(--mw-t-h3);
  letter-spacing:var(--mw-t-h3-tracking);color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.insp-close{position:relative;flex:0 0 auto;margin:0;width:44px;height:44px;padding:0;
  display:grid;place-items:center;background:none;border:0;
  border-radius:var(--mw-r-2);
  color:var(--mw-ink-2);cursor:pointer}
.insp-close:hover{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.insp-close svg{width:20px;height:20px}
.insp-body{padding:4px 20px 20px}
/* The two lanes: the wall's settings, and what the widget says on ink.
 *
 * Above the tabs rather than beside them, because it does not choose a tab —
 * it chooses which of the widget's two sets of settings the tabs are showing.
 * A pill pair rather than an underline, so it cannot be mistaken for one.
 *
 * Both states are declared because the rule clears its background: see
 * admin-button-states.test.ts, which derives that requirement from this
 * stylesheet rather than from a list somebody remembers to update. */
.insp-lanes[hidden]{display:none}
.insp-lanes{display:flex;gap:8px;margin:8px 0 12px}
.insp-lane{position:relative;margin:0;height:36px;padding:0 16px;background:none;border:0;
  border-radius:18px;color:var(--mw-ink-2);cursor:pointer;
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking)}
.insp-lane::after{content:none}
.insp-lane:hover,.insp-lane:active{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.insp-lane.is-on,.insp-lane.is-on:hover,.insp-lane.is-on:active{
  background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
/* A widget that says something different on ink says so on the chip, so the
 * lane can be read without opening it. */
.insp-lane.has-override::before{content:"";position:absolute;top:8px;right:7px;width:6px;
  height:6px;border-radius:50%;background:var(--mw-accent)}
.insp-ink-head{margin:0 0 8px}
/* The real frame the panel would draw, from the server. A white plate on both
 * schemes, on the same argument as the QR and the e-paper preview: a physically
 * white medium drawn honestly. */
.insp-ink-frame{display:block;width:100%;height:auto;margin:0 0 12px;background:#fff;
  border:1px solid var(--mw-line);border-radius:8px;
  image-rendering:pixelated}
.insp-ink-note{margin:16px 0 4px}
.insp-ink-list{margin:0 0 4px;padding-left:20px;
  color:var(--mw-ink-2);
  font-size:var(--mw-t-body-sm-size);line-height:1.45}
.insp-ink-reset{margin-top:12px;width:100%}
/* Content | Style, inside the inspector. Only drawn when both apply. */
.insp-tabs[hidden]{display:none}
.insp-tabs{display:flex;gap:0;border-bottom:1px solid var(--mw-line);
  margin:0 0 8px}
.insp-tab{position:relative;margin:0;height:44px;padding:0 16px;background:none;border:0;
  border-radius:0;color:var(--mw-ink-2);cursor:pointer;
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking)}
.insp-tab::after{content:none}
.insp-tab:hover{color:var(--mw-ink)}
.insp-tab.is-on{color:var(--mw-accent)}
.insp-tab.is-on::before{content:"";position:absolute;left:8px;right:8px;bottom:0;height:3px;
  border-radius:3px 3px 0 0;background:var(--mw-accent)}
/* Duplicate: the cheapest thing on this panel, so it sits above the rule and
 * not inside the danger row — "Reset layout" beside "Add widget" is the
 * mistake this avoids, one panel along. */
.insp-actions[hidden]{display:none}
.insp-actions{margin-top:16px}
.insp-actions .le-add{width:100%;justify-content:center}
/* Removing the selected widget lives with the widget, not in the toolbar —
 * a disabled "Remove selected" beside the everyday tools said nothing. */
.insp-danger{margin-top:20px;padding-top:16px;border-top:1px solid var(--ruleSoft)}
.insp-remove{margin:0;width:100%;height:44px;background:transparent;
  color:var(--mw-danger);border:1px solid var(--mw-ink-3)}
.insp-remove:hover{background:color-mix(in srgb,
  var(--mw-danger) var(--mw-wash-hover),transparent)}

/* ---- Wall settings mode ------------------------------------------------- */
/* Categories, not one long form. A rail beside the panel on a wide screen; a
 * list that opens one focused screen on a phone. */
.wset{display:grid;grid-template-columns:minmax(230px,290px) minmax(0,1fr);
  gap:28px;align-items:start}
.wset-nav{display:flex;flex-direction:column;gap:4px;position:sticky;top:96px}
.wset-nav[hidden]{display:none}
.wset-navrow{position:relative;display:flex;align-items:center;gap:12px;width:100%;
  min-height:56px;margin:0;padding:8px 16px;background:none;border:0;
  border-radius:var(--mw-r-2);color:var(--ink);cursor:pointer;
  text-align:left;justify-content:flex-start}
.wset-navrow::after{content:none}
.wset-navrow span{flex:1;min-width:0}
.wset-navrow b{display:block;
  font-family:var(--sans);
  font-size:var(--mw-t-label-size);
  font-weight:var(--mw-t-label-weight);
  letter-spacing:var(--mw-t-label-tracking)}
.wset-navrow small{display:block;font-size:12px;line-height:1.4;
  color:var(--mw-ink-2);font-weight:400;letter-spacing:0}
.wset-navrow:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.wset-navrow.is-on{background:var(--mw-accent-soft);
  color:var(--mw-accent-soft-ink)}
.wset-navrow.is-on small{color:var(--mw-accent-soft-ink);opacity:.8}
.wset-navrow .rowchev{display:none;flex:0 0 auto;color:var(--faint)}
.wset-navrow .rowchev svg{width:20px;height:20px}
.wset-panels{min-width:0;max-width:720px}
.wset-panel[hidden]{display:none}
.wset-panel>h3{margin:0 0 4px;
  font:var(--mw-t-h2);
  letter-spacing:var(--mw-t-h2-tracking)}
.wset-panel>form{margin:0}
.wset-back{display:none}
.wset-lead{margin:0 0 16px;font-size:var(--mw-t-label-size);line-height:1.55;color:var(--muted)}
.wset-group{position:relative;margin:24px 0 0}
.wset-group:first-of-type{margin-top:16px}
.wset-group>.kick{margin:0 0 8px}

/* ---- Compact settings rows ---------------------------------------------- */
/* A grouped surface of rows, with dividers rather than a box round each one. */
.rows{display:flex;flex-direction:column;background:var(--panel);
  border:1px solid var(--rule);border-radius:var(--mw-r-3)}
.rows>*+*{border-top:1px solid var(--ruleSoft)}
.rows>.field,.rows>.field-hint{border-top:0}
.rows .switch{margin:0;padding:8px 16px;min-height:56px}
.rows .field{margin:16px 16px}
.rows .field-hint{margin:-4px 16px 12px}
.rows>.rowsub{padding:0 16px 12px}
.rows>.rowsub>.field{margin:8px 0 0}
.rows>.rowsub>.field-hint{margin:4px 0 0}
.rows>.rowsub[hidden]{display:none}
.srow{display:flex;align-items:center;gap:12px;min-height:56px;margin:0;padding:8px 16px;
  cursor:pointer;text-transform:none;letter-spacing:normal}
.srow:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.srow-text{flex:1;min-width:0}
.srow-text b{display:block;font-weight:500;font-size:var(--mw-t-body-size);line-height:1.35;
  color:var(--mw-ink)}
.srow-text small{display:block;font-size:12px;line-height:1.4;
  color:var(--mw-ink-2)}
.srow-value{display:flex;align-items:center;gap:4px;min-width:0;max-width:56%}
/* A native select wearing the row: no box, the value right-aligned beside the
 * chevron. It keeps its name, its options and its platform picker. */
/* 16px, not 14: below 16px iOS Safari zooms the page when a form control takes
 * focus, and a settings screen that jumps on every tap is its own bug. */
.srow-select{width:auto;max-width:100%;margin:0;padding:0;border:0;background:transparent;
  color:var(--mw-ink-2);font-family:inherit;font-size:16px;
  text-align:right;text-align-last:right;text-overflow:ellipsis;cursor:pointer;
  appearance:none;-webkit-appearance:none}
.srow-chev{display:inline-flex;flex:0 0 auto;color:var(--faint)}
.srow-chev svg{width:18px;height:18px}
/* A row that opens something rather than choosing a value (Advanced actions). */
.arow{display:flex;align-items:center;gap:12px;width:100%;min-height:56px;margin:0;
  padding:8px 16px;background:none;border:0;border-radius:0;color:var(--ink);
  text-align:left;justify-content:flex-start;cursor:pointer;text-decoration:none;
  font-family:inherit;font-size:14px;font-weight:500;letter-spacing:normal}
.arow::after{content:none}
.arow:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.arow small{display:block;font-size:12px;line-height:1.4;font-weight:400;
  color:var(--mw-ink-2)}
.arow.is-danger{color:var(--mw-danger)}
.arow.is-danger small{color:var(--mw-danger);opacity:.8}
.arow-text{flex:1;min-width:0}
.rows form{margin:0}
/* A read-only fact (the pairing id), not a control. */
.frow{display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:52px;padding:8px 16px;font-size:14px;color:var(--ink)}
.frow code{font-family:var(--mono);font-size:12.5px;
  color:var(--mw-ink-2)}

/* ---- Tabs (kept for the widget inspector's Content/Style pair) ----------- */
.tabpanel[hidden]{display:none}
.tabpanel>form{margin:0}
.two-up{display:grid;grid-template-columns:1fr 1fr;gap:16px}
/* A single-line hint replaces the old multi-line grey prose. On the
 * on-surface-variant role rather than the faint token: measured, faint came
 * out at 3.87:1 on a card in the light scheme, which is under AA for text. */
.hint-1{font-size:12.5px;color:var(--mw-ink-2);
  margin:.5rem 0 0;line-height:1.5}
/* The "?" help affordance and its popover, in place of a prose paragraph.
 * (It rides a .field-with-help wrapper now — see the field rules.) */
/* A small icon button; the visual stays 20px, the target is 48px. */
.fieldhelp{position:relative;margin:0;padding:0;width:20px;height:20px;
  display:inline-grid;place-items:center;background:transparent;border:0;
  border-radius:var(--mw-r-2);color:var(--mw-ink-2);
  cursor:pointer}
.fieldhelp:hover{background:color-mix(in srgb,
  var(--mw-ink-2) var(--mw-wash-hover),transparent);
  color:var(--mw-ink)}
.fieldhelp::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.fieldhelp svg{width:16px;height:16px}
/* A menu surface, like the layers popover. */
.helppop{position:absolute;top:calc(100% + 6px);left:0;z-index:20;width:min(320px,80vw);
  padding:12px 16px;background:var(--mw-surface);
  border-radius:var(--mw-r-1);
  box-shadow:var(--mw-shadow-1);
  font-size:var(--mw-t-body-sm-size);line-height:1.5;
  color:var(--mw-ink-2);
  text-transform:none;font-weight:400;letter-spacing:0}
.helppop[hidden]{display:none}
.helppop p{margin:0.25rem 0}
.helppop p:first-child{margin-top:0}

/* ---- The one sticky save bar -------------------------------------------- */
/* Layout, the selected widget and the wall settings all save together. Height
 * is a token because the widget sheet has to sit exactly on top of it. */
:root{--savebar-h:64px}
.savebar{position:fixed;left:264px;right:0;bottom:0;z-index:40;display:flex;align-items:center;
  justify-content:flex-end;gap:16px;padding:12px 28px;
  padding-bottom:calc(12px + env(safe-area-inset-bottom));
  background:var(--mw-surface)}
.savebar-flag{margin-right:auto;
  font:var(--mw-t-label);
  letter-spacing:var(--mw-t-label-tracking);
  color:var(--mw-warn)}
.savebar-flag[hidden]{display:none}
.savebar .msg{
  font-size:var(--mw-t-body-size);
  line-height:var(--mw-t-body-lh);
  color:var(--mw-danger)}
.savebar button{margin:0}
.savebar button[hidden]{display:none}
/* Disabled Save still reads as the primary action, quietly: the disabled
 * treatment, never a control that has vanished.
 *
 * Shared with the settings forms' .saverow (RFC 009 Phase 3.2) rather than
 * written twice — and it is not decoration. Without it a disabled Save is
 * pixel-identical to an enabled one, so "Save is off until you change
 * something" becomes a button that silently does nothing when pressed, which
 * is worse than the always-enabled Save it replaced. Found by rendering the
 * System page and looking at it. */
.savebar button:disabled,.saverow button:disabled{background:color-mix(in srgb,
  var(--mw-ink) 12%,transparent);
  color:color-mix(in srgb,var(--mw-ink) 38%,transparent);
  cursor:default}
.savebar button:disabled:hover,.saverow button:disabled:hover{background:color-mix(in srgb,
  var(--mw-ink) 12%,transparent)}

/* ---- Compact: one column, and the inspector becomes a sheet -------------- */
/* The canvas and the inspector need ~830px of content; with the 264px drawer
 * that is a ~1200px viewport, so they stack below it — earlier than the
 * shell's own 900px collapse, which is where the savebar stops clearing the
 * drawer. */
@media(max-width:560px){
  /* The canvas gets the screen (RFC 009 Phase 5). Content used to start 386px
   * down an 844px viewport — half the phone spent on chrome before the thing
   * being edited. Two of those are here and the third is the one-row toolbar
   * above; sizeCanvas spends what they free on the canvas itself.
   *
   * The preview caption is 31px naming the thing directly beneath it, and the
   * shape it repeats is on the Layout button. */
  .prev-head{display:none}
  .le-tool-note{display:none}
  /* Four number fields across a 358px sheet is four unusable fields. */
  .le-box-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  /* A long value takes the line under its label rather than being clipped to
   * the half that says nothing. */
  .srow.is-wide{flex-wrap:wrap;align-items:flex-start;padding-top:12px;padding-bottom:12px}
  .srow.is-wide .srow-value{max-width:100%;width:100%;justify-content:space-between}
  .srow.is-wide .srow-select{flex:1;text-align:left;text-align-last:left}
}
@media(max-width:1199px){
  .lay-panes{grid-template-columns:1fr}
  .wset{grid-template-columns:1fr}
  /* A category list is a column of rows, not a banner: it keeps a readable
   * measure on a tablet rather than running the width of the page. */
  .wset-nav{position:static;gap:0;max-width:620px;background:var(--panel);
    border:1px solid var(--rule);border-radius:var(--mw-r-3)}
  .wset-navrow{border-radius:0}
  .wset-navrow+.wset-navrow{border-top:1px solid var(--ruleSoft)}
  .wset-navrow:first-child{border-radius:var(--mw-r-3)
    var(--mw-r-3) 0 0}
  .wset-navrow:last-child{border-radius:0 0 var(--mw-r-3)
    var(--mw-r-3)}
  .wset-navrow .rowchev{display:inline-flex}
  /* One screen at a time: the list, or the category you opened. */
  .wset:not(.is-drilled) .wset-panels{display:none}
  .wset.is-drilled .wset-nav{display:none}
  .wset-back{display:inline-flex;align-items:center;gap:8px;height:44px;margin:0 0 4px;
    padding:0 12px 0 8px;background:none;border:0;border-radius:var(--mw-r-2);
    color:var(--mw-accent);cursor:pointer;
    font-family:var(--sans);
    font-size:var(--mw-t-label-size);
    font-weight:var(--mw-t-label-weight);
    letter-spacing:var(--mw-t-label-tracking)}
  .wset-back::after{content:none}
  .wset-back svg{width:20px;height:20px}
  .two-up{grid-template-columns:1fr}
  /* Enough page below the canvas for it to be scrolled clear of an open
   * sheet. A short document has nowhere to scroll to, and the canvas stays
   * behind the sheet however small it is made. */
  .mw-insp-open .disp-editor{padding-bottom:calc(70vh + env(safe-area-inset-bottom))}
  /* The widget inspector, as a sheet that sits on the save bar rather than
   * over it — Save stays reachable while a widget is open, and the canvas
   * above stays visible, which is the point of editing it here at all. */
  .lay-inspector{position:fixed;left:0;right:0;top:auto;
    bottom:calc(var(--savebar-h) + env(safe-area-inset-bottom));z-index:45;
    max-height:min(58vh,520px);border:0;
    border-radius:var(--mw-r-4) var(--mw-r-4) 0 0;
    background:var(--mw-surface-2);
    box-shadow:var(--mw-shadow-2);
    transform:translateY(101%);visibility:hidden}
  /* Off-canvas is not enough on its own: a sheet that is only translated away
   * still hands every control in it to the keyboard. */
  .lay-inspector.is-open{transform:none;visibility:visible}
  .insp-head{background:var(--mw-surface-2)}
  .insp-empty{display:none}
}
@media(max-width:900px){
  .savebar{left:0;padding:12px 20px;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
}

/* ---- Pressed and hover states for every control with no container ---------
 *
 * button,.btn is the *filled* variant: primary ground, on-primary label. A
 * control that opts out of that by clearing its background — a tab, a menu
 * row, an icon button — has to opt out of the state layers too, because
 * button:hover and button:active are (0,1,1) and beat any single-class rule.
 * Miss one and it looks right at rest and fills with primary the moment a
 * pointer touches it, drawing its own label in a colour chosen for a different
 * ground: gold on gold. That is what was reported, on the widget inspector's
 * Style tab.
 *
 * :active matters more than it looks. A phone has no hover — a tap is
 * :active — so every one of these was flashing an unreadable gold on every
 * press, on the one device the editor was redesigned for.
 *
 * The layer is the on-surface role at the state opacity, the way every other
 * interaction tint in this file is written. (currentColor would say the rule
 * more directly — the layer is the content colour over the container — but
 * inside color-mix it computes to roughly a tenth of the intended alpha here,
 * which is a state layer nobody can see.) Grouped in one place so the next
 * control that clears its background joins a list rather than re-finding this
 * bug; test/admin-button-states.test.ts fails if one goes missing. */
.ic:hover,.insp-tab:hover,.wset-back:hover{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-hover),transparent)}
.ic:active,.signout:active,.fieldhelp:active,
.insp-tab:active,.insp-close:active,.insp-remove:active,
.wset-navrow:active,.wset-back:active,.ovf-item:active,.arow:active,
.le-add:active,.le-tool-btn:active,.le-layers-btn:active,.le-modal-close:active,
.hep-chip:active,.hep-pill-x:active,
.le-tool-link:active{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-press),transparent)}
/* The one with a ground of its own: its layer goes over that, not over
 * whatever happens to be behind the dialog. */
.le-modal-item:active{background:color-mix(in srgb,
  var(--mw-ink) var(--mw-wash-press),
  var(--mw-surface-3))}

/* ---- Focus: one ring, keyboard-driven ------------------------------------
 * One treatment for every control: a 3px primary ring offset outward, drawn
 * only for keyboard focus (:focus-visible). Text fields are the exception the
 * spec makes — their focus is the outline thickening to 2px primary, and the
 * .field rules above suppress this ring inside one. The theme-picker cards
 * hide their real radio, so the ring goes on the card via :has(). */
:is(button,.btn,.walls a,.le-tool-link,.nav-item,.saved-x,input,select,textarea):focus-visible{
  outline:3px solid var(--mw-accent);outline-offset:2px}
.themecard:has(input:focus-visible){outline:3px solid var(--mw-accent);
  outline-offset:2px}

/* ---- Motion, gated on the reader's preference ----------------------------
 * Every transition and animation in the stylesheet lives inside this one
 * media block, on the md.sys.motion tokens — so prefers-reduced-motion:
 * reduce stills the whole admin at once: no state-layer fades, no switch
 * morph, no pulse ring, no dialog slide, no ripple (the shell's ripple
 * script checks the same preference before drawing anything). The hover and
 * pressed state layers themselves are plain CSS and remain either way.
 *
 * Dialog and menu enter/exit cross display:none with allow-discrete and
 * @starting-style — evergreen-browser CSS; anything older switches
 * instantly, which is exactly what these panels did before motion existed. */
@media (prefers-reduced-motion: no-preference){
  /* State layers ease in and out. */
  button,.btn,.nav-item,.walls a,.le-tool-link,.le-layer,.hep-row{
    transition:background-color var(--mw-dur-2) var(--mw-ease),
      color var(--mw-dur-2) var(--mw-ease),
      border-color var(--mw-dur-2) var(--mw-ease)}
  /* Elevated cards lift. */
  a.card{transition:background-color var(--mw-dur-2) var(--mw-ease),
      box-shadow var(--mw-dur-2) var(--mw-ease)}
  /* The theme toggle's scheme change repaints the big surfaces smoothly;
   * interactive controls already transition background/colour above. */
  body,.side,.topbar,.savebar,.card,pre.log{
    transition:background-color var(--mw-dur-2) var(--mw-ease),
      color var(--mw-dur-2) var(--mw-ease)}
  /* Text fields: the label and the border recolour on focus. The border's
   * width is deliberately NOT transitioned — it steps 1px to 2px with a
   * compensating padding change, and animating the pair makes the text
   * shimmer for the length of the transition. */
  .field-label{transition:color var(--mw-dur-1) var(--mw-ease)}
  .field .field-input{transition:border-color var(--mw-dur-1) var(--mw-ease)}
  /* The switch: track recolours, the thumb slides and grows. */
  .switch input[type=checkbox]{
    transition:background-color var(--mw-dur-2) var(--mw-ease),
      border-color var(--mw-dur-2) var(--mw-ease)}
  .switch input[type=checkbox]::before{
    transition:left var(--mw-dur-2) var(--mw-ease),
      width var(--mw-dur-2) var(--mw-ease),
      height var(--mw-dur-2) var(--mw-ease),
      background-color var(--mw-dur-2) var(--mw-ease)}
  /* Checkboxes fill. */
  .checks input[type=checkbox],.hep-row input[type=checkbox],
  .le-cfg-check input[type=checkbox]{
    transition:background-color var(--mw-dur-1) var(--mw-ease),
      border-color var(--mw-dur-1) var(--mw-ease)}
  /* The active tab's indicator grows in. */
  .insp-tab.is-on::before{animation:mw-tab-in var(--mw-dur-2) var(--mw-ease-out)}
  @keyframes mw-tab-in{from{transform:scaleX(0)}}
  /* The widget sheet slides up from the foot of a phone; the reduced-motion
   * reader gets the same two states with no travel between them.
   *
   * Visibility is switched at the two ends of the slide rather than
   * transitioned across it, and the direction matters: opening makes it
   * visible at once (a transitioned visibility still computes hidden at
   * progress zero, so the sheet's close button could not take focus — the
   * whole point of opening it), while closing waits for the slide to finish
   * before taking it away from the keyboard. */
  .lay-inspector{transition:transform var(--mw-dur-2) var(--mw-ease-out),
      visibility 0s linear var(--mw-dur-2)}
  .lay-inspector.is-open{transition:transform var(--mw-dur-2) var(--mw-ease-out),
      visibility 0s linear 0s}
  /* The dialog: enter decelerates, exit accelerates. */
  .le-modal{transition:opacity var(--mw-dur-2) var(--mw-ease-out),
      display var(--mw-dur-2) allow-discrete}
  .le-modal[hidden]{opacity:0;
    transition:opacity var(--mw-dur-2) var(--mw-ease-in),
      display var(--mw-dur-2) allow-discrete}
  .le-modal-card{transition:transform var(--mw-dur-2) var(--mw-ease-out)}
  .le-modal[hidden] .le-modal-card{transform:translateY(12px) scale(.97)}
  @starting-style{
    .le-modal:not([hidden]){opacity:0}
    .le-modal:not([hidden]) .le-modal-card{transform:translateY(12px) scale(.97)}
  }
  /* Menus: the same shape, smaller and quicker. */
  .le-layers-pop,.helppop{
    transition:opacity var(--mw-dur-2) var(--mw-ease-out),
      transform var(--mw-dur-2) var(--mw-ease-out),
      display var(--mw-dur-2) allow-discrete}
  .le-layers-pop[hidden],.helppop[hidden]{opacity:0;transform:translateY(-4px);
    transition:opacity var(--mw-dur-1) var(--mw-ease-in),
      transform var(--mw-dur-1) var(--mw-ease-in),
      display var(--mw-dur-1) allow-discrete}
  @starting-style{
    .le-layers-pop:not([hidden]),.helppop:not([hidden]){opacity:0;transform:translateY(-4px)}
  }
  /* The online pulse ring. */
  .pulse::after{animation:pl 2.4s ease-out infinite}
  /* The ripple the shell script draws from the press point. The circle is
   * clipped by a host layer that inherits the control's corner, so the 48px
   * pointer-target pseudo outside it is untouched. */
  .ripple-host{position:absolute;inset:0;border-radius:inherit;overflow:hidden;
    pointer-events:none}
  .ripple{position:absolute;border-radius:50%;background:currentColor;
    opacity:0;transform:scale(0);
    animation:mw-ripple var(--mw-dur-2) var(--mw-ease) forwards}
  @keyframes mw-ripple{
    0%{transform:scale(0);opacity:var(--mw-wash-press)}
    60%{opacity:var(--mw-wash-press)}
    100%{transform:scale(1);opacity:0}
  }
  /* The compact drawer slides, and its scrim fades with it — entering
   * decelerates and leaving accelerates, the same pair the dialog above uses.
   *
   * Nested in here rather than written beside the drawer's own media block
   * because the body/.side/.topbar rule further up declares a transition on
   * .side, and a later one would replace it wholesale; that is also why the
   * background and colour pair is repeated here. The theme buttons live in the
   * drawer's foot, so it is on screen exactly when the scheme changes.
   *
   * visibility carries no delay opening and the full duration closing, so the
   * panel is reachable the moment it is asked for and stays drawn while it
   * slides away. */
  @media(max-width:900px){
    .side{transition:transform var(--mw-dur-2) var(--mw-ease-in),
      visibility 0s linear var(--mw-dur-2),
      background-color var(--mw-dur-2) var(--mw-ease),
      color var(--mw-dur-2) var(--mw-ease)}
    .nav-toggle:checked~.side{
      transition:transform var(--mw-dur-2) var(--mw-ease-out),
      visibility 0s,
      background-color var(--mw-dur-2) var(--mw-ease),
      color var(--mw-dur-2) var(--mw-ease)}
    .nav-scrim{transition:opacity var(--mw-dur-2) var(--mw-ease-in),
      visibility 0s linear var(--mw-dur-2)}
    .nav-toggle:checked~.nav-scrim{
      transition:opacity var(--mw-dur-2) var(--mw-ease-out),
      visibility 0s}
  }
}
`;

/**
 * The authenticated shell's stylesheet, served as a cached file rather than
 * inlined.
 *
 * Every server-rendered page used to carry all 110KB of `STYLE` inline, 36%
 * of it developer commentary, in an application that is page-per-navigation
 * by design — about 1.3MB of byte-identical CSS across a twelve-page session.
 * The wizard and sign-in keep the inline `<style>` (`wizard-noscript.test.ts`
 * fences them off, and they must work before anything else does, including a
 * second request succeeding); everything past them links this instead.
 *
 * Comments are stripped from the *served* copy only — `STYLE` itself, which a
 * maintainer reads, is untouched. Computed once at module load: the sheet is
 * a constant for the life of the process, so there is nothing to invalidate
 * beyond a restart, which is exactly when the version in the URL changes too.
 */
export const ADMIN_STYLESHEET = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * One hash, read two ways: the `etag` header value, and — with its quotes
 * and length trimmed — the `?v=` query on the stylesheet link. Computed once
 * via the same `contentEtag` every other served file uses, rather than a
 * second ad-hoc hash for the same job living beside it and free to drift.
 *
 * The query string is what makes a new build fetch a new file instead of the
 * browser's old copy, since the link carries `Cache-Control: immutable` — the
 * ETag alone would only save bytes on the *next* request, after a client had
 * already served a stale one from cache.
 */
export const ADMIN_STYLESHEET_ETAG = contentEtag(Buffer.from(ADMIN_STYLESHEET, 'utf8'));
export const ADMIN_STYLESHEET_VERSION = ADMIN_STYLESHEET_ETAG.replace(/"/g, '').slice(0, 12);

/**
 * The admin theme, applied before the first paint and toggled from the sidebar.
 *
 * Inline and first-party — it must run before the body paints, so there is no
 * flash of the wrong scheme, which a fetched module could never guarantee.
 * `dark`/`light` set the attribute the CSS keys off; `auto` removes it and lets
 * the `prefers-color-scheme` media query decide. The preference is per-browser
 * (localStorage), because a theme is a fact about the screen you are reading on,
 * not about the household. Clicks are delegated, so the buttons work whenever
 * the sidebar renders them.
 */
const THEME_SCRIPT =
  `<script>(function(){try{` +
  `var K='mw-admin-theme',d=document,r=d.documentElement;` +
  `var t=localStorage.getItem(K);` +
  `if(t==='light'||t==='dark')r.setAttribute('data-theme',t);` +
  `function mark(){var c=(t==='light'||t==='dark')?t:'auto';` +
  `var b=d.querySelectorAll('[data-theme-set]');` +
  `for(var i=0;i<b.length;i++)b[i].setAttribute('data-active',String(b[i].getAttribute('data-theme-set')===c));}` +
  `d.addEventListener('click',function(e){` +
  `var el=e.target.closest?e.target.closest('[data-theme-set]'):null;if(!el)return;` +
  `var v=el.getAttribute('data-theme-set');t=v;` +
  `if(v==='auto'){localStorage.removeItem(K);r.removeAttribute('data-theme');}` +
  `else{localStorage.setItem(K,v);r.setAttribute('data-theme',v);}mark();});` +
  `d.addEventListener('DOMContentLoaded',mark);` +
  `}catch(e){}})();</script>`;

/**
 * The press ripple, for the shell pages only.
 *
 * A faithful pressed state expands from the press point, and that needs
 * script. This follows THEME_SCRIPT's precedent — inline, first-party, no
 * fetch — and is progressive enhancement only: the CSS pressed state layer
 * stands on its own, so with the script absent (the wizard and sign-in never
 * include it; test/wizard-noscript.test.ts pins that) every control still
 * shows its press. It checks prefers-reduced-motion at press time, because
 * the CSS that animates .ripple is gated on the same preference and a span
 * that never animates would sit invisible but appended. The clip layer
 * inherits the control's corner so the 48px pointer-target pseudo outside it
 * keeps working; the timeout removal is the belt to animationend's braces.
 */
const RIPPLE_SCRIPT =
  `<script>(function(){try{` +
  `document.addEventListener('pointerdown',function(e){` +
  `var t=e.target&&e.target.closest?e.target.closest('button,.btn,.nav-item,.walls a,.le-tool-link'):null;` +
  `if(!t||t.disabled)return;` +
  `if(!window.matchMedia||matchMedia('(prefers-reduced-motion: reduce)').matches)return;` +
  `if(getComputedStyle(t).position==='static')t.style.position='relative';` +
  `var h=t.querySelector(':scope>.ripple-host');` +
  `if(!h){h=document.createElement('span');h.className='ripple-host';t.appendChild(h);}` +
  `var r=t.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;` +
  `var dx=Math.max(x,r.width-x),dy=Math.max(y,r.height-y);` +
  `var d=2*Math.sqrt(dx*dx+dy*dy);` +
  `var p=document.createElement('span');p.className='ripple';` +
  `p.style.width=p.style.height=d+'px';` +
  `p.style.left=(x-d/2)+'px';p.style.top=(y-d/2)+'px';` +
  `h.appendChild(p);` +
  `p.addEventListener('animationend',function(){p.remove();});` +
  `setTimeout(function(){p.remove();},800);` +
  `},{passive:true});` +
  `}catch(e){}})();</script>`;

/**
 * The brand mark, inline and first-party.
 *
 * A month, quiet, with one cell lit — the whole product in one shape, drawn on
 * the wall's own grid. Inlined rather than fetched: rule three keeps the served
 * HTML free of a third-party origin, and a data-URI favicon and one `<svg>`
 * need no network at all.
 *
 * This is deliberately the **five-column redraw**, not the seven-column mark in
 * `docs/brand/marks/lit-cell.svg`. Everywhere this constant lands is small — a
 * 34px sidebar brand, a 32px footer, a 16px favicon — and below about 20px a
 * seven-column field stops being a grid and becomes grey texture with a dot in
 * it. The 512 tile on the add-on keeps the full seven columns because it is
 * looked at large. Same idea, two drawings, chosen by size.
 *
 * The dim cells are pre-mixed against the Board background rather than carrying
 * an opacity, for the same reason `theme.ts` pre-mixes its tints: flat fills
 * stay crisp when a browser rasterises this into a 16px favicon.
 */
const MARK =
  `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  `<rect width="512" height="512" rx="108" fill="#0B0E11"/>` +
  `<rect x="73" y="111" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="149" y="111" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="225" y="111" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="301" y="111" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="377" y="111" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="73" y="187" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="149" y="187" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="301" y="187" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="377" y="187" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="73" y="263" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="149" y="263" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="225" y="263" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="301" y="263" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="377" y="263" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="73" y="339" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="149" y="339" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="225" y="339" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="301" y="339" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="377" y="339" width="62" height="62" rx="12" fill="#363D45"/>` +
  `<rect x="225" y="187" width="62" height="62" rx="12" fill="#E8A33D"/>` +
  `</svg>`;

/** The mark as a favicon. Same bytes, URL-encoded into a data URI. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(MARK)}`;

/**
 * The handful of icons the admin uses: Material Symbols, inlined and
 * first-party.
 *
 * Rule three keeps the served HTML free of a third-party origin, so there is
 * no icon font and nothing is fetched from fonts.google.com — the paths are
 * copied in from the google/material-design-icons repository (Material
 * Symbols Outlined, 24dp grid, default weight; Apache-2.0, recorded beside
 * the font attributions and in NOTICE). Each entry is the glyph's outline
 * path on the family's 960-unit grid, named after its Symbols source so it
 * can be re-sourced; `icon()` wraps it. These are filled outline paths, not
 * strokes — the sizing rules in STYLE set only width and height.
 */
const ICON_PATHS: Readonly<Record<string, string>> = {
  /* dashboard */
  overview: '<path d="M520-600v-240h320v240H520ZM120-440v-400h320v400H120Zm400 320v-400h320v400H520Zm-400 0v-240h320v240H120Zm80-400h160v-240H200v240Zm400 320h160v-240H600v240Zm0-480h160v-80H600v80ZM200-200h160v-80H200v80Zm160-320Zm240-160Zm0 240ZM360-280Z"/>',
  /* calendar_month */
  calendars: '<path d="M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Zm280 240q-17 0-28.5-11.5T440-440q0-17 11.5-28.5T480-480q17 0 28.5 11.5T520-440q0 17-11.5 28.5T480-400Zm-160 0q-17 0-28.5-11.5T280-440q0-17 11.5-28.5T320-480q17 0 28.5 11.5T360-440q0 17-11.5 28.5T320-400Zm320 0q-17 0-28.5-11.5T600-440q0-17 11.5-28.5T640-480q17 0 28.5 11.5T680-440q0 17-11.5 28.5T640-400ZM480-240q-17 0-28.5-11.5T440-280q0-17 11.5-28.5T480-320q17 0 28.5 11.5T520-280q0 17-11.5 28.5T480-240Zm-160 0q-17 0-28.5-11.5T280-280q0-17 11.5-28.5T320-320q17 0 28.5 11.5T360-280q0 17-11.5 28.5T320-240Zm320 0q-17 0-28.5-11.5T600-280q0-17 11.5-28.5T640-320q17 0 28.5 11.5T680-280q0 17-11.5 28.5T640-240Z"/>',
  /* autorenew */
  shifts: '<path d="M204-318q-22-38-33-78t-11-82q0-134 93-228t227-94h7l-64-64 56-56 160 160-160 160-56-56 64-64h-7q-100 0-170 70.5T240-478q0 26 6 51t18 49l-60 60ZM481-40 321-200l160-160 56 56-64 64h7q100 0 170-70.5T720-482q0-26-6-51t-18-49l60-60q22 38 33 78t11 82q0 134-93 228t-227 94h-7l64 64-56 56Z"/>',
  /* checklist — drawn rather than lifted, because it has to sit at 24px
     beside Material Symbols outlines and read as one of them. One item
     ticked, two still to do; the tick is two thick strokes as filled
     quads, everything else axis-aligned. Sized by looking at it at 24px,
     which is the only size that settles it. */
  chores: '<path d="M138 -684 208 -614 172 -578 102 -648ZM212 -582 312 -746 268 -774 168 -610ZM380 -680h480v60H380ZM120 -502h120v44H120ZM380 -510h480v60H380ZM120 -332h120v44H120ZM380 -340h480v60H380Z"/>',
  /* cloud */
  alerts: '<path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm0-80h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41Zm220-240Z"/>',
  /* home */
  homeassistant: '<path d="M240-200h120v-240h240v240h120v-360L480-740 240-560v360Zm-80 80v-480l320-240 320 240v480H520v-240h-80v240H160Zm320-350Z"/>',
  /* tv */
  screens: '<path d="M320-120v-80H160q-33 0-56.5-23.5T80-280v-480q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v480q0 33-23.5 56.5T800-200H640v80H320ZM160-280h640v-480H160v480Zm0 0v-480 480Z"/>',
  /* space_dashboard */
  layout: '<path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h240v-560H200v560Zm320 0h240v-280H520v280Zm0-360h240v-200H520v200Z"/>',
  /* group */
  people: '<path d="M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM360-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm400-160q0 66-47 113t-113 47q-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113ZM120-240h480v-32q0-11-5.5-20T580-306q-54-27-109-40.5T360-360q-56 0-111 13.5T140-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T440-640q0-33-23.5-56.5T360-720q-33 0-56.5 23.5T280-640q0 33 23.5 56.5T360-560Zm0 320Zm0-400Z"/>',
  /* dns */
  system: '<path d="M300-720q-25 0-42.5 17.5T240-660q0 25 17.5 42.5T300-600q25 0 42.5-17.5T360-660q0-25-17.5-42.5T300-720Zm0 400q-25 0-42.5 17.5T240-260q0 25 17.5 42.5T300-200q25 0 42.5-17.5T360-260q0-25-17.5-42.5T300-320ZM160-840h640q17 0 28.5 11.5T840-800v280q0 17-11.5 28.5T800-480H160q-17 0-28.5-11.5T120-520v-280q0-17 11.5-28.5T160-840Zm40 80v200h560v-200H200Zm-40 320h640q17 0 28.5 11.5T840-400v280q0 17-11.5 28.5T800-80H160q-17 0-28.5-11.5T120-120v-280q0-17 11.5-28.5T160-440Zm40 80v200h560v-200H200Zm0-400v200-200Zm0 400v200-200Z"/>',
  /* palette */
  palette: '<path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-220 40q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120-160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm200 0q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120 160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17ZM480-160q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5T480-160Z"/>',
  /* arrow_forward */
  arrow: '<path d="M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z"/>',
  /* logout */
  logout: '<path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"/>',
  /* storefront */
  addons: '<path d="M841-518v318q0 33-23.5 56.5T761-120H201q-33 0-56.5-23.5T121-200v-318q-23-21-35.5-54t-.5-72l42-136q8-26 28.5-43t47.5-17h556q27 0 47 16.5t29 43.5l42 136q12 39-.5 71T841-518Zm-272-42q27 0 41-18.5t11-41.5l-22-140h-78v148q0 21 14 36.5t34 15.5Zm-180 0q23 0 37.5-15.5T441-612v-148h-78l-22 140q-4 24 10.5 42t37.5 18Zm-178 0q18 0 31.5-13t16.5-33l22-154h-78l-40 134q-6 20 6.5 43t41.5 23Zm540 0q29 0 42-23t6-43l-42-134h-76l22 154q3 20 16.5 33t31.5 13ZM201-200h560v-282q-5 2-6.5 2H751q-27 0-47.5-9T663-518q-18 18-41 28t-49 10q-27 0-50.5-10T481-518q-17 18-39.5 28T393-480q-29 0-52.5-10T299-518q-21 21-41.5 29.5T211-480h-4.5q-2.5 0-5.5-2v282Zm560 0H201h560Z"/>',
  /* widgets */
  module: '<path d="M666-440 440-666l226-226 226 226-226 226Zm-546-80v-320h320v320H120Zm400 400v-320h320v320H520Zm-400 0v-320h320v320H120Zm80-480h160v-160H200v160Zm467 48 113-113-113-113-113 113 113 113Zm-67 352h160v-160H600v160Zm-400 0h160v-160H200v160Zm160-400Zm194-65ZM360-360Zm240 0Z"/>',
  /* menu */
  menu: '<path d="M120-240v-80h720v80H120Zm0-200v-80h720v80H120Zm0-200v-80h720v80H120Z"/>',
  /* arrow_back — the mirror of `arrow`, for a back affordance that reads as one. */
  back: '<path d="M313-440l224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z"/>',
  /* more_vert */
  more: '<path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z"/>',
  /* close */
  close: '<path d="M256-200l-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>',
  /* chevron_right — the trailing glyph on a settings row that opens a choice. */
  chev: '<path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z"/>',
  /* help */
  help: '<path d="M478-240q21 0 35.5-14.5T528-290q0-21-14.5-35.5T478-340q-21 0-35.5 14.5T428-290q0 21 14.5 35.5T478-240Zm-36-154h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>',
};

/**
 * Markers around the sidebar's sign-out control.
 *
 * The footer always renders sign-out — the common install is a plain
 * `docker run`, where it is the only way out. Under Home Assistant ingress it
 * must not appear at all: the supervisor authenticated the household, so ending
 * our cookie is a control that looks like it failed, and the ingress middleware
 * strips this block on the way out. That is the same seam the `<base>` rewrite
 * uses, so `page()` and its dozen callers stay unaware ingress exists.
 */
export const SIGNOUT_OPEN = '<!--mw:signout-->';
export const SIGNOUT_CLOSE = '<!--/mw:signout-->';

/** An inline icon by key, at a size the caller controls with CSS. */
export function icon(key: string): string {
  const inner = ICON_PATHS[key];
  if (inner === undefined) return '';
  return `<svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">${inner}</svg>`;
}

/**
 * The admin, in three groups rather than nine flat pages.
 *
 * **Modules** is everything a wall shows — the calendar first, because the
 * calendar is the product, then the rest as equals whether they are core or an
 * integration. **Walls** is the screens themselves and what each one draws.
 * **Settings** is the shared defaults a wall inherits, the people its calendars
 * belong to, and the box's own housekeeping.
 *
 * A group's tab goes to its first page. `href` is relative, so the single
 * `<base>` carries every link through ingress.
 */
interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** Key into ICON_PATHS. */
  readonly icon: string;
}

/**
 * An installed external module, as the sidebar needs it.
 *
 * Read live from the database (`readExternalModules`) rather than baked into
 * `GROUPS`, so installing one from the Store makes it appear here at once and
 * removing it takes the entry away — one source of truth. The row stores no
 * icon, so every entry uses the generic `module` glyph; `enabled` decides
 * whether it carries an "off" badge. The db read lives in `admin.ts`
 * (`navModules`) because this file never touches the database.
 */
export interface NavModule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

const GROUPS: readonly { readonly key: string; readonly label: string; readonly items: readonly NavItem[] }[] = [
  {
    key: 'calendar',
    label: 'Calendar',
    items: [
      // Overview used to sit above every group, in none of them; it is the
      // first thing a household about their calendar wants, so it is the
      // first item of the first group rather than a special case in navBar.
      { key: 'home', label: 'Overview', href: 'admin', icon: 'overview' },
      { key: 'calendars', label: 'Calendars', href: 'admin/calendars', icon: 'calendars' },
      { key: 'people', label: 'People', href: 'admin/people', icon: 'people' },
      { key: 'shifts', label: 'Work Schedule', href: 'admin/shifts', icon: 'shifts' },
      // Defining a chore is admin work; ticking one off is the wall's, and
      // deliberately not here (RFC 008).
      { key: 'chores', label: 'Chores', href: 'admin/chores', icon: 'chores' },
    ],
  },
  {
    key: 'walls',
    label: 'Walls',
    items: [
      // One list, one nav item, for every screen kind — browser and e-paper
      // alike carry a kind chip on their row rather than a nav entry each
      // (RFC 009 Phase 4). `/admin/walls` is canonical; the old `/admin/displays`
      // and `/admin/epaper` routes redirect into it.
      { key: 'walls', label: 'Walls', href: 'admin/walls', icon: 'screens' },
      { key: 'themes', label: 'Themes', href: 'admin/themes', icon: 'palette' },
    ],
  },
  {
    key: 'extras',
    label: 'Extras',
    items: [
      { key: 'alerts', label: 'Weather', href: 'admin/alerts', icon: 'alerts' },
      { key: 'homeassistant', label: 'Home Assistant', href: 'admin/home-assistant', icon: 'homeassistant' },
      { key: 'modules', label: 'Store', href: 'admin/modules', icon: 'addons' },
    ],
  },
  {
    key: 'system',
    label: 'System',
    items: [{ key: 'system', label: 'System', href: 'admin/system', icon: 'system' }],
  },
];

/** The group title shown as the topbar kicker for a given active page. */
function groupLabelFor(active: string): string {
  const group = GROUPS.find((g) => g.items.some((i) => i.key === active));
  return group?.label ?? 'Overview';
}

/**
 * The sidebar nav, driven by `GROUPS` and the active key.
 *
 * An Overview item on top, then each group under its uppercase label. Every item
 * is a plain `<a>` — one route per screen, marked active server-side — with a
 * line icon and its label. `href` is relative so the single `<base>` carries it
 * through Home Assistant ingress.
 */
function navBar(active: string, modules: readonly NavModule[]): string {
  const item = (i: NavItem): string =>
    `<a class="nav-item${i.key === active ? ' active' : ''}" href="${i.href}"` +
    `${i.key === active ? ' aria-current="page"' : ''}>${icon(i.icon)}` +
    `<span class="nav-name">${escapeHtml(i.label)}</span></a>`;

  // An installed module's entry links to its card in the Store, never active
  // itself — the Store item carries the active state for the whole group.
  const moduleItem = (m: NavModule): string =>
    `<a class="nav-item" href="admin/modules#mod-${encodeURIComponent(m.id)}" title="${escapeHtml(m.name)}">` +
    `${icon('module')}<span class="nav-name">${escapeHtml(m.name)}</span>` +
    (m.enabled ? '' : `<span class="nav-badge">Off</span>`) +
    `</a>`;

  const groups = GROUPS.map((g) => {
    let body: string;
    const store = g.items[g.items.length - 1];
    // Installed modules attach to whichever group holds the Store item, found
    // by item key rather than group key — the Store moved into Extras and a
    // group-key check would silently stop finding it.
    if (modules.length > 0 && store !== undefined && store.key === 'modules') {
      // Built-ins, then one entry per installed module, then the Store — which
      // is the last item in the group by construction.
      const builtins = g.items.slice(0, -1).map(item).join('');
      body = builtins + modules.map(moduleItem).join('') + item(store);
    } else {
      body = g.items.map(item).join('');
    }
    return `<div class="nav-group"><span>${escapeHtml(g.label)}</span>${body}</div>`;
  }).join('');

  return `<nav class="nav" aria-label="Admin">${groups}</nav>`;
}

export interface PageOptions {
  readonly title: string;
  /** Rendered above the heading in the wizard, e.g. "Step 2 of 4". */
  readonly step?: string;
  readonly heading: string;
  readonly intro?: string;
  /**
   * The current admin section, e.g. `screens` — draws the sidebar with it
   * marked, inside the app shell. Absent on the wizard and sign-in, which have
   * no sidebar; those render a centred column instead. `home` is the overview.
   */
  readonly nav?: string;
  /**
   * A primary action for the top-right of the shell's topbar, where a page has
   * one — e.g. "Add a calendar" linking to the add form. Already-escaped label;
   * relative href.
   */
  readonly action?: { readonly label: string; readonly href: string };
  /**
   * Where this page sits inside its section, e.g. one wall inside Walls. Turns
   * the app bar's crumb into a real back link, so a page nested one level down
   * needs no back affordance of its own — and, in particular, no second
   * hamburger to stand for the list it came from.
   */
  readonly back?: { readonly label: string; readonly href: string };
  /**
   * The installed modules to list in the sidebar's Modules group. Read live per
   * request (see `navModules` in `admin.ts`) and passed in, because this file
   * never touches the database. Absent on the wizard/sign-in, which have no
   * sidebar; empty is fine and just draws the built-in modules and the Store.
   */
  readonly modules?: readonly NavModule[];
  /**
   * The confirmation strip, from `readSaved(c)` — what a redirect just said it
   * saved (RFC 009 Phase 3.1). Absent is the ordinary case and draws nothing.
   *
   * `| undefined` explicitly, under `exactOptionalPropertyTypes`: adopting the
   * strip is meant to be `saved: readSaved(c)` at a page's own `page({…})`
   * call, and `readSaved` answers `undefined` most of the time. Without this
   * every one of those call sites would need a conditional spread — which is a
   * lot of ceremony to make a screen say "Saved."
   */
  readonly saved?: Saved | undefined;
  /** Already-escaped markup. */
  readonly body: string;
}

/**
 * Does this page hold a form the dirty-state script should wire?
 *
 * A `<form>` tag carrying `data-dirty` — and specifically not a plain
 * `includes('data-dirty')`, which the wall editor's `data-dirty-flag` span
 * satisfies too. That match would fetch and run `settings-form.js` on the
 * editor pages, where `form[data-dirty]` selects nothing: a module downloaded
 * and executed for no reason, on the two heaviest pages in the admin. The
 * lookahead is what keeps `data-dirty-flag` out — a hyphen is neither a space,
 * an `=`, nor a `>`.
 */
const WANTS_DIRTY_SCRIPT = /<form\b[^>]*\bdata-dirty(?=[\s=>])/;

/**
 * The strip itself: one sentence and a way to be rid of it.
 *
 * The sentence is a literal from `SAVED_MESSAGES`, never anything the request
 * carried, so there is nothing here that could be made to say something else.
 * Dismissing is a link back to the same page without the parameter — no
 * script, and it stops a refresh re-announcing a save from ten minutes ago.
 *
 * `role="status"` (with the RFC's explicit `aria-live="polite"` beside it) is
 * honest about what it buys and what it does not. A live region is announced
 * when something is inserted *into* it; on a full page load a screen reader
 * reaches this as ordinary content at the top of the main column, which is
 * where somebody looking for the outcome would land anyway. The role is what
 * makes it a status rather than a paragraph, and it is what a page that later
 * updates the strip from script would need to already be there.
 */
function savedStrip(saved: Saved): string {
  return (
    `<div class="saved" role="status" aria-live="polite">` +
    `<span class="saved-text">${escapeHtml(SAVED_MESSAGES[saved.key])}</span>` +
    `<a class="saved-x" href="${escapeHtml(saved.dismissHref)}" aria-label="Dismiss">` +
    `${icon('close')}</a>` +
    `</div>`
  );
}

/**
 * The wizard's four-step progress bar, derived from a "Step N of 4" string.
 *
 * The wizard is always Account → Timezone → Calendar → Where & who, so the
 * labels are fixed; a total other than four just draws unlabelled bars rather
 * than guessing.
 */
function stepProgress(step: string): string {
  const match = /Step\s+(\d+)\s+of\s+(\d+)/i.exec(step);
  if (match === null) return `<p class="kick" style="margin-bottom:22px">${escapeHtml(step)}</p>`;
  const current = Number(match[1]);
  const total = Number(match[2]);
  const labels = total === 4 ? ['Account', 'Timezone', 'Calendar', 'Where & who'] : [];
  let out = '<ol class="steps">';
  for (let n = 1; n <= total; n++) {
    const state = n < current ? ' done' : n === current ? ' on' : '';
    const label = labels[n - 1];
    out +=
      `<li class="step${state}"><div class="bar"></div>` +
      (label === undefined ? '' : `<span>${n} · ${escapeHtml(label)}</span>`) +
      `</li>`;
  }
  return out + '</ol>';
}

function head(title: string, shell = false): string {
  const styleTag = shell
    ? `<link rel="stylesheet" href="assets/admin.css?v=${ADMIN_STYLESHEET_VERSION}">`
    : `<style>${STYLE}</style>`;
  return (
    `<!doctype html><html lang="en"><head>` +
    /*
     * The base, and it is load-bearing.
     *
     * Every link and form action on these pages is relative, so that one tag
     * decides where the application's root is. `/` here; under Home Assistant
     * ingress the middleware replaces it with the per-session prefix, which is
     * what lets the same markup work in both places without a prefix threaded
     * through forty call sites.
     *
     * It sits before anything that could resolve a URL, because a `<base>`
     * only governs what follows it.
     */
    `<base href="/">` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link rel="icon" href="${FAVICON}">` +
    // The ripple only ever ships to the shell: the wizard and sign-in are
    // deliberately script-free beyond the theme script, and a census test
    // holds them to it.
    `<title>${escapeHtml(title)}</title>${styleTag}` +
    `${THEME_SCRIPT}${shell ? RIPPLE_SCRIPT : ''}</head>`
  );
}

export function page(options: PageOptions): string {
  // Wizard / sign-in: no sidebar, a centred column.
  if (options.nav === undefined) {
    return (
      head(options.title) +
      `<body class="wiz"><div class="wizbox">` +
      `<a class="brand" href="admin">${MARK}<b>Maverick Wall</b></a>` +
      (options.step === undefined ? '' : stepProgress(options.step)) +
      `<div class="card">` +
      `<h1>${escapeHtml(options.heading)}</h1>` +
      (options.intro === undefined ? '' : `<p>${escapeHtml(options.intro)}</p>`) +
      options.body +
      `</div></div></body></html>`
    );
  }

  // The app shell: a fixed sidebar and a scrolling main column.
  const action =
    options.action === undefined
      ? ''
      : `<a class="btn btn-sm" href="${options.action.href}">${escapeHtml(options.action.label)}</a>`;

  return (
    head(options.title, true) +
    `<body class="shell">` +
    /*
     * The compact-width drawer's whole mechanism, and it is a checkbox.
     *
     * It holds the open state where CSS can read it, so the modal drawer needs
     * no script — which matters here for the same reason the wizard has none:
     * a household that cannot reach the navigation cannot reach anything else
     * either. It is first in the body because the drawer and its scrim are
     * selected as its siblings, and `page()` is the only place that order is
     * decided. Its accessible name is on the input, since the labels that
     * operate it carry only an icon and a scrim between them.
     *
     * Below 900px it is a focusable, invisible 48px at the top-left corner,
     * under the app-bar button that labels it; at this width the stylesheet
     * takes it out entirely, so it is not a phantom first tab stop on a
     * desktop where the drawer is always open.
     */
    `<input type="checkbox" id="mw-nav" class="nav-toggle" aria-label="Navigation menu">` +
    `<aside class="side">` +
    `<a class="brand" href="admin">${MARK}<span><b>Maverick Wall</b><small>Admin</small></span></a>` +
    navBar(options.nav, options.modules ?? []) +
    `<div class="side-foot">` +
    `<div class="side-foot-id"><div class="fmark">${MARK}</div>` +
    `<div class="who"><b>Signed in</b><small>Maverick Wall</small></div>` +
    // Stripped under ingress by the ingress middleware; the only way out on a
    // plain docker install, so it is the default rather than an add-on.
    SIGNOUT_OPEN +
    `<form method="post" action="admin/sign-out">` +
    `<button class="signout" type="submit" aria-label="Sign out" title="Sign out">${icon('logout')}</button>` +
    `</form>` +
    SIGNOUT_CLOSE +
    `</div>` +
    // The admin theme toggle. Wired by the head script; no server state.
    `<div class="themebar" role="group" aria-label="Admin theme">` +
    `<button type="button" class="themebtn" data-theme-set="auto">Auto</button>` +
    `<button type="button" class="themebtn" data-theme-set="light">Light</button>` +
    `<button type="button" class="themebtn" data-theme-set="dark">Dark</button>` +
    `</div>` +
    `</div>` +
    `</aside>` +
    // Tapping the page beside an open drawer closes it: a second label for the
    // same checkbox, drawn as the scrim. Hidden from assistive technology —
    // it is a surface to dismiss with, and the control is already named.
    `<label class="nav-scrim" for="mw-nav" aria-hidden="true"></label>` +
    `<main class="main">` +
    `<header class="topbar">` +
    // The app bar's leading icon, and the only way to the navigation below
    // 900px. It sits in the sticky bar rather than at the top of the document
    // so it is one tap away at any scroll depth; at this width it is not drawn.
    `<label class="navbtn" for="mw-nav" title="Navigation menu">${icon('menu')}</label>` +
    `<div class="topbar-title">` +
    // The crumb is a link when the page is inside something — one back
    // affordance, in the app bar, rather than a second one in the page (and
    // never a second hamburger, which is what a wall list button would read
    // as beside the navigation drawer's).
    (options.back === undefined
      ? `<div class="crumb">${escapeHtml(groupLabelFor(options.nav))}</div>`
      : `<a class="crumb crumb-back" href="${options.back.href}">${icon('back')}` +
        `${escapeHtml(options.back.label)}</a>`) +
    `<h1>${escapeHtml(options.heading)}</h1>` +
    `</div>${action}</header>` +
    // The intro leads the content now, not the sticky bar — one lead line kept
    // out of the permanent header so the bar stays compact.
    `<div class="content">` +
    /*
     * The confirmation, above the lead line and above everything it is about.
     *
     * Only in the shell. The wizard's steps advance rather than save — every
     * one of its redirects goes to the *next* screen, where "Saved." would be
     * noise beside the heading that already says what happened — and the
     * wizard is the one page that must stay as plain as it can be.
     */
    (options.saved === undefined ? '' : savedStrip(options.saved)) +
    (options.intro === undefined ? '' : `<p class="note">${escapeHtml(options.intro)}</p>`) +
    options.body +
    `</div>` +
    /*
     * The dirty-state script, shipped by the page that needs it rather than by
     * the page that remembers to ask (RFC 009 Phase 3.2).
     *
     * Marking a form `data-dirty` is the whole of adopting it. The alternative
     * — every screen emitting its own `<script src>` beside its own markup —
     * is exactly how the e-paper editor silently lost its editor once: the
     * mount stayed and the tag moved. A page with no such form ships nothing,
     * and the wizard branch above never reaches this line at all, which is
     * what keeps the no-script fence where `wizard-noscript.test.ts` put it.
     */
    (WANTS_DIRTY_SCRIPT.test(options.body)
      ? `<script type="module" src="assets/settings-form.js"></script>`
      : '') +
    `</main></body></html>`
  );
}

/**
 * The one convention for destroying things (RFC 009, 3.3).
 *
 * A GET page that names exactly what is lost, a `btn-danger` form that does
 * the actual destroying, an optional non-destructive alternative beside it
 * (Pause, for a chore; nothing, for a rotation with no such thing), and a
 * plain "Keep it" cancel. Every destructive control in this admin is one of
 * these — sharing the shape is what stops the next one from being a fifth
 * hand-rolled variant or, worse, a one-click POST with no page at all.
 */
export interface ConfirmDestroyOptions {
  readonly modules: readonly NavModule[];
  readonly nav: string;
  readonly title: string;
  readonly heading: string;
  readonly intro: string;
  /** Rendered between the intro and the buttons — e.g. a chore's own history. */
  readonly body?: string;
  readonly destroyAction: string;
  readonly destroyLabel: string;
  /** Extra markup inside the destroy `<form>` — e.g. a hidden id field. */
  readonly destroyFields?: string;
  readonly alternative?: { readonly action: string; readonly label: string };
  readonly cancelAction: string;
  readonly cancelLabel?: string;
}

export function confirmDestroyPage(options: ConfirmDestroyOptions): string {
  return page({
    modules: options.modules,
    title: options.title,
    nav: options.nav,
    heading: options.heading,
    intro: options.intro,
    body:
      (options.body ?? '') +
      `<form method="post" action="${escapeHtml(options.destroyAction)}">` +
      (options.destroyFields ?? '') +
      `<button class="btn-danger" type="submit">${escapeHtml(options.destroyLabel)}</button></form>` +
      (options.alternative === undefined
        ? ''
        : `<form method="post" action="${escapeHtml(options.alternative.action)}">` +
          `<button class="secondary" type="submit">${escapeHtml(options.alternative.label)}</button></form>`) +
      `<form method="get" action="${escapeHtml(options.cancelAction)}">` +
      `<button class="secondary" type="submit">${escapeHtml(options.cancelLabel ?? 'Keep it')}</button></form>`,
  });
}

/**
 * A failure the person can act on.
 *
 * Takes the suggestion as a separate field rather than folding it into the
 * message, because "PARSE_FAILED" is not a diagnosis and the two read
 * differently: what went wrong, then what to do about it.
 */
export function errorBlock(message: string, suggestion?: string): string {
  return (
    `<div class="error"><strong>${escapeHtml(message)}</strong>` +
    (suggestion === undefined ? '' : `<span>${escapeHtml(suggestion)}</span>`) +
    `</div>`
  );
}

/*
 * The text field, shared by every server-rendered form.
 *
 * One construction — a wrapping <label class="field"> holding a label above a
 * bordered input. This replaced Material's outlined field, whose label rested
 * inside the box and floated up to sit *in* the border on focus. Three things
 * were wrong with that here. It needed the border drawn as three elements (a
 * start cap, a notch and an end run) purely so the label could open a gap in
 * it, which is a lot of machinery for a decoration. The floated label lands at
 * 12.5px, so the name of the thing you are filling in is the smallest text in
 * the form — backwards for a product whose whole brief is glanceability. And
 * it needed placeholder=" " on every input so :placeholder-shown could tell an
 * empty field from a server-prefilled one, which meant a real placeholder had
 * to be suppressed until focus.
 *
 * A label that simply sits above its input needs none of that: it is always
 * full size, always readable, the placeholder is free to be a placeholder, and
 * .field-static disappears because there is no longer a resting state for a
 * select or a date input to be an exception to.
 */

export interface TextFieldOptions {
  readonly label: string;
  readonly name: string;
  /** The input type. Text-like by default. */
  readonly type?: string;
  readonly value?: string;
  /** A real placeholder, shown whenever the input is empty. */
  readonly placeholder?: string;
  readonly required?: boolean;
  /**
   * Extra attributes, already escaped by the caller (`autocomplete="email"`,
   * `min="1"`, `autofocus`). Raw by design: the callers build markup as
   * strings throughout, and modelling every attribute would re-invent HTML.
   */
  readonly attrs?: string;
  /** Supporting text under the field. */
  readonly hint?: string;
  /** Renders the error variant with this supporting text in place of the hint. */
  readonly error?: string;
}

function fieldWrap(
  control: string,
  options: Pick<TextFieldOptions, 'label' | 'hint' | 'error'>,
  classes: string,
): string {
  const support =
    options.error !== undefined
      ? `<p class="field-hint is-error">${escapeHtml(options.error)}</p>`
      : options.hint !== undefined
        ? `<p class="field-hint">${escapeHtml(options.hint)}</p>`
        : '';
  return (
    `<label class="field${classes}${options.error !== undefined ? ' field-error' : ''}">` +
    `<span class="field-label">${escapeHtml(options.label)}</span>` +
    control +
    `</label>` +
    support
  );
}

export function textField(options: TextFieldOptions): string {
  const type = options.type ?? 'text';
  const control =
    `<input class="field-input" type="${escapeHtml(type)}" name="${escapeHtml(options.name)}"` +
    (options.value === undefined ? '' : ` value="${escapeHtml(options.value)}"`) +
    (options.placeholder === undefined ? '' : ` placeholder="${escapeHtml(options.placeholder)}"`) +
    (options.required === true ? ' required' : '') +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `>`;
  return fieldWrap(control, options, '');
}

export interface SelectFieldOptions {
  readonly label: string;
  readonly name: string;
  /** The <option> elements, built and escaped by the caller. */
  readonly optionsHtml: string;
  readonly attrs?: string;
  readonly hint?: string;
  readonly error?: string;
}

export function selectField(options: SelectFieldOptions): string {
  const control =
    `<select class="field-input" name="${escapeHtml(options.name)}"` +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `>${options.optionsHtml}</select>`;
  return fieldWrap(control, options, ' field-select');
}

export interface TextareaFieldOptions {
  readonly label: string;
  readonly name: string;
  readonly value?: string;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly attrs?: string;
  readonly hint?: string;
  readonly error?: string;
}

export function textareaField(options: TextareaFieldOptions): string {
  const control =
    `<textarea class="field-input" name="${escapeHtml(options.name)}" rows="${options.rows ?? 3}"` +
    (options.placeholder === undefined ? '' : ` placeholder="${escapeHtml(options.placeholder)}"`) +
    (options.required === true ? ' required' : '') +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `>${options.value === undefined ? '' : escapeHtml(options.value)}</textarea>`;
  return fieldWrap(control, options, '');
}

/**
 * An M3 switch for a checkbox that means one on/off setting.
 *
 * Still an input[type=checkbox] with its original name and value, so the form
 * handler never knows the control changed clothes. Pick-many groups stay
 * checkboxes (.checks) — a switch is for a setting, not a selection.
 */
export interface SwitchRowOptions {
  readonly label: string;
  readonly name: string;
  readonly checked: boolean;
  readonly hint?: string;
  readonly value?: string;
  readonly attrs?: string;
}

export function switchRow(options: SwitchRowOptions): string {
  return (
    `<label class="switch"><span class="switch-text">` +
    `<b>${escapeHtml(options.label)}</b>` +
    (options.hint === undefined ? '' : `<small>${escapeHtml(options.hint)}</small>`) +
    `</span>` +
    `<input type="checkbox" name="${escapeHtml(options.name)}"` +
    ` value="${escapeHtml(options.value ?? '1')}"` +
    (options.checked ? ' checked' : '') +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `></label>`
  );
}

/**
 * The `data-dirty` attribute for a form tag: `dirtyForm()` for one rendered
 * fresh, `dirtyForm(true)` for one handed back at 400 with what the household
 * typed still in it.
 *
 * The second case matters more than it looks. A re-render carries *unsaved*
 * values, so a script that boots clean disables Save, hides Cancel and disarms
 * the leave guard — on the one page where all three are most needed. Worse, an
 * error the household cannot fix by editing a field ("Home Assistant is not
 * connected") leaves them looking at a disabled Save with no way to retry.
 * The server is the only thing that knows a body was posted, so the server
 * says so.
 */
export function dirtyForm(alreadyDirty = false): string {
  return alreadyDirty ? ' data-dirty="dirty"' : ' data-dirty';
}

/**
 * The form's default button, drawn nowhere.
 *
 * Pressing Enter in a text field activates the **first submit button in tree
 * order**, and a form that holds a second submit posting somewhere else — the
 * Weather screen's "Use my Home Assistant home location", which carries a
 * `formaction` so it can travel with the unsaved fields — would answer Enter
 * with *that*. On Weather that meant typing a latitude, pressing Enter, and
 * having the number replaced by `zone.home` and reported as saved: the same
 * silent loss this phase exists to end, in a new place.
 *
 * The spec's own answer is tree order, so this is a real submit button placed
 * first and clipped out of sight. It has no accessible name and no tab stop —
 * a keyboard user reaches the visible Save, and a screen reader never meets
 * this at all. It is not a second Save the household can find; it is what
 * "press Enter" means.
 *
 * Only needed on a form with a `formaction` button in it. A form whose only
 * submit is Save already behaves correctly.
 */
export function defaultSubmit(): string {
  /*
   * Never disabled, and that is the point rather than an oversight.
   *
   * It carried `data-dirty-save` for a while, so the script greyed it out with
   * the visible Save and Enter on an untouched form did nothing — tidier, and
   * wrong. The spec says implicit submission uses the first submit button in
   * tree order and does nothing when that button is disabled; engines have not
   * always agreed, and WebKit has historically walked on to the first *enabled*
   * one. On this form that is "Use my Home Assistant home location", so Enter
   * in Latitude on a clean page would overwrite the stored coordinates with
   * `zone.home` — the exact loss this element exists to prevent, on the exact
   * page it exists for.
   *
   * So it stays enabled and Enter always means Save. On a clean form that saves
   * unchanged values and says so, which is a shade talkative and is precisely
   * what Enter does with script off. A talkative confirmation is a smaller
   * fault than an engine-dependent one, and it is the same one the no-script
   * baseline already has.
   */
  return `<button type="submit" class="formdefault" tabindex="-1" aria-hidden="true"></button>`;
}

/**
 * The foot of a settings form: Save, Cancel, and the flag that says why they
 * are there (RFC 009 Phase 3.2).
 *
 * The pattern is lifted from the wall editor's save bar rather than invented
 * beside it — Save disabled until dirty, Discard hidden until there is
 * something to discard, and a flag that says so. `display-editor.ts` had it
 * right and every other settings form in the product had neither.
 *
 * **What this renders is the no-script state**, and that is the whole of the
 * degradation promise: Save is a plain enabled submit, exactly as it has always
 * been, and the two controls that only mean something once there is a *diff* to
 * talk about are `hidden`. `settings-form.js` disables Save on boot and reveals
 * the rest on the first edit; a household who blocks script keeps today's form.
 *
 * `cancelHref` is stated rather than derived, because the obvious derivation is
 * wrong in the one case that matters: a form re-rendered at 400 leaves the
 * browser sitting on the POST URL, so "reload" would re-submit and "go to
 * `location.pathname`" would ask for a route that only answers POST. The page
 * knows where its own settings live; it says so.
 */
/**
 * A form whose response is a file, not a page.
 *
 * It matters to exactly one thing and it is not visible in the markup. A
 * browser fires `beforeunload` when the navigation *starts*, before the
 * response headers can say `Content-Disposition` — so at the moment the leave
 * guard has to decide, a download is indistinguishable from a departure. System
 * carries three of them (database, key, diagnostics) beside two settings forms,
 * and without this, pressing Download diagnostics with an unsaved timezone asks
 * whether you mean to abandon it, about a navigation that abandons nothing.
 *
 * A helper rather than an attribute to remember, for the reason `pruneToLane`
 * exists: somebody adding the fourth download form should not have to have read
 * this. `test/system.test.ts` pins the three that exist.
 */
export function downloadForm(action: string, label: string, className = ''): string {
  return (
    `<form method="get" action="${escapeHtml(action)}" data-download>` +
    `<button${className === '' ? '' : ` class="${escapeHtml(className)}"`} type="submit">` +
    `${escapeHtml(label)}</button></form>`
  );
}

export function saveRow(cancelHref: string, label = 'Save'): string {
  return (
    `<div class="saverow">` +
    `<button type="submit" data-dirty-save>${escapeHtml(label)}</button>` +
    `<button type="button" class="secondary" data-dirty-cancel="${escapeHtml(cancelHref)}" hidden>` +
    `Cancel</button>` +
    `<span class="dirtyflag" data-dirty-flag hidden>Not saved yet</span>` +
    `</div>`
  );
}

/**
 * A compact settings row: a label, the value it currently holds, and a chevron.
 *
 * The outlined text field is the right control for something you *type*; for a
 * choice out of a list it is 72px of box for one word, and a settings screen
 * made of them scrolls for ever on a phone. This is the same choice in ~56px:
 * the label and its supporting line on the left, the value on the right.
 *
 * It is still a native `<select>` inside a wrapping `<label>` — so the control
 * is labelled programmatically, keyboard operable, and opens the platform's own
 * picker. Only its clothes changed; every caller's `name` and options are
 * untouched, and so is the handler that reads them.
 */
export interface SelectRowOptions {
  readonly label: string;
  readonly name: string;
  /** The <option> elements, built and escaped by the caller. */
  readonly optionsHtml: string;
  /** Supporting text under the label — where inheritance is spelled out. */
  readonly hint?: string;
  readonly attrs?: string;
  /**
   * The value is long enough to want its own line on a phone — a timezone, or
   * a theme named as the household's. Marked by the caller rather than guessed:
   * a row that wraps when it does not need to is as untidy as one that clips
   * the half of the value carrying the information.
   */
  readonly wide?: boolean;
}

export function selectRow(options: SelectRowOptions): string {
  return (
    `<label class="srow${options.wide === true ? ' is-wide' : ''}">` +
    `<span class="srow-text"><b>${escapeHtml(options.label)}</b>` +
    (options.hint === undefined ? '' : `<small>${escapeHtml(options.hint)}</small>`) +
    `</span>` +
    `<span class="srow-value">` +
    `<select class="srow-select" name="${escapeHtml(options.name)}"` +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `>${options.optionsHtml}</select>` +
    `<span class="srow-chev" aria-hidden="true">${icon('chev')}</span>` +
    `</span></label>`
  );
}
