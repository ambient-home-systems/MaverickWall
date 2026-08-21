/**
 * Server-rendered pages.
 *
 * The wizard and the sign-in form are plain HTML with no script and no build
 * step, because they are the screens that must work before anything else does.
 * A bundle that fails to build or fails to load would otherwise take the only
 * route into the application down with it.
 *
 * Rule three still applies: nothing here loads a font, a stylesheet or an image
 * from anywhere. The styles are inline and the palette is Material Design 3's,
 * derived from the Board amber (see m3-tokens.ts), so the setup flow looks of a
 * piece with the wall it is configuring.
 */

import { M3_SCHEMES, type M3Scheme } from './m3-tokens.js';

/** Escape for HTML text and quoted attributes. Everything echoed back goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One scheme's colour roles as custom-property declarations.
 *
 * Serialized at module load from the committed schemes — string work, not a
 * build step, and the image still gains no dependency. System roles are
 * `--md-sys-color-*` exactly as the M3 documentation names them; the
 * harmonized Board status colours are `--md-custom-color-*`, the spec's
 * custom-colour convention, so nobody mistakes them for roles the spec
 * defines.
 */
function m3ColorVars(scheme: M3Scheme): string {
  const sys = Object.entries(scheme.sys).map(([role, hex]) => `--md-sys-color-${role}:${hex}`);
  const custom = Object.entries(scheme.custom).map(
    ([role, hex]) => `--md-custom-color-${role}:${hex}`,
  );
  return [...sys, ...custom].join(';');
}

/**
 * The M3 type scale — all fifteen roles, as the spec defines them:
 * size, line-height, weight, tracking. Px rather than rem deliberately: the
 * scale is specified in dp/px and this stylesheet already sizes in px.
 * Display/headline/title take the brand face, body/label the plain face —
 * both resolve to the bundled Roboto, but the seam is where a future face
 * swap happens without touching fifteen roles.
 */
const M3_TYPE_SCALE: Readonly<Record<string, readonly [string, string, string, string]>> = {
  'display-large': ['57px', '64px', '400', '-0.25px'],
  'display-medium': ['45px', '52px', '400', '0px'],
  'display-small': ['36px', '44px', '400', '0px'],
  'headline-large': ['32px', '40px', '400', '0px'],
  'headline-medium': ['28px', '36px', '400', '0px'],
  'headline-small': ['24px', '32px', '400', '0px'],
  'title-large': ['22px', '28px', '400', '0px'],
  'title-medium': ['16px', '24px', '500', '0.15px'],
  'title-small': ['14px', '20px', '500', '0.1px'],
  'body-large': ['16px', '24px', '400', '0.5px'],
  'body-medium': ['14px', '20px', '400', '0.25px'],
  'body-small': ['12px', '16px', '400', '0.4px'],
  'label-large': ['14px', '20px', '500', '0.1px'],
  'label-medium': ['12px', '16px', '500', '0.5px'],
  'label-small': ['11px', '16px', '500', '0.5px'],
};

function m3TypeVars(): string {
  return Object.entries(M3_TYPE_SCALE)
    .map(([role, [size, lineHeight, weight, tracking]]) => {
      const face = role.startsWith('body') || role.startsWith('label') ? 'plain' : 'brand';
      return (
        `--md-sys-typescale-${role}-font:var(--md-ref-typeface-${face});` +
        `--md-sys-typescale-${role}-size:${size};` +
        `--md-sys-typescale-${role}-line-height:${lineHeight};` +
        `--md-sys-typescale-${role}-weight:${weight};` +
        `--md-sys-typescale-${role}-tracking:${tracking}`
      );
    })
    .join(';\n  ');
}

