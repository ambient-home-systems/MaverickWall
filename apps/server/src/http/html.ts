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
`;

export interface PageOptions {
  readonly title: string;
  /** Rendered above the heading, e.g. "Step 2 of 3". */
  readonly step?: string;
  readonly heading: string;
  readonly intro?: string;
  /** Already-escaped markup. */
  readonly body: string;
}

export function page(options: PageOptions): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(options.title)}</title><style>${STYLE}</style></head><body><main>` +
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
