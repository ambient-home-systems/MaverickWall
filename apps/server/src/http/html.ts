/**
 * Server-rendered pages.
 *
 * The wizard and the sign-in form are plain HTML with no script and no build
 * step, because they are the screens that must work before anything else does.
 * A bundle that fails to build or fails to load would otherwise take the only
 * route into the application down with it.
 *
 * Rule three still applies: nothing here loads a font, a stylesheet or an image
 * from anywhere. The styles are inline and the palette is Board's, so the setup
 * flow looks like the wall it is configuring.
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

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0B0E11;color:#E9EEF4;
  font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  display:flex;justify-content:center;padding:2rem 1rem}
main{width:100%;max-width:34rem}
.brand{display:flex;align-items:center;gap:.6rem;margin:0 0 1rem;
  font-weight:700;font-size:1.05rem;letter-spacing:.01em;text-decoration:none}
a.brand{cursor:pointer}
.brand svg{width:30px;height:30px;flex:0 0 auto;border-radius:7px}
.brand span{color:#E9EEF4}
/* The section tabs: wrap rather than scroll, so every one is reachable at any
   width — a narrow phone shows three rows, a wide panel shows one. */
.tabs{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1.6rem;
  border-bottom:1px solid #1E262F;padding-bottom:.8rem}
.tabs a{padding:.35rem .7rem;border-radius:.4rem;font-size:.9rem;font-weight:600;
  color:#A8B3C0;text-decoration:none;white-space:nowrap;border:1px solid transparent}
.tabs a:hover{color:#E9EEF4;background:#141A21}
.tabs a.active{color:#1A1206;background:#E0A33E}
h1{font-size:1.5rem;margin:0 0 .25rem}
p{color:#A8B3C0;margin:.5rem 0}
form{margin:1.5rem 0 0}
label{display:block;margin:1rem 0 .25rem;font-weight:600;font-size:.95rem}
input[type=text],input[type=email],input[type=password],input[type=number],
input[type=time],select{
  width:100%;padding:.6rem .7rem;border-radius:.4rem;border:1px solid #2A333D;
  background:#141A21;color:#E9EEF4;font-size:1rem}
input:focus,select:focus{outline:2px solid #E0A33E;outline-offset:1px}
button{margin-top:1.5rem;padding:.65rem 1.2rem;border-radius:.4rem;border:0;
  background:#E0A33E;color:#1A1206;font-weight:700;font-size:1rem;cursor:pointer}
button.secondary{background:transparent;color:#A8B3C0;border:1px solid #2A333D;
  margin-left:.5rem}
.checks{margin-top:1rem}
.checks label{display:flex;gap:.5rem;align-items:center;font-weight:400;
  color:#A8B3C0;margin:.5rem 0}
.checks input{width:auto}
.error{border-left:3px solid #D9544F;background:#1B1416;padding:.75rem 1rem;
  border-radius:.3rem;margin:1rem 0}
.error strong{color:#F0918D;display:block}
.error span{color:#C8B3B3;font-size:.95rem}
.steps{color:#6D7A88;font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;
  margin:0 0 1rem}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05rem;
  letter-spacing:.12em;background:#141A21;padding:.15rem .4rem;border-radius:.25rem;
  color:#E0A33E}
a.link{color:#E0A33E}
.card{background:#111820;border:1px solid #1F2833;border-radius:.5rem;
  padding:1rem 1.1rem;margin:1rem 0}
.card h2{font-size:1.1rem;margin:0}
.card p{margin:.35rem 0}
.card .host{color:#6D7A88;font-size:.9rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
.row form{margin:.75rem 0 0}
.row button{margin-top:0}
.row button.secondary{margin-left:0}
h2.add{font-size:1.1rem;margin:2rem 0 0;padding-top:1.5rem;
  border-top:1px solid #1F2833}
p.hint{font-size:.85rem;color:#6D7A88;margin:.3rem 0 0}
img.avatar{width:1.6rem;height:1.6rem;border-radius:50%;object-fit:cover;
  margin-right:.5rem;vertical-align:-.35rem;background:#141A21}
.swatch{display:inline-block;width:.8rem;height:.8rem;border-radius:.2rem;
  background:var(--swatch);margin-right:.5rem;vertical-align:baseline}
input[type=color]{width:100%;height:2.6rem;padding:.2rem;border-radius:.4rem;
  border:1px solid #2A333D;background:#141A21}
.preview{border:1px solid #1F2833;border-radius:.5rem;padding:1rem 1.1rem;margin:1rem 0;
  background:#0E141A}
.preview h3{font-size:1rem;margin:0 0 .5rem}
.preview ul{list-style:none;margin:.5rem 0 0}
.preview li{display:flex;gap:.75rem;padding:.3rem 0;font-size:.95rem;
  border-top:1px solid #161D25}
.preview li:first-child{border-top:0}
.preview .when{color:#6D7A88;flex:0 0 11rem;font-variant-numeric:tabular-nums}
.preview .warn{color:#D9A13E;font-size:.9rem;margin-top:.6rem}
ul.plain{margin:.6rem 0 .6rem 1.1rem;color:#A8B3C0}
ul.plain li{margin:.45rem 0}
ul.plain strong{color:#E9EEF4}
pre.log{background:#0B1015;border:1px solid #1F2833;border-radius:.4rem;padding:.8rem;
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#A8B3C0;
  max-height:22rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
input[type=file]{width:100%;padding:.5rem;border-radius:.4rem;border:1px solid #2A333D;
  background:#141A21;color:#A8B3C0;font-size:.95rem}
.qr{background:#fff;padding:.8rem;border-radius:.5rem;display:inline-block;margin:.5rem 0}
.qr svg{display:block}
.slots{display:flex;flex-wrap:wrap;gap:.5rem}
.slots span{flex:0 0 6.2rem}
.slots label{margin:.4rem 0 .2rem;font-size:.8rem;color:#6D7A88;font-weight:400}
.slots select{padding:.4rem .3rem;font-size:.9rem}
.title-cell{display:flex;align-items:center;font-weight:600;min-width:0;
  overflow-wrap:anywhere}
.pv-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:.3rem;margin-top:.6rem}
.pv-cell{background:#18202A;border-radius:.3rem;padding:.4rem .3rem;text-align:center;
  border-top:.18rem solid #E0A33E}
.pv-cell.pv-off{border-top-color:#35916A;background:#141C1A}
.pv-cell.pv-unknown{border-top-color:#2A333D;background:#101519;opacity:.6}
.pv-dow{display:block;font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;
  color:#6D7A88}
.pv-num{display:block;font-size:1rem;font-weight:700}
.pv-code{display:block;font-size:.8rem;font-weight:700;color:#E0A33E}
.pv-off .pv-code{color:#35916A}
.pv-unknown .pv-code{color:#4A5563}
.row-fields{display:flex;gap:1rem}
.row-fields span{flex:1 1 0}

/* Layout editor */
.le-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:1rem 0}
.le-toggle{display:inline-flex;align-items:center;gap:.4rem;font-size:.95rem}
.le-aspect{padding:.4rem .5rem;background:#141C24;color:#E9EEF4;border:1px solid #2A333D;
  border-radius:.4rem}
.le-palette{display:flex;flex-wrap:wrap;gap:.4rem}
.le-add{padding:.4rem .7rem;background:#18202A;color:#E9EEF4;border:1px solid #2A333D;
  border-radius:.4rem;cursor:pointer;font-size:.9rem}
.le-add:hover{border-color:#35916A}
.le-delete{padding:.4rem .7rem;background:transparent;color:#C98A8A;border:1px solid #4A2E2E;
  border-radius:.4rem;cursor:pointer}
.le-delete:disabled{opacity:.4;cursor:default}
.le-save{padding:.45rem 1.1rem;background:#35916A;color:#fff;border:0;border-radius:.4rem;
  cursor:pointer;font-weight:600}
.le-status{font-size:.85rem;color:#6D7A88}
.le-status.is-dirty{color:#E0A33E}
.le-status.is-ok{color:#35916A}
.le-status.is-error{color:#C98A8A}
.le-stage{display:flex;justify-content:center;padding:1rem;background:#0E141A;
  border:1px solid #1E262F;border-radius:.6rem}
/* The wall's fraction space: the live preview fills it, widgets are placed in %. */
.le-canvas{position:relative;background:#161d25;border-radius:.5rem;overflow:hidden;
  box-shadow:inset 0 0 0 1px #232c36;touch-action:none}
/* The live preview, behind the overlay and never taking a pointer. */
.le-preview{position:absolute;inset:0;z-index:0;pointer-events:none}
.le-preview .preview-wall{overflow:hidden}
/* The interaction layer, above the preview. */
.le-overlay{position:absolute;inset:0;z-index:1}
/* A widget box: a translucent frame over the live content, not a solid tile. */
.le-widget{position:absolute;background:rgba(53,145,106,.10);border:1px solid rgba(53,145,106,.7);
  border-radius:.35rem;cursor:move;touch-action:none;overflow:hidden;user-select:none}
.le-widget:hover{background:rgba(53,145,106,.18)}
.le-widget.is-selected{border-color:#E0A33E;box-shadow:0 0 0 2px rgba(224,163,62,.45);
  background:rgba(224,163,62,.10)}
/* The type name as a small chip in the corner, so it never hides the content. */
.le-widget-label{position:absolute;top:0;left:0;font-size:.68rem;color:#0B0E11;
  background:rgba(53,145,106,.9);padding:.05rem .35rem;border-radius:0 0 .3rem 0;
  pointer-events:none;user-select:none}
.le-widget.is-selected .le-widget-label{background:#E0A33E}
.le-handle{position:absolute;right:0;bottom:0;width:16px;height:16px;background:#E0A33E;
  border-radius:.35rem 0 .35rem 0;cursor:se-resize;touch-action:none}
`;

/**
 * The brand mark, inline and first-party.
 *
 * The zoom-pyramid the product is built around — today, the next days, the
 * month with one cell lit — the same shape as the add-on icon. Inlined rather
 * than fetched: rule three keeps the served HTML free of a third-party origin,
 * and a data-URI favicon and one `<svg>` need no network at all. Flat fills, no
 * gradient, so it stays crisp in a favicon and small in the markup.
 */
const MARK =
  `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  `<rect width="512" height="512" rx="108" fill="#12181f"/>` +
  `<rect x="96" y="112" width="320" height="118" rx="22" fill="#E0A33E"/>` +
  `<rect x="96" y="252" width="150" height="58" rx="15" fill="#2c3a47"/>` +
  `<rect x="266" y="252" width="150" height="58" rx="15" fill="#2c3a47"/>` +
  `<rect x="96" y="332" width="40" height="52" rx="9" fill="#26323d"/>` +
  `<rect x="152" y="332" width="40" height="52" rx="9" fill="#26323d"/>` +
  `<rect x="208" y="332" width="40" height="52" rx="9" fill="#26323d"/>` +
  `<rect x="264" y="332" width="40" height="52" rx="9" fill="#E0A33E"/>` +
  `<rect x="320" y="332" width="40" height="52" rx="9" fill="#26323d"/>` +
  `<rect x="376" y="332" width="40" height="52" rx="9" fill="#26323d"/>` +
  `</svg>`;

/** The mark as a favicon. Same bytes, URL-encoded into a data URI. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(MARK)}`;

/**
 * The admin sections, in the order they tab across the top.
 *
 * Calendar first, because the calendar is the product; the two panel modules
 * (Home Assistant, Weather) sit together before System, which is the box's own
 * housekeeping. `href` is relative so the `<base>` handles ingress.
 */
const NAV: readonly { readonly key: string; readonly label: string; readonly href: string }[] = [
  { key: 'calendars', label: 'Calendars', href: 'admin/calendars' },
  { key: 'display', label: 'Display', href: 'admin/display' },
  { key: 'layout', label: 'Layout', href: 'admin/layout' },
  { key: 'people', label: 'People', href: 'admin/people' },
  { key: 'shifts', label: 'Shifts', href: 'admin/shifts' },
  { key: 'screens', label: 'Screens', href: 'admin/screens' },
  { key: 'homeassistant', label: 'Home Assistant', href: 'admin/home-assistant' },
  { key: 'alerts', label: 'Weather', href: 'admin/alerts' },
  { key: 'system', label: 'System', href: 'admin/system' },
];

/** The tab bar, with the current section marked. Empty off the admin pages. */
function navBar(active: string | undefined): string {
  if (active === undefined) return '';
  return (
    `<nav class="tabs" aria-label="Sections">` +
    NAV.map(
      (section) =>
        `<a href="${section.href}"${section.key === active ? ' class="active" aria-current="page"' : ''}>` +
        `${escapeHtml(section.label)}</a>`,
    ).join('') +
    `</nav>`
  );
}

export interface PageOptions {
  readonly title: string;
  /** Rendered above the heading, e.g. "Step 2 of 3". */
  readonly step?: string;
  readonly heading: string;
  readonly intro?: string;
  /**
   * The current admin section, e.g. `screens` — draws the tab bar with it
   * marked. Absent on the wizard and sign-in, which have no sections to tab
   * between; a key no tab matches (the overview) draws the bar with none lit.
   */
  readonly nav?: string;
  /** Already-escaped markup. */
  readonly body: string;
}

export function page(options: PageOptions): string {
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
    `<title>${escapeHtml(options.title)}</title><style>${STYLE}</style></head><body><main>` +
    // The masthead: identity on every page. A link home where there is a home
    // to go to — the admin — and plain text on the wizard, which has none yet.
    (options.nav === undefined
      ? `<header class="brand">${MARK}<span>Maverick Wall</span></header>`
      : `<a class="brand" href="admin">${MARK}<span>Maverick Wall</span></a>`) +
    navBar(options.nav) +
    (options.step === undefined ? '' : `<p class="steps">${escapeHtml(options.step)}</p>`) +
    `<h1>${escapeHtml(options.heading)}</h1>` +
    (options.intro === undefined ? '' : `<p>${escapeHtml(options.intro)}</p>`) +
    options.body +
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