const STYLE = `
/*
 * Self-hosted, first-party, no network. Rule three forbids fetching a web font,
 * so Roboto Condensed ships in the image and is served same-origin; the src is
 * relative, so the single <base> carries it through Home Assistant ingress.
 * Since the surfaces pass swept the admin onto the M3 scale, this face backs
 * only the wordmark's fallback stack here — the file itself stays bundled
 * because the display's custom themes are served from the same directory.
 */
@font-face{font-family:'Roboto Condensed';font-style:normal;font-weight:400 700;
  font-display:swap;src:url('assets/fonts/roboto-condensed.woff2') format('woff2')}

/*
 * Roboto — the Material Design 3 type scale's face, bundled the same way:
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
 * obvious difference. Every other heading stays on Roboto Condensed: this is
 * the identity, not a new heading style.
 */
@font-face{font-family:'Oswald';font-style:normal;font-weight:700;
  font-display:swap;src:url('assets/fonts/oswald-700.woff2') format('woff2')}

:root{
  --wordmark:'Oswald','Roboto Condensed','Arial Narrow',system-ui,sans-serif;
  --sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --md-ref-typeface-brand:'Roboto',system-ui,-apple-system,'Segoe UI',sans-serif;
  --md-ref-typeface-plain:'Roboto',system-ui,-apple-system,'Segoe UI',sans-serif;
}

/*
 * Material Design 3 foundations — the spec implemented by hand, no component
 * library, nothing fetched. The colour schemes are generated at design time
 * from the Board amber and committed (m3-tokens.ts; the generator's comment
 * holds the choices), then interpolated here when this constant is built.
 *
 * Type: the fifteen roles, verbatim from the spec. Shape: the corner scale.
 * Elevation: the five shadow levels — note for the component phase that in the
 * dark scheme M3 conveys elevation primarily by surface tint, not shadow:
 *   background:color-mix(in srgb,var(--md-sys-color-surface-tint) 5%,var(--md-sys-color-surface));
 * at 5/8/11/12/14% for levels 1-5, with the shadow token kept beside it.
 * State layers: the wash a component draws over itself when hovered, focused
 * or pressed — the role colour over the resting surface at the layer opacity:
 *   background:color-mix(in srgb,var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),var(--md-sys-color-surface-container));
 * Nothing applies them yet; this phase is the foundations, not the components.
 */
:root{
  ${m3TypeVars()};
  --md-sys-shape-corner-none:0;
  --md-sys-shape-corner-extra-small:4px;
  --md-sys-shape-corner-small:8px;
  --md-sys-shape-corner-medium:12px;
  --md-sys-shape-corner-large:16px;
  --md-sys-shape-corner-extra-large:28px;
  --md-sys-shape-corner-full:999px;
  --md-sys-elevation-level0:none;
  --md-sys-elevation-level1:0 1px 2px 0 rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15);
  --md-sys-elevation-level2:0 1px 2px 0 rgba(0,0,0,.3),0 2px 6px 2px rgba(0,0,0,.15);
  --md-sys-elevation-level3:0 1px 3px 0 rgba(0,0,0,.3),0 4px 8px 3px rgba(0,0,0,.15);
  --md-sys-elevation-level4:0 2px 3px 0 rgba(0,0,0,.3),0 6px 10px 4px rgba(0,0,0,.15);
  --md-sys-elevation-level5:0 4px 4px 0 rgba(0,0,0,.3),0 8px 12px 6px rgba(0,0,0,.15);
  --md-sys-state-hover-state-layer-opacity:8%;
  --md-sys-state-focus-state-layer-opacity:12%;
  --md-sys-state-pressed-state-layer-opacity:12%;
  --md-sys-state-dragged-state-layer-opacity:16%;
}

/*
 * The old token names, each an alias of an M3 role, which is what lets several
 * thousand lines of server-rendered pages restyle with no markup edit. Defined
 * once: the --md-* colour vars flip per scheme below, and an alias re-resolves
 * against whichever set is live. New styles should reach for --md-* directly;
 * these stay for what is already written.
 *
 * --panel2 is surface-container-high — one step above the card surface — so
 * inputs, insets and the sidebar keep reading as distinct from the cards they
 * sit against. --ruleSoft is the outline-variant faded rather than a role of
 * its own: M3 has one divider colour, and the soft rule only ever separates
 * rows inside a container, where a full outline-variant is too loud.
 */
:root{
  --bg:var(--md-sys-color-surface);
  --panel:var(--md-sys-color-surface-container);
  --panel2:var(--md-sys-color-surface-container-high);
  --rule:var(--md-sys-color-outline-variant);
  --ruleSoft:color-mix(in srgb,var(--md-sys-color-outline-variant) 55%,transparent);
  --ink:var(--md-sys-color-on-surface);
  --muted:var(--md-sys-color-on-surface-variant);
  --faint:var(--md-sys-color-outline);
  --accent:var(--md-sys-color-primary);
  --accentInk:var(--md-sys-color-on-primary);
  --danger:var(--md-sys-color-error);
  --ok:var(--md-custom-color-success);
  --warn:var(--md-custom-color-warning);
  --night:var(--md-custom-color-night);
}

/*
 * Dark by default — derived from the Board amber, the wall's own — with a light
 * option and an "auto" that follows the device. The choice is per-browser
 * (localStorage, applied by a tiny inline script before first paint, so there
 * is no flash) and only ever styles the admin, never the wall. color-mix() and
 * either scheme are fine here: this is a phone or a desktop, not the
 * locked-down tablet rule two is about.
 */
:root{
  color-scheme:dark;
  ${m3ColorVars(M3_SCHEMES.dark)};
  /* Elevated surfaces: the dark scheme conveys elevation primarily by the
   * surface tint (the recipe in the foundations comment above), so these two
   * pre-mix it at the level-1 and level-2 amounts. */
  --surface-elevation-1:color-mix(in srgb,var(--md-sys-color-surface-tint) 5%,var(--md-sys-color-surface-container-low));
  --surface-elevation-2:color-mix(in srgb,var(--md-sys-color-surface-tint) 8%,var(--md-sys-color-surface-container-low));
}
/* Light, when the household picks it. */
:root[data-theme="light"]{
  color-scheme:light;
  ${m3ColorVars(M3_SCHEMES.light)};
  /* Light elevation is the shadow's job; the container colour stands still. */
  --surface-elevation-1:var(--md-sys-color-surface-container-low);
  --surface-elevation-2:var(--md-sys-color-surface-container-low);
}
/* Auto: no explicit choice, and the device prefers light. */
@media (prefers-color-scheme: light){
  :root:not([data-theme]){
    color-scheme:light;
    ${m3ColorVars(M3_SCHEMES.light)};
    --surface-elevation-1:var(--md-sys-color-surface-container-low);
    --surface-elevation-2:var(--md-sys-color-surface-container-low);
  }
}
*{box-sizing:border-box}
*::selection{background:color-mix(in srgb,var(--accent) 32%,transparent)}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--md-sys-typescale-body-medium-font);
  font-size:var(--md-sys-typescale-body-medium-size);
  line-height:var(--md-sys-typescale-body-medium-line-height);
  letter-spacing:var(--md-sys-typescale-body-medium-tracking);
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}

/* ---- App shell: navigation drawer, scrolling main ------------------------ */
/* The drawer is 280px: wide enough to hold the 56px pill anatomy with this
 * admin's labels — the spec's 360dp is a maximum, not a target. Its container
 * colour is the separation, so there is no border down its edge. */
body.shell{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
.side{background:var(--md-sys-color-surface-container-low);
  display:flex;flex-direction:column;min-height:100vh;position:sticky;top:0;
  max-height:100vh;overflow:hidden}
.side .brand{display:flex;align-items:center;gap:11px;padding:20px 20px 16px;
  text-decoration:none;color:inherit}
.side .brand svg{width:34px;height:34px;flex:0 0 auto;border-radius:8px}
.side .brand b{font-family:var(--wordmark);font-weight:700;font-size:19px;
  letter-spacing:.02em;line-height:1;display:block}
.side .brand small{display:block;color:var(--faint);font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;margin-top:3px}
.nav{flex:1;overflow-y:auto;padding:6px 12px 12px}
.nav-group{margin-top:16px}
/* Drawer section headers: title-small mixed case, the M3 navigation-drawer
 * treatment. */
.nav-group>span{display:block;padding:0 12px 6px;
  font:var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size)/var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
  letter-spacing:var(--md-sys-typescale-title-small-tracking);
  color:var(--md-sys-color-on-surface-variant)}
/* Drawer items: the 56px full-corner pill, label-large, 24px icons. The
 * active item is the secondary-container indicator, not a primary fill —
 * that is the M3 drawer's own anatomy. */
.nav-item{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;margin:0;
  border-radius:var(--md-sys-shape-corner-full);
  color:var(--md-sys-color-on-surface-variant);
  text-decoration:none;font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);line-height:1.2}
.nav-item svg{width:24px;height:24px;flex:0 0 auto;stroke-width:1.6}
.nav-item:hover{color:var(--md-sys-color-on-surface);background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.nav-item:active{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
.nav-item.active{background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container)}
.nav-item.active:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-secondary-container) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-secondary-container))}
/* An installed module's nav entry: a generic module glyph (the row stores no
 * icon) and a small "Off" badge when the household has disabled it. */
.nav-item .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-badge{flex:0 0 auto;
  font:var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size)/var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  letter-spacing:var(--md-sys-typescale-label-small-tracking);
  color:var(--md-sys-color-on-surface-variant);
  background:var(--md-sys-color-surface-container-highest);
  border-radius:var(--md-sys-shape-corner-full);padding:2px 8px}
.side-foot{border-top:1px solid var(--rule);padding:14px 16px;display:flex;
  flex-direction:column;gap:12px}
.side-foot-id{display:flex;align-items:center;gap:10px}
.side-foot .fmark{width:32px;height:32px;flex:0 0 auto}
.side-foot .fmark svg{width:32px;height:32px;border-radius:7px;display:block}
.side-foot .who{min-width:0;flex:1}
.side-foot .who b{font-size:13px;font-weight:600;display:block;line-height:1.2}
.side-foot .who small{font-size:11px;color:var(--faint)}
.side-foot form{margin:0;flex:0 0 auto}
/* An M3 standard icon button: 40px visual, full corner, state layer, and a
 * 48px pointer target from the shared ::after extension. */
.signout{margin:0;padding:0;width:40px;height:40px;display:grid;place-items:center;
  background:transparent;color:var(--md-sys-color-on-surface-variant);border:0;
  border-radius:var(--md-sys-shape-corner-full);cursor:pointer}
.signout:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent);
  color:var(--md-sys-color-on-surface)}
.signout::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.signout svg{width:20px;height:20px;stroke-width:1.7}
/* Admin theme toggle: styled with the segmented buttons further down. */

.main{min-width:0;display:flex;flex-direction:column}
/* A small top app bar: 64px container, title-large, on the surface-container
 * colour the spec gives it while stuck. These pages carry no script, so the
 * bar cannot restyle itself on scroll — it wears the stuck colour always,
 * which is also what separates it: no blur, no translucency, no border. */
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;
  justify-content:space-between;gap:16px;min-height:64px;padding:8px 28px;
  background:var(--md-sys-color-surface-container)}
.topbar .crumb{font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-on-surface-variant);margin:0 0 2px}
.topbar h1{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking);
  color:var(--md-sys-color-on-surface);margin:0}
.content{padding:24px 28px 52px;max-width:1180px;width:100%}
.content>form:first-child,.content>.card:first-child,.content>.note:first-child{margin-top:0}
/* The page's lead line. Used to sit in the topbar as .sub; moved into the
 * content so the sticky bar stays a compact kicker+title and gives ~40px back. */
.note{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 20px;max-width:64ch}

/* 900px, up from 820: the drawer grew from 216px to 280px, and the main
 * column must keep at least what it had before the drawer widened. The
 * collapsed drawer's pills drop to a compact 40px so the wrapped rows do not
 * tower. */
@media(max-width:900px){
  body.shell{grid-template-columns:1fr}
  .side{position:static;min-height:0;max-height:none;flex-direction:row;
    flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--rule)}
  .side .brand{padding:14px 18px}
  .nav{flex:1 1 100%;display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 12px;overflow:visible}
  .nav-group{margin-top:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
  .nav-group>span{display:none}
  .nav-item{height:40px;padding:0 14px}
  .nav-item svg{width:20px;height:20px}
  .side-foot{display:none}
  .topbar{padding:8px 20px}
  .content{padding:22px 20px 48px}
}

/* ---- Wizard / sign-in: a centred column, no sidebar --------------------- */
body.wiz{display:flex;align-items:flex-start;justify-content:center;
  padding:40px 20px;min-height:100vh}
.wizbox{width:100%;max-width:520px}
.wizbox .brand{display:flex;align-items:center;gap:11px;text-decoration:none;
  color:inherit;margin:0 0 4px}
.wizbox .brand svg{width:34px;height:34px;border-radius:8px}
.wizbox .brand b{font-family:var(--wordmark);font-weight:700;font-size:19px}
/* The step indicator as an M3 linear-progress treatment: a 4px full-corner
 * track per step on surface-container-highest, filled primary once a step is
 * reached. Captions are label-medium mixed case, coloured by state — the
 * current step primary, done steps on-surface-variant, upcoming ones
 * outline. */
.steps{display:flex;gap:8px;margin:22px 0 26px;padding:0;list-style:none}
.steps .step{flex:1;text-align:center}
.steps .step .bar{height:4px;border-radius:var(--md-sys-shape-corner-full);
  background:var(--md-sys-color-surface-container-highest)}
.steps .step.done .bar,.steps .step.on .bar{background:var(--md-sys-color-primary)}
.steps .step span{display:block;margin-top:8px;
  font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-outline)}
.steps .step.on span{color:var(--md-sys-color-primary)}
.steps .step.done span{color:var(--md-sys-color-on-surface-variant)}
.wizbox .card{margin:0}
.wizbox>form,.wizbox>.error{margin-top:18px}

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
h1{font:var(--md-sys-typescale-headline-medium-weight) var(--md-sys-typescale-headline-medium-size)/var(--md-sys-typescale-headline-medium-line-height) var(--md-sys-typescale-headline-medium-font);
  letter-spacing:var(--md-sys-typescale-headline-medium-tracking);margin:0 0 4px}
p{color:var(--muted);margin:.5rem 0;line-height:1.55}
a.link{color:var(--accent);text-decoration:none;font-weight:600}
a.link:hover{text-decoration:underline}
/* Any inline arrow inside a link (list "Open →", "Manage →") stays small. */
.link{display:inline-flex;align-items:center;gap:4px}
.link svg{width:14px;height:14px;stroke-width:2;flex:0 0 auto}
.kick{font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-on-surface-variant)}
.code{font-family:var(--mono);font-size:1rem;letter-spacing:.08em;
  background:var(--panel2);padding:.15rem .4rem;border-radius:.25rem;color:var(--accent)}

/* ---- Forms --------------------------------------------------------------- */
form{margin:1.4rem 0 0}
/* Bare labels outside the .field system (bundle-built rows, specialist
 * controls). Mixed case: the uppercase kicker treatment is retired. */
label{display:block;margin:1rem 0 .35rem;
  font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);color:var(--muted)}
/* The generic input skin stays for inputs the display bundle builds at
 * runtime (.hep-search, the layout editor's controls); everything
 * server-rendered sits inside a .field below, which overrides this. Fields
 * are body-large: the one place the M3 spec names a role outright. */
input[type=text],input[type=email],input[type=password],input[type=number],
input[type=time],select,textarea{
  width:100%;padding:.62rem .7rem;border-radius:var(--md-sys-shape-corner-extra-small);
  border:1px solid var(--md-sys-color-outline);
  background:transparent;color:var(--md-sys-color-on-surface);font-family:inherit;
  font-size:var(--md-sys-typescale-body-large-size)}
textarea{resize:vertical;line-height:1.45}
input::placeholder,textarea::placeholder{color:var(--md-sys-color-on-surface-variant)}
input[type=color]{width:100%;height:2.6rem;padding:.2rem;
  border-radius:var(--md-sys-shape-corner-extra-small);
  border:1px solid var(--md-sys-color-outline);background:transparent}
input[type=file]{width:100%;padding:.55rem;border-radius:var(--md-sys-shape-corner-extra-small);
  border:1px solid var(--md-sys-color-outline);background:transparent;
  color:var(--md-sys-color-on-surface-variant);font-size:.95rem}

/* ---- Text fields: the M3 outlined text field, CSS only --------------------
 * Anatomy: a 56px transparent container, extra-small corner, and an outline
 * drawn as three segments (start cap / notch / end run) so the floating label
 * can open a real gap in the border. No background masking — masking needs
 * the label to know what ground it sits on, and these fields sit on cards,
 * insets and the wizard alike. The label rests centred over the input and
 * floats to the notch on focus or whenever the input holds a value — inputs
 * get placeholder=" " so :placeholder-shown distinguishes empty from filled,
 * which means a server-prefilled edit form renders floated with no script.
 * Controls that always render content (select, time, number, color, file,
 * textarea) carry .field-static and keep the label floated permanently.
 * Focus is the spec's treatment for fields — the outline thickening to 2px
 * primary — so the shared focus ring below stands down inside a .field. */
.field{position:relative;display:block;margin:1.1rem 0 0;color:var(--md-sys-color-on-surface)}
.field .field-input{width:100%;height:56px;padding:0 16px;border:0;background:transparent;
  border-radius:var(--md-sys-shape-corner-extra-small);
  color:var(--md-sys-color-on-surface);caret-color:var(--md-sys-color-primary);
  font-family:var(--md-sys-typescale-body-large-font);
  font-size:var(--md-sys-typescale-body-large-size);
  letter-spacing:var(--md-sys-typescale-body-large-tracking)}
.field .field-input:focus,.field .field-input:focus-visible{outline:none}
/* A real placeholder only shows once the label has floated away (on focus);
 * at rest the label occupies that spot. Static fields float permanently, so
 * theirs may show. */
.field:not(.field-static) .field-input:not(:focus)::placeholder{color:transparent}
/* font-style:normal because the segments are <i> elements (the .cm corner
 * marks' precedent) and the label must not inherit their italic. */
.field-outline{position:absolute;inset:0;display:flex;pointer-events:none;
  font-style:normal;color:var(--md-sys-color-outline);--fo-w:1px}
.fo-start{width:12px;flex:0 0 auto;
  border:var(--fo-w) solid currentColor;border-right:0;
  border-radius:var(--md-sys-shape-corner-extra-small) 0 0 var(--md-sys-shape-corner-extra-small)}
/* flex-start, not center: the outline is as tall as the control, and a
 * textarea is far taller than 56px — centring put the floated label in the
 * middle of the text. The label positions itself from the top instead. */
.fo-notch{display:flex;align-items:flex-start;padding:0 4px;
  border-top:var(--fo-w) solid currentColor;border-bottom:var(--fo-w) solid currentColor}
.fo-end{flex:1;border:var(--fo-w) solid currentColor;border-left:0;
  border-radius:0 var(--md-sys-shape-corner-extra-small) var(--md-sys-shape-corner-extra-small) 0}
/* font-style set explicitly: the notch is an <i>, whose UA italic is applied
 * on the element itself, so a reset on the wrapper never reaches this span. */
.field-label{color:var(--md-sys-color-on-surface-variant);white-space:nowrap;line-height:1;
  font-style:normal;
  font-family:var(--md-sys-typescale-body-large-font);
  font-size:var(--md-sys-typescale-body-large-size);
  letter-spacing:var(--md-sys-typescale-body-large-tracking);
  /* Rest: centred on the first line (28px down — half the 56px box, which is
   * also the first text line of a taller control). Float moves the centre to
   * the border itself. The % is the label's own height, so both hold at
   * either label size. */
  transform:translateY(calc(28px - 50%));
  transition:font-size .12s ease,transform .12s ease}
/* Hover darkens the outline; any focus turns it primary and 2px. */
.field:hover .field-outline{color:var(--md-sys-color-on-surface)}
.field .field-input:focus ~ .field-outline{color:var(--md-sys-color-primary);--fo-w:2px}
.field .field-input:focus ~ .field-outline .field-label{color:var(--md-sys-color-primary)}
/* Floated: the notch's top border opens and the label moves onto the line. */
.field .field-input:focus ~ .field-outline .fo-notch,
.field .field-input:not(:placeholder-shown) ~ .field-outline .fo-notch,
.field.field-static .field-outline .fo-notch{border-top-color:transparent}
.field .field-input:focus ~ .field-outline .field-label,
.field .field-input:not(:placeholder-shown) ~ .field-outline .field-label,
.field.field-static .field-outline .field-label{
  font-size:var(--md-sys-typescale-body-small-size);transform:translateY(-50%)}
/* The error variant, for pages that re-render with a field at fault. */
.field.field-error .field-outline,
.field.field-error .field-input:focus ~ .field-outline{color:var(--md-sys-color-error)}
.field.field-error .field-label,
.field.field-error .field-input:focus ~ .field-outline .field-label{color:var(--md-sys-color-error)}
/* Selects hide the native chrome and get a drawn caret in the wrapper. */
.field select.field-input{appearance:none;-webkit-appearance:none;padding-right:44px}
.field-select::after{content:"";position:absolute;right:18px;top:50%;width:8px;height:8px;
  border-right:2px solid var(--md-sys-color-on-surface-variant);
  border-bottom:2px solid var(--md-sys-color-on-surface-variant);
  transform:translateY(-70%) rotate(45deg);pointer-events:none}
.field textarea.field-input{height:auto;min-height:56px;padding:16px;resize:vertical;
  line-height:var(--md-sys-typescale-body-large-line-height)}
.field input[type=color].field-input{padding:12px 16px}
.field input[type=file].field-input{padding:16px;height:auto;min-height:56px;
  color:var(--md-sys-color-on-surface-variant)}
/* Supporting text, 16px in from the field edge like the spec's. */
.field-hint{margin:4px 0 0;padding:0 16px;color:var(--md-sys-color-on-surface-variant);
  font-size:var(--md-sys-typescale-body-small-size);
  line-height:var(--md-sys-typescale-body-small-line-height)}
.field-hint.is-error{color:var(--md-sys-color-error)}
/* A field with a "?" riding it as a trailing icon (left of a select's caret);
 * its popover opens under the field. */
.field-with-help{position:relative}
/* 1.1rem is the .field's own top margin; 28px is half the 56px box. */
.field-with-help .fieldhelp{position:absolute;right:40px;top:calc(1.1rem + 28px);
  transform:translateY(-50%)}
.field-with-help .helppop{top:calc(1.1rem + 58px);left:auto;right:0}

/* ---- Checkboxes and switches, on the native input, no script --------------
 * appearance:none leaves the real checkbox in the form; only the paint is
 * ours. The 18px box grows its pointer target to 48px with a pseudo-element
 * that also carries the hover state layer, drawn as a radial so the visible
 * circle stays 40px inside the 48px square target. */
.checks{margin-top:1rem}
.checks label{display:flex;gap:.75rem;align-items:center;margin:0;min-height:48px;
  font-family:var(--sans);font-weight:400;font-size:14px;letter-spacing:0;
  color:var(--md-sys-color-on-surface);cursor:pointer}
.checks input[type=checkbox],.hep-row input[type=checkbox],
.le-toggle input[type=checkbox],.le-cfg-check input[type=checkbox]{
  appearance:none;-webkit-appearance:none;position:relative;flex:0 0 auto;margin:0;
  width:18px;height:18px;border-radius:2px;cursor:pointer;background:transparent;
  border:2px solid var(--md-sys-color-on-surface-variant)}
.checks input[type=checkbox]::before,.hep-row input[type=checkbox]::before,
.le-toggle input[type=checkbox]::before,.le-cfg-check input[type=checkbox]::before{
  content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.checks input[type=checkbox]:hover::before,.hep-row input[type=checkbox]:hover::before,
.le-toggle input[type=checkbox]:hover::before,.le-cfg-check input[type=checkbox]:hover::before{
  background:radial-gradient(circle 20px at 50% 50%,color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent) 0 20px,
  transparent 20px)}
.checks input[type=checkbox]:checked,.hep-row input[type=checkbox]:checked,
.le-toggle input[type=checkbox]:checked,.le-cfg-check input[type=checkbox]:checked{
  background:var(--md-sys-color-primary);border-color:var(--md-sys-color-primary)}
.checks input[type=checkbox]:checked:hover::before,.hep-row input[type=checkbox]:checked:hover::before,
.le-toggle input[type=checkbox]:checked:hover::before,.le-cfg-check input[type=checkbox]:checked:hover::before{
  background:radial-gradient(circle 20px at 50% 50%,color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent) 0 20px,
  transparent 20px)}
/* The check glyph: a drawn tick, on-primary, centred in the 14px inner box. */
.checks input[type=checkbox]:checked::after,.hep-row input[type=checkbox]:checked::after,
.le-toggle input[type=checkbox]:checked::after,.le-cfg-check input[type=checkbox]:checked::after{
  content:"";position:absolute;left:3px;top:6px;width:8px;height:4px;
  border-left:2px solid var(--md-sys-color-on-primary);
  border-bottom:2px solid var(--md-sys-color-on-primary);
  transform:rotate(-45deg);transform-origin:center}

/* An M3 switch where one checkbox means one on/off setting. Still an
 * input[type=checkbox] with its original name, so form handling never knows;
 * the input itself is the 52x32 track and its ::before is the thumb, growing
 * from 16px (outline colour) to 24px (on-primary) when checked. The row is
 * 48px tall, which is the pointer target. */
.switch{display:flex;align-items:center;justify-content:space-between;gap:16px;
  min-height:48px;margin:.35rem 0;cursor:pointer;
  font:400 14px/20px var(--md-sys-typescale-body-medium-font);
  letter-spacing:var(--md-sys-typescale-body-medium-tracking);text-transform:none}
.switch .switch-text{min-width:0}
.switch .switch-text b{display:block;font-weight:500;font-size:14px;
  color:var(--md-sys-color-on-surface)}
.switch .switch-text small{display:block;font-size:12px;line-height:1.4;
  color:var(--md-sys-color-on-surface-variant)}
.switch input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;
  flex:0 0 auto;margin:0;width:52px;height:32px;cursor:pointer;
  border-radius:var(--md-sys-shape-corner-full);
  background:var(--md-sys-color-surface-container-highest);
  border:2px solid var(--md-sys-color-outline);
  transition:background .15s ease,border-color .15s ease}
.switch input[type=checkbox]::before{content:"";position:absolute;top:50%;left:6px;
  width:16px;height:16px;border-radius:50%;background:var(--md-sys-color-outline);
  transform:translateY(-50%);
  transition:left .15s ease,width .15s ease,height .15s ease,background .15s ease}
.switch input[type=checkbox]:checked{background:var(--md-sys-color-primary);
  border-color:var(--md-sys-color-primary)}
.switch input[type=checkbox]:checked::before{left:22px;width:24px;height:24px;
  background:var(--md-sys-color-on-primary)}
.switch input[type=checkbox]:active::before{width:22px;height:22px}
.switch input[type=checkbox]:checked:active::before{width:28px;height:28px;left:20px}

.row-fields{display:flex;gap:1rem;flex-wrap:wrap}
.row-fields span,.row-fields .field{flex:1 1 12rem}
.row-fields .field{margin-top:1.1rem}

/* ---- Buttons: M3 common buttons -------------------------------------------
 * The default is a filled button (40px container, full corner, label-large,
 * 24px side padding, 16px beside a leading icon); .secondary/.btn-ghost are
 * outlined, .tonal/.btn-tonal is filled tonal for a secondary action that
 * deserves more weight, .btn-danger is outlined on the error role. Hover and
 * pressed are M3 state layers — the label colour laid over the container at
 * the state opacities — never filter:brightness. Every compact variant is the
 * same anatomy at 32px density, and every control smaller than 48px extends
 * its pointer target with an ::after pseudo, never its visual. */
button,.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;
  gap:8px;margin-top:1.4rem;height:40px;padding:0 24px;
  border-radius:var(--md-sys-shape-corner-full);border:1px solid transparent;
  background:var(--md-sys-color-primary);color:var(--md-sys-color-on-primary);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  cursor:pointer;line-height:1;text-decoration:none;white-space:nowrap;user-select:none}
/* The pointer target, stretched to at least 48px in both axes for every
 * button — a 40px container is the spec's visual, not its target. The pseudo
 * is absolute, so flex layouts inside the button never see it; variants with
 * their own ::after (segments, icon buttons) override this one. */
button::after,.btn::after{content:"";position:absolute;left:50%;top:50%;
  width:max(100%,48px);height:max(100%,48px);transform:translate(-50%,-50%)}
button:hover,.btn:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-primary) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-primary))}
button:active,.btn:active{background:color-mix(in srgb,
  var(--md-sys-color-on-primary) var(--md-sys-state-pressed-state-layer-opacity),
  var(--md-sys-color-primary))}
button:has(svg),.btn:has(svg){padding-left:16px}
button svg,.btn svg{width:18px;height:18px;stroke-width:1.8}
button.secondary,.btn-ghost{background:transparent;color:var(--md-sys-color-primary);
  border-color:var(--md-sys-color-outline)}
button.secondary:hover,.btn-ghost:hover{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent)}
button.secondary:active,.btn-ghost:active{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
button.tonal,.btn-tonal{background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container);border-color:transparent}
button.tonal:hover,.btn-tonal:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-secondary-container) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-secondary-container))}
button.tonal:active,.btn-tonal:active{background:color-mix(in srgb,
  var(--md-sys-color-on-secondary-container) var(--md-sys-state-pressed-state-layer-opacity),
  var(--md-sys-color-secondary-container))}
/* An M3 text button: no container at rest, primary label, state layers only —
 * the lowest-emphasis action, e.g. the wizard's "Skip for now". */
button.text,.btn-text{background:transparent;color:var(--md-sys-color-primary);
  border-color:transparent;padding:0 12px}
button.text:hover,.btn-text:hover{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent)}
button.text:active,.btn-text:active{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
.btn-danger{background:transparent;color:var(--md-sys-color-error);
  border-color:var(--md-sys-color-outline)}
.btn-danger:hover{background:color-mix(in srgb,
  var(--md-sys-color-error) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.btn-danger:active{background:color-mix(in srgb,
  var(--md-sys-color-error) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
/* Compact density: the same button at a 32px container, with the pointer
 * target stretched back to 48px by a pseudo-element. */
.btn-sm{margin-top:0;height:32px;padding:0 16px}
.link-btn{margin-top:0}
/* ---- Segmented buttons: .seg (Store alerts), .le-orient, .themebar --------
 * One outlined container, full corner on the outer ends, 40px height; the
 * selected segment is secondary-container with a leading check drawn in CSS.
 * No overflow:hidden — it would clip the focus ring — so the end radii live on
 * the end segments themselves. */
.seg,.le-orient,.themebar{display:inline-flex;margin:0;border:1px solid var(--md-sys-color-outline);
  border-radius:var(--md-sys-shape-corner-full);background:transparent;overflow:visible}
.seg button,.le-orient-btn,.themebtn{position:relative;flex:1;margin:0;height:38px;
  padding:0 16px;border:0;border-left:1px solid var(--md-sys-color-outline);border-radius:0;
  background:transparent;color:var(--md-sys-color-on-surface);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.seg button:first-child,.le-orient-btn:first-child,.themebtn:first-child{border-left:0;
  border-radius:var(--md-sys-shape-corner-full) 0 0 var(--md-sys-shape-corner-full)}
.seg button:last-child,.le-orient-btn:last-child,.themebtn:last-child{
  border-radius:0 var(--md-sys-shape-corner-full) var(--md-sys-shape-corner-full) 0}
.seg button:hover,.le-orient-btn:hover,.themebtn:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent);
  color:var(--md-sys-color-on-surface)}
.seg button:active,.le-orient-btn:active,.themebtn:active{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
.seg button.on,.le-orient-btn.is-on,.themebtn[data-active="true"]{
  background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container)}
.seg button.on:hover,.le-orient-btn.is-on:hover,.themebtn[data-active="true"]:hover{
  background:color-mix(in srgb,
  var(--md-sys-color-on-secondary-container) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-secondary-container))}
/* The selected segment's leading check, drawn rather than fetched: a small box
 * with two borders, rotated into a tick. */
.seg button.on::before,.le-orient-btn.is-on::before,.themebtn[data-active="true"]::before{
  content:"";width:9px;height:5px;margin-top:-3px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}
/* The sidebar's theme toggle fills its row, and its segments carry short
 * labels in a tight column, so they trade the 16px padding for 10px. */
.themebar{display:flex}
.themebtn{padding:0 10px}
.seg button::after,.le-orient-btn::after,.themebtn::after{content:"";position:absolute;
  left:0;right:0;top:50%;height:48px;transform:translateY(-50%)}

/* ---- Errors and disclaimers (the .error box) -----------------------------
 * The M3 error-container pattern: a filled tonal container, medium corner,
 * everything in it on-error-container. The old left accent border retired
 * with the rest of the blueprint identity. */
.error{background:var(--md-sys-color-error-container);
  padding:.9rem 1.1rem;border-radius:var(--md-sys-shape-corner-medium);margin:1rem 0}
.error strong{color:var(--md-sys-color-on-error-container);display:block;
  font-size:14px;font-weight:600;margin-bottom:2px}
.error span{color:var(--md-sys-color-on-error-container);font-size:13px;line-height:1.5}

/* ---- Cards ----------------------------------------------------------------
 * Two M3 kinds, chosen by use. A static section card is a filled card:
 * surface-container-highest, medium corner, no border. A card that navigates
 * (a.card, the stat tiles) is an elevated card further down: container-low
 * with a level-1 shadow, and in the dark scheme the pre-mixed surface tint
 * (--surface-elevation-*) carries the lift, with the shadow kept beside it. */
.card{position:relative;background:var(--md-sys-color-surface-container-highest);
  border-radius:var(--md-sys-shape-corner-medium);padding:16px;margin:1rem 0}
.card h2{font:var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size)/var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing:var(--md-sys-typescale-title-medium-tracking);margin:0;
  display:flex;align-items:center;gap:.5rem}
.card p{margin:.4rem 0}
.card .host,.host{color:var(--faint);font-size:12.5px;font-family:var(--mono);
  margin:.35rem 0}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.row form{margin:.75rem 0 0}
.row button{margin-top:0}
h2.add{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking);
  margin:2rem 0 0;padding-top:1.5rem;border-top:1px solid var(--rule)}
p.hint,.hint{font-size:12.5px;color:var(--faint);margin:.35rem 0 0;line-height:1.5}

/* ---- Grids and section headers ------------------------------------------ */
.grid{display:grid;gap:16px;margin:1rem 0}
.g3{grid-template-columns:repeat(3,1fr)}
.g2{grid-template-columns:repeat(2,1fr)}
@media(max-width:1040px){.g3{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.g3,.g2{grid-template-columns:1fr}}
.sect{margin-top:30px}
.sect:first-child{margin-top:0}
.sect-head{display:flex;align-items:baseline;justify-content:space-between;
  gap:1rem;margin-bottom:14px}
.sect-head h2{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking);margin:0}

/* ---- Stat cards: the elevated kind — they navigate ----------------------- */
a.card{display:block;text-decoration:none;color:inherit;
  background:var(--surface-elevation-1);
  box-shadow:var(--md-sys-elevation-level1);
  transition:box-shadow .12s,background .12s}
a.card:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),
  var(--surface-elevation-2));
  box-shadow:var(--md-sys-elevation-level2)}
.stat .top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.stat .subrow .link{display:inline-flex;align-items:center;gap:4px}
.stat .subrow .link svg{width:13px;height:13px;stroke-width:2}
.ic{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;
  background:var(--panel2);border:1px solid var(--rule);color:var(--accent);flex:0 0 auto}
.ic svg{width:19px;height:19px;stroke-width:1.6}

/* ---- Overview status + today cards --------------------------------------- */
.status-card .frow{display:flex;align-items:center;gap:12px;padding:12px 0;
  border-top:1px solid var(--ruleSoft)}
.status-card .frow:first-child{padding-top:0;border-top:0}
.status-card .frow:last-child{padding-bottom:0}
.status-card .frow .ic{width:30px;height:30px}
.status-card .frow .ic svg{width:16px;height:16px}
.rname{font-weight:600;font-size:14px}
.status-card .frow .link{display:inline-flex;align-items:center;gap:4px}
.status-card .frow .link svg{width:13px;height:13px;stroke-width:2}
.today-card{display:flex;flex-direction:column}
/* line-height guards: body's role line-height is a px length, which inherits
 * as-is into any larger text that does not set its own. */
.today-big{font:var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size)/var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
  letter-spacing:var(--md-sys-typescale-headline-small-tracking);margin:6px 0 2px}
.stat .ic{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;
  background:var(--panel2);border:1px solid var(--rule);color:var(--accent)}
.stat .ic svg{width:19px;height:19px;stroke-width:1.6}
.stat .big{font:var(--md-sys-typescale-headline-medium-weight) var(--md-sys-typescale-headline-medium-size)/var(--md-sys-typescale-headline-medium-line-height) var(--md-sys-typescale-headline-medium-font);
  letter-spacing:var(--md-sys-typescale-headline-medium-tracking);margin:12px 0 2px}
.stat .lab{color:var(--muted);font-size:13.5px}
.stat .subrow{margin-top:12px;padding-top:12px;border-top:1px solid var(--ruleSoft);
  font-size:12.5px;color:var(--faint);display:flex;align-items:center;
  justify-content:space-between;gap:.5rem}

/* ---- Status dots and tags ------------------------------------------------ */
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.dot-ok{background:var(--ok)}.dot-bad{background:var(--danger)}
.dot-idle{background:var(--faint)}
.pulse{position:relative}
.pulse::after{content:"";position:absolute;inset:-4px;border-radius:50%;
  border:1px solid var(--ok);opacity:.6;animation:pl 2.4s ease-out infinite}
@keyframes pl{0%{transform:scale(.6);opacity:.7}100%{transform:scale(1.7);opacity:0}}
/* Status tags in tonal containers — the harmonized custom-role containers do
 * the colour work, label-small mixed case does the type. */
.tag{display:inline-flex;align-items:center;gap:6px;
  font:var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size)/var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  letter-spacing:var(--md-sys-typescale-label-small-tracking);
  padding:4px 10px;border-radius:var(--md-sys-shape-corner-small);
  background:var(--md-sys-color-surface-container-highest);
  color:var(--md-sys-color-on-surface-variant)}
.tag-ok{background:var(--md-custom-color-success-container);
  color:var(--md-custom-color-on-success-container)}
.tag-bad{background:var(--md-sys-color-error-container);
  color:var(--md-sys-color-on-error-container)}
.tag-accent{background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container)}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;
  background:var(--swatch);flex:0 0 auto;vertical-align:baseline}
img.avatar{width:1.7rem;height:1.7rem;border-radius:50%;object-fit:cover;
  margin-right:.4rem;vertical-align:-.4rem;background:var(--panel2)}

/* ---- Sub-view switcher (per-wall Appearance | Layout) -------------------- */
/* ---- Store card glyph preview ("screenshot" spelled out in glyphs) -------- */
/* A little inset tile beside the icon, styled like a wall stat panel: a big
 * headline line then a caption or two. First-party glyphs only, no image. */
.cpreview{flex:0 0 auto;width:118px;min-height:64px;display:flex;flex-direction:column;
  justify-content:center;gap:2px;padding:9px 11px;border-radius:8px;
  background:var(--panel2);border:1px solid var(--rule);overflow:hidden}
.cpreview b{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking);
  color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpreview i{font-style:normal;font-size:11px;line-height:1.25;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:560px){.cpreview{display:none}}

/* ---- Theme builder (custom themes) --------------------------------------- */
.theme-builder{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start;margin-top:.5rem}
/* 1000px, not the shell's 900: below this the 320px preview column starves
 * the controls beside the 280px drawer. */
@media(max-width:1000px){.theme-builder{grid-template-columns:1fr}}
.tb-controls{min-width:0}
.tb-controls>.tb-group{display:block;margin:1.6rem 0 .2rem;
  font:var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size)/var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
  letter-spacing:var(--md-sys-typescale-title-small-tracking);
  color:var(--md-sys-color-on-surface-variant)}
.tf-row{display:flex;align-items:center;gap:12px;margin:9px 0}
.tf-row input[type=color]{width:46px;height:34px;flex:0 0 auto;padding:2px;margin:0}
.tf-row b{display:block;font-size:14px;font-weight:600}
.tf-row small{display:block;color:var(--faint);font-size:12px;line-height:1.35}
.tb-preview{position:sticky;top:88px}
#theme-preview{width:300px;max-width:100%;min-height:220px;border:1px solid var(--rule);
  border-radius:8px;overflow:hidden;background:var(--panel2)}
#theme-contrast{margin-top:12px}

/* ---- Theme picker cards (Display) ---------------------------------------- */
.themegrid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:.6rem}
@media(max-width:560px){.themegrid{grid-template-columns:1fr}}
/* A selectable filled card: the swatch strip bleeds to the corner, the chosen
 * one carries a 2px primary ring (a shadow, so nothing shifts). */
.themecard{position:relative;display:block;
  background:var(--md-sys-color-surface-container-highest);
  border-radius:var(--md-sys-shape-corner-medium);overflow:hidden;cursor:pointer}
.themecard input{position:absolute;opacity:0;pointer-events:none}
.themecard .sw{height:60px;display:flex}
.themecard .sw i{flex:1}
.themecard .cap{padding:10px 14px}
.themecard .cap b{
  font:var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size)/var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
  letter-spacing:var(--md-sys-typescale-title-small-tracking);display:block;
  color:var(--md-sys-color-on-surface)}
.themecard .cap small{color:var(--md-sys-color-on-surface-variant);font-size:11.5px}
.themecard:hover .cap{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.themecard:has(input:checked){box-shadow:0 0 0 2px var(--md-sys-color-primary)}

/* ---- Preview panel (calendar test, update-available, shift preview) ------ */
.preview{position:relative;border:1px solid var(--rule);border-radius:8px;
  padding:16px 18px;margin:1rem 0;background:var(--panel2)}
.preview h3{font:var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size)/var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing:var(--md-sys-typescale-title-medium-tracking);margin:0 0 .3rem}
.preview ul{list-style:none;margin:.6rem 0 0;padding:0}
.preview li{display:flex;gap:.9rem;padding:.5rem 0;font-size:14px;
  border-top:1px solid var(--ruleSoft)}
.preview li:first-child{border-top:0}
.preview .when{color:var(--faint);flex:0 0 12rem;font-family:var(--mono);font-size:12.5px}
.preview .warn{color:var(--warn);font-size:.9rem;margin-top:.6rem}
ul.plain{margin:.6rem 0 .6rem 1.1rem;color:var(--muted)}
ul.plain li{margin:.45rem 0}
ul.plain strong{color:var(--ink)}
/* The log block on the inverse roles: the one deliberately inverted surface,
 * which is what makes it read as a terminal in either scheme. */
pre.log{background:var(--md-sys-color-inverse-surface);
  border-radius:var(--md-sys-shape-corner-small);padding:.8rem 1rem;
  font:12px/1.55 var(--mono);color:var(--md-sys-color-inverse-on-surface);
  max-height:22rem;overflow:auto;white-space:pre-wrap;word-break:break-word}

/* ---- QR + short code (pairing) ------------------------------------------ */
/* Deliberately white in both schemes: a QR needs its quiet zone on a light
 * plate, or half the phones in the house refuse to read it. */
.qr{background:#fff;padding:.8rem;border-radius:var(--md-sys-shape-corner-medium);
  display:inline-block;margin:.6rem 0}
.qr svg{display:block}

/* ---- Shift slot pickers -------------------------------------------------- */
.slots{display:flex;flex-wrap:wrap;gap:.5rem}
.slots span{flex:0 0 6.2rem}
.slots label{margin:.4rem 0 .2rem;font-size:.7rem;color:var(--faint);
  font-weight:600;letter-spacing:.04em}
.slots select{padding:.4rem .3rem;font-size:.9rem}
.title-cell{display:flex;align-items:center;font-weight:600;min-width:0;
  overflow-wrap:anywhere}

/* ---- Shift preview / cycle grid ------------------------------------------ */
.pv-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-top:.7rem}
.pv-cell{background:var(--panel2);border-radius:5px;padding:8px 4px;text-align:center;
  border-top:3px solid var(--accent)}
.pv-cell.pv-off{border-top-color:var(--ok);
  background:color-mix(in srgb,var(--ok) 8%,var(--panel2))}
.pv-cell.pv-unknown{border-top-color:var(--rule);background:var(--panel2);opacity:.6}
.pv-dow{display:block;font:var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size)/var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  letter-spacing:var(--md-sys-typescale-label-small-tracking);color:var(--faint)}
.pv-num{display:block;font:var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size)/var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing:var(--md-sys-typescale-title-medium-tracking);margin:2px 0}
.pv-code{display:block;font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);color:var(--accent)}
.pv-off .pv-code{color:var(--ok)}
.pv-unknown .pv-code{color:var(--faint)}

/* ---- Wall switcher above the layout editor ------------------------------- */
/* The wall switcher is a row of M3 filter chips: the current wall is the
 * selected chip. Same anatomy as .hep-chip above. */
.walls{display:flex;flex-wrap:wrap;gap:8px;margin:.4rem 0 1rem}
.walls a{position:relative;height:32px;display:inline-flex;align-items:center;gap:8px;
  padding:0 16px;border-radius:var(--md-sys-shape-corner-small);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  text-decoration:none;color:var(--md-sys-color-on-surface-variant);
  background:transparent;border:1px solid var(--md-sys-color-outline)}
.walls a::after{content:"";position:absolute;left:0;right:0;top:50%;height:48px;
  transform:translateY(-50%)}
.walls a:hover{color:var(--md-sys-color-on-surface);background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.walls a.active{color:var(--md-sys-color-on-secondary-container);
  background:var(--md-sys-color-secondary-container);border-color:transparent}
.walls a.active::before{content:"";width:9px;height:5px;margin-top:-3px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}

/* ---- Layout editor (behaviour lives in the display bundle; this styles it) */
/* position:relative so the Layers popover anchors here, never on <body>. */
.le-toolbar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 1rem}
.le-tool-spacer{flex:1 1 auto}
/* Toolbar tools are compact outlined buttons — the shared anatomy at 32px
 * density, targets stretched back to 48px. */
.le-tool-link,.le-tool-btn,.le-layers-btn{position:relative;margin:0;height:32px;
  padding:0 16px;background:transparent;color:var(--md-sys-color-primary);
  border:1px solid var(--md-sys-color-outline);border-radius:var(--md-sys-shape-corner-full);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  cursor:pointer;text-decoration:none;display:inline-flex;
  align-items:center;gap:6px;line-height:1}
.le-tool-link::after,.le-tool-btn::after,.le-layers-btn::after{content:"";position:absolute;
  left:50%;top:50%;width:max(100%,48px);height:48px;transform:translate(-50%,-50%)}
.le-tool-link:hover,.le-tool-btn:hover,.le-layers-btn:hover{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.le-layers-btn.is-on{background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container);border-color:transparent}
.le-reset-form{margin:0}
/* The Layers popover — anchored under its toolbar button (offsetParent is the
   toolbar), so it never floats over the settings pane. */
/* An M3 menu surface: extra-small corner, surface-container, level-2 shadow. */
.le-layers-pop{position:absolute;top:calc(100% + 6px);right:0;width:320px;z-index:30;
  background:var(--md-sys-color-surface-container);
  border-radius:var(--md-sys-shape-corner-extra-small);
  box-shadow:var(--md-sys-elevation-level2);overflow:hidden}
.le-layers-pop[hidden]{display:none}
.le-layers-head{padding:12px 16px;border-bottom:1px solid var(--ruleSoft)}
.le-layers-title{font:var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size)/var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing:var(--md-sys-typescale-title-medium-tracking);color:var(--ink)}
.le-layers-sub{font-size:12px;color:var(--faint);margin-top:2px}
.le-layers-empty{padding:14px 16px;font-size:13px;color:var(--faint)}
.le-layer-swatch{flex:0 0 auto;width:12px;height:12px;border-radius:3px}
.le-toggle{display:inline-flex;align-items:center;gap:.65rem;font-size:14px;
  color:var(--md-sys-color-on-surface);margin:0}
.le-aspect{width:auto;padding:.42rem .6rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
/* Portrait | Landscape: styled with the segmented buttons above. */
/* The palette sits inline in the toolbar (the display bundle builds it there),
   so it is a row of dashed add-chips rather than the mockup's side column. */
.le-palette{display:flex;flex-wrap:wrap;gap:6px}
.le-add{position:relative;display:inline-flex;align-items:center;gap:6px;margin:0;
  height:32px;padding:0 16px;border:1px solid var(--md-sys-color-outline);
  border-radius:var(--md-sys-shape-corner-full);background:none;
  color:var(--md-sys-color-primary);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);cursor:pointer;text-align:left}
.le-add::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,48px);
  height:48px;transform:translate(-50%,-50%)}
.le-add:hover{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.le-add svg{width:16px;height:16px;stroke-width:1.6;flex:0 0 auto}
/* The single "+ Add widget" button reads as the primary action, not another
   outlined chip — it opens the add-widget modal below, so it is filled. */
.le-add-primary{border-color:transparent;color:var(--md-sys-color-on-primary);
  background:var(--md-sys-color-primary)}
.le-add-primary:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-primary) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-primary))}
/* The add-widget modal: a centred card of first-party widget types. */
/* An M3 basic dialog: extra-large corner, surface-container-high, a 32% black
 * scrim, headline-small title. */
.le-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;
  justify-content:center;padding:24px;background:rgba(0,0,0,.32)}
.le-modal[hidden]{display:none}
.le-modal-card{width:min(560px,100%);max-height:85vh;overflow:auto;
  background:var(--md-sys-color-surface-container-high);
  border-radius:var(--md-sys-shape-corner-extra-large);
  box-shadow:var(--md-sys-elevation-level3)}
.le-modal-head{display:flex;align-items:center;justify-content:space-between;
  padding:20px 24px 12px;
  font:var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size)/var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
  letter-spacing:var(--md-sys-typescale-headline-small-tracking);
  color:var(--md-sys-color-on-surface)}
.le-modal-close{position:relative;margin:0;padding:0;width:40px;height:40px;
  display:grid;place-items:center;background:none;border:0;
  border-radius:var(--md-sys-shape-corner-full);
  color:var(--md-sys-color-on-surface-variant);font-size:22px;line-height:1;cursor:pointer}
.le-modal-close::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.le-modal-close:hover{color:var(--md-sys-color-on-surface);background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.le-modal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:20px}
@media(max-width:520px){.le-modal-grid{grid-template-columns:repeat(2,1fr)}}
.le-modal-item{display:flex;align-items:center;justify-content:center;text-align:center;
  min-height:64px;padding:12px;background:var(--md-sys-color-surface-container-highest);
  color:var(--md-sys-color-on-surface);border:0;
  border-radius:var(--md-sys-shape-corner-medium);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);cursor:pointer}
.le-modal-item:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-surface-container-highest))}
.le-delete{margin-top:0;height:32px;padding:0 16px;background:transparent;
  color:var(--md-sys-color-error);border:1px solid var(--md-sys-color-outline);
  border-radius:var(--md-sys-shape-corner-full);cursor:pointer}
.le-delete:hover{background:color-mix(in srgb,
  var(--md-sys-color-error) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.le-delete:disabled{opacity:.4;cursor:default}
.le-save{margin-top:0;height:32px;padding:0 16px;background:var(--md-sys-color-primary);
  color:var(--md-sys-color-on-primary);border:1px solid transparent;
  border-radius:var(--md-sys-shape-corner-full);cursor:pointer}
.le-status{font-size:12.5px;font-family:var(--mono);color:var(--faint)}
.le-status.is-dirty{color:var(--accent)}
.le-status.is-ok{color:var(--ok)}
.le-status.is-error{color:var(--danger)}
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
.le-preview .preview-wall{overflow:hidden}
.le-overlay{position:absolute;inset:0;z-index:1}
.le-widget{position:absolute;background:color-mix(in srgb,var(--ok) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--ok) 60%,transparent);border-radius:4px;
  cursor:move;touch-action:none;overflow:hidden;user-select:none}
.le-widget:hover{background:color-mix(in srgb,var(--ok) 20%,transparent)}
.le-widget.is-selected{border-color:var(--accent);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}
.le-widget-label{position:absolute;top:0;left:0;
  font:var(--md-sys-typescale-label-small-weight) 10px/var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  letter-spacing:var(--md-sys-typescale-label-small-tracking);color:#05140d;
  background:var(--ok);padding:2px 6px;border-radius:0 0 4px 0;pointer-events:none;user-select:none}
.le-widget.is-selected .le-widget-label{background:var(--accent);color:var(--accentInk)}
.le-handle{position:absolute;right:2px;bottom:2px;width:12px;height:12px;background:var(--accent);
  border-radius:3px 0 3px 0;cursor:se-resize;touch-action:none}
/* The canvas background control — none / solid / gradient, per canvas. */
.le-bg{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:12px 0 0}
.le-bg-label{
  font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-on-surface-variant)}
.le-bg select{width:auto;padding:.42rem .6rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
.le-bg input[type=color]{width:36px;height:32px;padding:2px;border:1px solid var(--rule);
  border-radius:7px;background:var(--panel2)}
.le-bg input[type=number]{width:5rem;padding:.42rem .5rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
.le-bg .le-media{flex-basis:100%}

/* The image picker — a grid of uploaded pictures plus an upload input. */
.le-media{display:flex;flex-direction:column;gap:10px;margin-top:4px}
.le-media-grid{display:flex;flex-wrap:wrap;gap:8px}
.le-media-item{width:64px;height:64px;padding:0;margin:0;border-radius:8px;cursor:pointer;
  border:2px solid var(--rule);background-size:cover;background-position:center}
.le-media-item:hover{border-color:var(--faint)}
.le-media-item.is-on{border-color:var(--accent)}
.le-media-upload{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.le-media-upload input{font-size:12px}
.le-media-status{font-family:var(--mono);font-size:12px;color:var(--faint)}

/* The layers list — every widget, front on top; drag a row to restack. It is
   the body of the anchored popover above. */
.le-layers{max-height:340px;overflow:auto;padding:6px}
.le-layer{display:flex;align-items:center;gap:10px;padding:8px 12px;
  border-radius:var(--md-sys-shape-corner-extra-small);
  cursor:pointer;user-select:none}
.le-layer:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.le-layer.is-selected{background:var(--md-sys-color-secondary-container);
  color:var(--md-sys-color-on-secondary-container)}
.le-layer-grip{flex:0 0 auto;color:var(--faint);cursor:grab;letter-spacing:-2px;
  font-size:14px;touch-action:none;padding:0 2px}
.le-layer-name{flex:1;min-width:0;
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Per-widget options, shown under the stage when a widget is selected. */
.le-config{margin-top:16px;border:1px solid var(--rule);border-radius:10px;
  padding:16px 18px;background:var(--panel)}
.le-config>.kick{margin-bottom:12px}
.le-cfg-field{display:block;margin:12px 0 0}
.le-cfg-field>span{display:block;
  font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-on-surface-variant);margin-bottom:6px}
.le-cfg-field select,.le-cfg-field input[type=number]{width:auto;min-width:9rem}
.le-cfg-field textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;
  border:1px solid var(--rule);border-radius:8px;background:var(--panel2);color:var(--ink);
  resize:vertical;line-height:1.4}
.le-cfg-checks{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:2px}
.le-cfg-check{display:inline-flex;align-items:center;gap:.55rem;font-size:14px;
  color:var(--md-sys-color-on-surface);cursor:pointer;margin:0}
.le-cfg-btns{display:flex;gap:8px}
.le-cfg-btn{position:relative;margin:0;height:32px;padding:0 16px;
  border:1px solid var(--md-sys-color-outline);border-radius:var(--md-sys-shape-corner-full);
  background:transparent;color:var(--md-sys-color-primary);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);cursor:pointer}
.le-cfg-btn::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,48px);
  height:48px;transform:translate(-50%,-50%)}
.le-cfg-btn:hover{background:color-mix(in srgb,
  var(--md-sys-color-primary) var(--md-sys-state-hover-state-layer-opacity),transparent)}

/* ---- Home Assistant entity picker (first-party JS) ----------------------- */
#ha-entity-picker{margin-top:.6rem}
.hep-search{width:100%;margin-bottom:12px}
.hep-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
/* M3 filter chips: 32px, small corner, outlined at rest; selected fills with
 * secondary-container and gains a drawn leading check. The pointer target is
 * stretched to 48px tall by a pseudo-element. */
.hep-chip{position:relative;margin:0;height:32px;display:inline-flex;align-items:center;
  gap:8px;padding:0 16px;border-radius:var(--md-sys-shape-corner-small);
  border:1px solid var(--md-sys-color-outline);
  background:transparent;color:var(--md-sys-color-on-surface-variant);
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);cursor:pointer}
.hep-chip::after{content:"";position:absolute;left:0;right:0;top:50%;height:48px;
  transform:translateY(-50%)}
.hep-chip:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent);
  color:var(--md-sys-color-on-surface)}
.hep-chip.active{background:var(--md-sys-color-secondary-container);border-color:transparent;
  color:var(--md-sys-color-on-secondary-container)}
.hep-chip.active::before{content:"";width:9px;height:5px;margin-top:-3px;flex:0 0 auto;
  border-left:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:rotate(-45deg)}
.hep-chip.active:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-secondary-container) var(--md-sys-state-hover-state-layer-opacity),
  var(--md-sys-color-secondary-container))}
.hep-selected{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;min-height:1.4rem}
/* M3 input chips: outlined, 32px, a trailing remove icon button whose pointer
 * target is 48px even though the visual glyph is 18px. */
.hep-pill{display:inline-flex;align-items:center;gap:.4rem;height:32px;
  padding:0 6px 0 12px;border-radius:var(--md-sys-shape-corner-small);
  background:transparent;border:1px solid var(--md-sys-color-outline);
  color:var(--md-sys-color-on-surface);font-size:var(--md-sys-typescale-label-large-size)}
.hep-pill-x{position:relative;margin:0;padding:0;width:18px;height:18px;
  display:grid;place-items:center;border:0;border-radius:var(--md-sys-shape-corner-full);
  background:transparent;color:var(--md-sys-color-on-surface-variant);
  cursor:pointer;font-size:14px;line-height:1}
.hep-pill-x::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.hep-pill-x:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent);
  color:var(--md-sys-color-on-surface)}
.hep-list{border:1px solid var(--rule);border-radius:8px;background:var(--panel2);
  max-height:22rem;overflow-y:auto}
.hep-row{display:flex;align-items:center;gap:12px;padding:.6rem .8rem;cursor:pointer;
  border-top:1px solid var(--ruleSoft);margin:0}
.hep-row:first-child{border-top:0}
.hep-row:hover{background:var(--panel)}
/* The row's checkbox takes the shared M3 checkbox styling above. */
.hep-main{flex:1;min-width:0}
.hep-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hep-id{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hep-state{font-family:var(--mono);font-size:12.5px;color:var(--muted);flex:0 0 auto;
  max-width:10rem;overflow:hidden;text-overflow:ellipsis;text-align:right}
.hep-footer{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px;margin-top:14px}
.hep-field{display:flex;flex-direction:column;gap:6px;margin:0}
.hep-field>span{
  font:var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size)/var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  letter-spacing:var(--md-sys-typescale-label-medium-tracking);
  color:var(--md-sys-color-on-surface-variant)}
.hep-field select,.hep-field input{width:auto;min-width:14rem}
.hep-footer .btn-primary{margin-top:0}
.hep-status{font-family:var(--mono);font-size:12.5px;color:var(--faint)}
.hep-status.is-error{color:var(--danger)}

/* ---- Template gallery (RFC 005) — blueprint cards ----------------------- */
.tpl-cat{
  font:var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size)/var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
  letter-spacing:var(--md-sys-typescale-title-small-tracking);
  color:var(--md-sys-color-on-surface-variant);margin:26px 0 14px}
.tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:22px}
/* Template cards are standard elevated cards now — the blueprint line-drawing
 * treatment retired with the rest of that identity. */
.tpl-card{position:relative;display:flex;flex-direction:column;gap:14px;
  background:var(--surface-elevation-1);box-shadow:var(--md-sys-elevation-level1);
  border-radius:var(--md-sys-shape-corner-medium);padding:16px}
.tpl-thumb{position:relative;width:100%;aspect-ratio:3/4;background:var(--panel2);
  overflow:hidden;border-radius:var(--md-sys-shape-corner-small);
  display:flex;align-items:center;justify-content:center}
.tpl-thumb .tpl-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  padding:12px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--faint)}
.tpl-body{padding:0;display:flex;flex-direction:column;gap:8px;flex:1}
.tpl-name{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking)}
.tpl-blurb{font-size:13.5px;color:var(--muted);line-height:1.45;flex:1;margin:0}
.tpl-card form{margin:0}
.tpl-card .btn-sm{align-self:flex-start;margin-top:2px}
.tpl-copy{margin-top:34px;padding-top:22px;border-top:1px solid var(--rule)}
.tpl-copy .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}

/* ---- Display editor: two-pane shell, tabs, sticky save bar -------------- */
.disp-editor{padding-bottom:72px}
.disp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;
  flex-wrap:wrap;margin:0 0 20px}
.disp-head .link{margin-top:2px}
.disp-status{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.disp-status .seen{display:flex;align-items:center;gap:9px}
.disp-status .seen .who{line-height:1.15}
.disp-status .seen b{font:var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size)/var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
  letter-spacing:var(--md-sys-typescale-title-small-tracking);display:block}
.disp-status .seen small{font-size:12px;color:var(--faint)}
.disp-status form{margin:0}
.disp-panes{display:grid;grid-template-columns:minmax(480px,1.7fr) minmax(320px,0.9fr);
  gap:26px;align-items:start}
/* The preview stays in view while the settings pane scrolls — the whole point. */
.disp-left{position:sticky;top:96px;min-width:0}
.disp-right{min-width:0}
.disp-cap{font-size:12px;color:var(--faint);margin:10px 0 0;text-align:right}
.settings-head{font:var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size)/var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
  letter-spacing:var(--md-sys-typescale-title-large-tracking);margin:0 0 12px}
/* M3 primary tabs: 48px, label-large mixed case, a 3px primary indicator with
 * rounded top corners on the active one. */
.tabbar{display:flex;gap:0;border-bottom:1px solid var(--md-sys-color-outline-variant);
  margin:0 0 18px}
.tab{position:relative;margin:0;height:48px;padding:0 16px;background:none;border:0;
  border-radius:0;
  font-family:var(--md-sys-typescale-label-large-font);
  font-size:var(--md-sys-typescale-label-large-size);
  font-weight:var(--md-sys-typescale-label-large-weight);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  color:var(--md-sys-color-on-surface-variant);cursor:pointer}
.tab:hover{color:var(--md-sys-color-on-surface);background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-hover-state-layer-opacity),transparent)}
.tab:active{background:color-mix(in srgb,
  var(--md-sys-color-on-surface) var(--md-sys-state-pressed-state-layer-opacity),transparent)}
.tab.is-on{color:var(--md-sys-color-primary)}
.tab.is-on::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;
  border-radius:3px 3px 0 0;background:var(--md-sys-color-primary)}
.tabpanel[hidden]{display:none}
.tabpanel>form,.disp-right form{margin:0}
.tabpanel .two-up{display:grid;grid-template-columns:1fr 1fr;gap:14px}
/* A single-line hint replaces the old multi-line grey prose. */
.hint-1{font-size:12.5px;color:var(--faint);margin:.5rem 0 0;line-height:1.5}
/* The "?" help affordance and its popover, in place of a prose paragraph.
 * (It rides a .field-with-help wrapper now — see the field rules.) */
/* A small icon button; the visual stays 20px, the target is 48px. */
.fieldhelp{position:relative;margin:0;padding:0;width:20px;height:20px;
  display:inline-grid;place-items:center;background:transparent;border:0;
  border-radius:var(--md-sys-shape-corner-full);color:var(--md-sys-color-on-surface-variant);
  cursor:pointer}
.fieldhelp:hover{background:color-mix(in srgb,
  var(--md-sys-color-on-surface-variant) var(--md-sys-state-hover-state-layer-opacity),transparent);
  color:var(--md-sys-color-on-surface)}
.fieldhelp::after{content:"";position:absolute;left:50%;top:50%;width:48px;height:48px;
  transform:translate(-50%,-50%)}
.fieldhelp svg{width:16px;height:16px;stroke-width:1.8}
/* A menu surface, like the layers popover. */
.helppop{position:absolute;top:calc(100% + 6px);left:0;z-index:20;width:min(320px,80vw);
  padding:12px 14px;background:var(--md-sys-color-surface-container);
  border-radius:var(--md-sys-shape-corner-extra-small);
  box-shadow:var(--md-sys-elevation-level2);
  font-size:var(--md-sys-typescale-body-small-size);line-height:1.5;
  color:var(--md-sys-color-on-surface-variant);
  text-transform:none;font-weight:400;letter-spacing:0}
.helppop[hidden]{display:none}
.helppop p{margin:.35rem 0}
.helppop p:first-child{margin-top:0}
/* One sticky save bar for the whole page — layout and settings save together.
 * The M3 bottom-bar shape it already had, on a solid container colour now:
 * left clears the 280px drawer and follows it through the collapse. */
.savebar{position:fixed;left:280px;right:0;bottom:0;z-index:20;display:flex;align-items:center;
  justify-content:flex-end;gap:16px;padding:12px 28px;
  background:var(--md-sys-color-surface-container)}
.savebar-flag{
  font:var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size)/var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
  letter-spacing:var(--md-sys-typescale-label-large-tracking);
  color:var(--md-custom-color-warning)}
.savebar-flag[hidden]{display:none}
.savebar .msg{
  font-size:var(--md-sys-typescale-body-medium-size);
  line-height:var(--md-sys-typescale-body-medium-line-height);
  color:var(--md-sys-color-error)}
.savebar button{margin:0}
/* The editor's two panes need ~830px of content; with the 280px drawer that
 * is a ~1160px viewport, so they stack below it — earlier than the shell's
 * own 900px collapse, which is where the savebar stops clearing the drawer. */
@media(max-width:1160px){
  .disp-panes{grid-template-columns:1fr}
  .disp-left{position:static}
  .tabpanel .two-up{grid-template-columns:1fr}
}
@media(max-width:900px){
  .savebar{left:0;padding:12px 20px}
}

/* ---- Focus: the M3 ring, keyboard-driven ---------------------------------
 * One treatment for every control: a 3px primary ring offset outward, drawn
 * only for keyboard focus (:focus-visible). Text fields are the exception the
 * spec makes — their focus is the outline thickening to 2px primary, and the
 * .field rules above suppress this ring inside one. The theme-picker cards
 * hide their real radio, so the ring goes on the card via :has(). */
:is(button,.btn,.walls a,.le-tool-link,.nav-item,input,select,textarea):focus-visible{
  outline:3px solid var(--md-sys-color-primary);outline-offset:2px}
.themecard:has(input:focus-visible){outline:3px solid var(--md-sys-color-primary);
  outline-offset:2px}
`;

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
 * The handful of line icons the admin uses, inlined and first-party.
 *
 * Rule three keeps the served HTML free of a third-party origin, so nothing is
 * fetched from lucide.dev — the paths are copied in, drawn at 1.6 stroke to
 * match the sidebar. Each entry is the inner markup; `icon()` wraps it.
 */
const ICON_PATHS: Readonly<Record<string, string>> = {
  overview:
    `<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/>` +
    `<rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>`,
  calendars: `<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>`,
  shifts:
    `<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M21 3v5h-5M3 21v-5h5"/>`,
  alerts: `<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19z"/>`,
  homeassistant: `<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>`,
  screens: `<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  layout: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>`,
  display:
    `<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--panel2)"/>` +
    `<circle cx="15" cy="12" r="2" fill="var(--panel2)"/><circle cx="8" cy="18" r="2" fill="var(--panel2)"/>`,
  people:
    `<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 5.5M21 20a6 6 0 0 0-4-5.6"/>`,
  system: `<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>`,
  palette:
    `<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/>` +
    `<circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/>` +
    `<path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h1a5 5 0 0 0 5-5 10 10 0 0 0-10-7z"/>`,
  arrow: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
  logout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`,
  addons: `<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>`,
  // A generic installed-module glyph: a tile within a tile. Distinct from the
  // storefront cube so a module entry does not read as another Store link.
  module: `<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>`,
  // The layout-editor / settings chrome glyphs. Same 24×24 stroke family.
  plus: `<path d="M12 5v14M5 12h14"/>`,
  layers: `<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>`,
  grip: `<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.8 2.8 0 0 1 5.5.8c0 1.9-2.7 2.4-2.7 4"/><path d="M12 17h.01"/>`,
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

/** An inline line icon by key, at a size the caller controls with CSS. */
export function icon(key: string): string {
  const inner = ICON_PATHS[key];
  if (inner === undefined) return '';
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
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

/** The Overview item sits above the groups, in none of them. */
const OVERVIEW: NavItem = { key: 'home', label: 'Overview', href: 'admin', icon: 'overview' };

const GROUPS: readonly { readonly key: string; readonly label: string; readonly items: readonly NavItem[] }[] = [
  {
    key: 'modules',
    label: 'Modules',
    items: [
      { key: 'calendars', label: 'Calendars', href: 'admin/calendars', icon: 'calendars' },
      { key: 'shifts', label: 'Work Schedule', href: 'admin/shifts', icon: 'shifts' },
      { key: 'alerts', label: 'Weather', href: 'admin/alerts', icon: 'alerts' },
      { key: 'homeassistant', label: 'Home Assistant', href: 'admin/home-assistant', icon: 'homeassistant' },
      { key: 'modules', label: 'Store', href: 'admin/modules', icon: 'addons' },
    ],
  },
  {
    key: 'walls',
    label: 'Walls',
    items: [
      // Screens (pairing) and Layout were two sections for one thing; a display
      // is now a single place — its status, pairing, settings and layout.
      { key: 'displays', label: 'Displays', href: 'admin/displays', icon: 'screens' },
      // The e-paper panels are their own kind — server-rendered, pulled by a
      // device or pushed by Home Assistant — so they get one door of their own
      // rather than sitting in the browser-wall list (RFC 006).
      { key: 'epaper', label: 'eInk Displays', href: 'admin/epaper', icon: 'screens' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    items: [
      // The old global "Display" page is gone: appearance and layout are now
      // per wall (the Default included), on the Displays screen. What is left
      // here is the household's own themes, its people, and the box's
      // housekeeping.
      { key: 'themes', label: 'Themes', href: 'admin/themes', icon: 'palette' },
      { key: 'people', label: 'People', href: 'admin/people', icon: 'people' },
      { key: 'system', label: 'System', href: 'admin/system', icon: 'system' },
    ],
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
    if (g.key === 'modules' && modules.length > 0 && store !== undefined) {
      // Built-ins, then one entry per installed module, then the Store — which
      // is the last item in the group by construction.
      const builtins = g.items.slice(0, -1).map(item).join('');
      body = builtins + modules.map(moduleItem).join('') + item(store);
    } else {
      body = g.items.map(item).join('');
    }
    return `<div class="nav-group"><span>${escapeHtml(g.label)}</span>${body}</div>`;
  }).join('');

  return `<nav class="nav" aria-label="Admin">${item(OVERVIEW)}${groups}</nav>`;
}

export interface PageOptions {
  readonly title: string;
  /** Rendered above the heading in the wizard, e.g. "Step 2 of 3". */
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
   * The installed modules to list in the sidebar's Modules group. Read live per
   * request (see `navModules` in `admin.ts`) and passed in, because this file
   * never touches the database. Absent on the wizard/sign-in, which have no
   * sidebar; empty is fine and just draws the built-in modules and the Store.
   */
  readonly modules?: readonly NavModule[];
  /** Already-escaped markup. */
  readonly body: string;
}

/**
 * The wizard's three-step progress bar, derived from a "Step N of 3" string.
 *
 * The wizard is always Account → Timezone → Calendar, so the labels are fixed;
 * a total other than three just draws unlabelled bars rather than guessing.
 */
function stepProgress(step: string): string {
  const match = /Step\s+(\d+)\s+of\s+(\d+)/i.exec(step);
  if (match === null) return `<p class="kick" style="margin-bottom:22px">${escapeHtml(step)}</p>`;
  const current = Number(match[1]);
  const total = Number(match[2]);
  const labels = total === 3 ? ['Account', 'Timezone', 'Calendar'] : [];
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

function head(title: string): string {
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
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style>${THEME_SCRIPT}</head>`
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
    head(options.title) +
    `<body class="shell">` +
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
    `<main class="main">` +
    `<header class="topbar"><div>` +
    `<div class="crumb">${escapeHtml(groupLabelFor(options.nav))}</div>` +
    `<h1>${escapeHtml(options.heading)}</h1>` +
    `</div>${action}</header>` +
    // The intro leads the content now, not the sticky bar — one lead line kept
    // out of the permanent header so the bar stays compact.
    `<div class="content">` +
    (options.intro === undefined ? '' : `<p class="note">${escapeHtml(options.intro)}</p>`) +
    options.body +
    `</div>` +
    `</main></body></html>`
  );
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
 * The M3 outlined text field, shared by every server-rendered form.
 *
 * One construction — a wrapping <label class="field"> holding the input and a
 * three-segment outline whose notch carries the floating label — so the CSS in
 * STYLE can do the whole floating-label dance with no script: inputs get
 * placeholder=" " when the caller supplies none, which is what lets
 * :placeholder-shown tell an empty field from a server-prefilled one. Controls
 * that always render content (select, time, number, color, file, textarea)
 * are stamped .field-static and keep the label floated permanently.
 */

export interface TextFieldOptions {
  readonly label: string;
  readonly name: string;
  /** The input type. Text-like by default; some types force the floated label. */
  readonly type?: string;
  readonly value?: string;
  /** A real placeholder — hidden until the label floats away on focus. */
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

/** Input types whose box always renders content, so the label never rests. */
const STATIC_TYPES = new Set(['number', 'time', 'date', 'color', 'file']);

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
    control +
    `<span class="field-outline"><i class="fo-start"></i>` +
    `<i class="fo-notch"><span class="field-label">${escapeHtml(options.label)}</span></i>` +
    `<i class="fo-end"></i></span>` +
    `</label>` +
    support
  );
}

export function textField(options: TextFieldOptions): string {
  const type = options.type ?? 'text';
  const isStatic = STATIC_TYPES.has(type);
  const control =
    `<input class="field-input" type="${escapeHtml(type)}" name="${escapeHtml(options.name)}"` +
    (options.value === undefined ? '' : ` value="${escapeHtml(options.value)}"`) +
    ` placeholder="${options.placeholder === undefined ? ' ' : escapeHtml(options.placeholder)}"` +
    (options.required === true ? ' required' : '') +
    (options.attrs === undefined ? '' : ` ${options.attrs}`) +
    `>`;
  return fieldWrap(control, options, isStatic ? ' field-static' : '');
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
  return fieldWrap(control, options, ' field-static field-select');
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
  return fieldWrap(control, options, ' field-static');
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
