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
/*
 * Self-hosted, first-party, no network. Rule three forbids fetching a web font,
 * so Roboto Condensed ships in the image and is served same-origin. The src is
 * relative, so the single <base> carries it through Home Assistant ingress; the
 * file is a variable font covering the 400-700 weight axis, so one file gives
 * the whole range. font-display:swap means a missing file just falls back to
 * Arial Narrow rather than blocking the page.
 */
@font-face{font-family:'Roboto Condensed';font-style:normal;font-weight:400 700;
  font-display:swap;src:url('assets/fonts/roboto-condensed.woff2') format('woff2')}

/*
 * Dark by default — the Board palette, the wall's own — with a light option and
 * an "auto" that follows the device. The choice is per-browser (localStorage,
 * applied by a tiny inline script before first paint, so there is no flash) and
 * only ever styles the admin, never the wall. color-mix() and either scheme are
 * fine here: this is a phone or a desktop, not the locked-down tablet rule two
 * is about. Every colour is a token, so a theme is just a different set of them.
 */
:root{
  --cond:'Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif;
  --sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
/* Dark (the default). Lifted a notch off near-black so cards read as panels and
 * the rules are visible without hunting — this is a phone/desktop admin, not the
 * glare-free wall, so it can afford more contrast than display.css does. */
:root{
  color-scheme:dark;
  --bg:#14181E;--panel:#1B212A;--panel2:#171C24;--rule:#2A333F;--ruleSoft:#20272F;
  --ink:#E9EEF4;--muted:#9BA7B4;--faint:#68727E;--accent:#E0A33E;--accentInk:#1A1206;
  --ok:#35916A;--warn:#D9A13E;--danger:#D9544F;--night:#4C7FD1;
}
/* Light, when the household picks it. */
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#F4F2EC;--panel:#FFFFFF;--panel2:#F8F6F0;--rule:#E3DFD5;--ruleSoft:#EDEAE2;
  --ink:#1A1C20;--muted:#54585E;--faint:#8A9098;--accent:#B07912;--accentInk:#FFFFFF;
  --ok:#2E7D53;--warn:#B5820F;--danger:#C0392B;--night:#2F5D8C;
}
/* Auto: no explicit choice, and the device prefers light. */
@media (prefers-color-scheme: light){
  :root:not([data-theme]){
    color-scheme:light;
    --bg:#F4F2EC;--panel:#FFFFFF;--panel2:#F8F6F0;--rule:#E3DFD5;--ruleSoft:#EDEAE2;
    --ink:#1A1C20;--muted:#54585E;--faint:#8A9098;--accent:#B07912;--accentInk:#FFFFFF;
    --ok:#2E7D53;--warn:#B5820F;--danger:#C0392B;--night:#2F5D8C;
  }
}
*{box-sizing:border-box}
*::selection{background:color-mix(in srgb,var(--accent) 32%,transparent)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:14px;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}

/* ---- App shell: fixed sidebar, scrolling main ---------------------------- */
body.shell{display:grid;grid-template-columns:216px 1fr;min-height:100vh}
.side{border-right:1px solid var(--rule);background:var(--panel2);
  display:flex;flex-direction:column;min-height:100vh;position:sticky;top:0;
  max-height:100vh;overflow:hidden}
.side .brand{display:flex;align-items:center;gap:11px;padding:20px 20px 16px;
  text-decoration:none;color:inherit}
.side .brand svg{width:34px;height:34px;flex:0 0 auto;border-radius:8px}
.side .brand b{font-family:var(--cond);font-weight:700;font-size:19px;
  letter-spacing:.02em;line-height:1;display:block}
.side .brand small{display:block;color:var(--faint);font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;margin-top:3px}
.nav{flex:1;overflow-y:auto;padding:6px 12px 12px}
.nav-group{margin-top:16px}
.nav-group>span{display:block;padding:0 12px 6px;font-family:var(--cond);
  font-weight:600;font-size:11px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--faint)}
.nav-item{display:flex;align-items:center;gap:11px;padding:8px 12px;margin:1px 0;
  border-radius:7px;border:1px solid transparent;color:var(--muted);
  text-decoration:none;font-size:14px;font-weight:500;line-height:1.2}
.nav-item svg{width:18px;height:18px;flex:0 0 auto;stroke-width:1.6}
.nav-item:hover{color:var(--ink);background:var(--panel)}
.nav-item.active{background:var(--accent);color:var(--accentInk);
  border-color:var(--accent);font-weight:600}
/* An installed module's nav entry: a generic module glyph (the row stores no
 * icon) and a small "off" badge when the household has disabled it. */
.nav-item .nav-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-badge{flex:0 0 auto;font-family:var(--cond);font-weight:600;font-size:9.5px;
  letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
  border:1px solid var(--rule);border-radius:4px;padding:1px 5px}
.nav-item.active .nav-badge{color:var(--accentInk);border-color:var(--accentInk)}
.side-foot{border-top:1px solid var(--rule);padding:14px 16px;display:flex;
  flex-direction:column;gap:12px}
.side-foot-id{display:flex;align-items:center;gap:10px}
.side-foot .fmark{width:32px;height:32px;flex:0 0 auto}
.side-foot .fmark svg{width:32px;height:32px;border-radius:7px;display:block}
.side-foot .who{min-width:0;flex:1}
.side-foot .who b{font-size:13px;font-weight:600;display:block;line-height:1.2}
.side-foot .who small{font-size:11px;color:var(--faint)}
.side-foot form{margin:0;flex:0 0 auto}
.signout{margin:0;padding:0;width:32px;height:32px;display:grid;place-items:center;
  background:var(--panel);color:var(--muted);border:1px solid var(--rule);border-radius:7px;cursor:pointer}
.signout:hover{filter:none;color:var(--ink);border-color:var(--faint)}
.signout svg{width:17px;height:17px;stroke-width:1.7}
/* Admin theme toggle. Per-browser; applied before paint by an inline script. */
.themebar{display:flex;border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.themebtn{flex:1;margin:0;padding:.4rem;border:0;border-left:1px solid var(--rule);
  background:var(--panel);color:var(--muted);font-family:inherit;font-size:12px;
  font-weight:600;cursor:pointer}
.themebtn:first-child{border-left:0}
.themebtn:hover{filter:none;color:var(--ink)}
.themebtn[data-active="true"]{background:var(--accent);color:var(--accentInk)}

.main{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:flex-end;
  justify-content:space-between;gap:16px;padding:22px 28px 16px;
  background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(6px);
  border-bottom:1px solid var(--rule)}
.topbar .crumb{font-family:var(--cond);font-weight:600;font-size:11px;
  letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin:0 0 5px}
.topbar h1{font-family:var(--cond);font-weight:700;font-size:25px;line-height:.98;
  letter-spacing:.01em;margin:0}
.content{padding:24px 28px 52px;max-width:1180px;width:100%}
.content>form:first-child,.content>.card:first-child,.content>.note:first-child{margin-top:0}
/* The page's lead line. Used to sit in the topbar as .sub; moved into the
 * content so the sticky bar stays a compact kicker+title and gives ~40px back. */
.note{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 20px;max-width:64ch}

@media(max-width:820px){
  body.shell{grid-template-columns:1fr}
  .side{position:static;min-height:0;max-height:none;flex-direction:row;
    flex-wrap:wrap;align-items:center;border-right:0;border-bottom:1px solid var(--rule)}
  .side .brand{padding:14px 18px}
  .nav{flex:1 1 100%;display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 12px;overflow:visible}
  .nav-group{margin-top:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
  .nav-group>span{display:none}
  .side-foot{display:none}
  .topbar{padding:20px 20px 14px}
  .content{padding:22px 20px 48px}
}

/* ---- Wizard / sign-in: a centred column, no sidebar --------------------- */
body.wiz{display:flex;align-items:flex-start;justify-content:center;
  padding:40px 20px;min-height:100vh}
.wizbox{width:100%;max-width:520px}
.wizbox .brand{display:flex;align-items:center;gap:11px;text-decoration:none;
  color:inherit;margin:0 0 4px}
.wizbox .brand svg{width:34px;height:34px;border-radius:8px}
.wizbox .brand b{font-family:var(--cond);font-weight:700;font-size:19px}
.steps{display:flex;gap:8px;margin:22px 0 26px;padding:0;list-style:none}
.steps .step{flex:1;text-align:center}
.steps .step .bar{height:4px;border-radius:2px;background:var(--rule)}
.steps .step.done .bar,.steps .step.on .bar{background:var(--accent)}
.steps .step span{display:block;margin-top:8px;font-family:var(--cond);
  font-weight:600;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint)}
.steps .step.on span{color:var(--accent)}
.steps .step.done span{color:var(--muted)}
.wizbox .card{margin:0}
.wizbox>form,.wizbox>.error{margin-top:18px}

/* ---- Typography ---------------------------------------------------------- */
h1{font-family:var(--cond);font-weight:700;font-size:30px;line-height:1.02;
  margin:0 0 4px}
p{color:var(--muted);margin:.5rem 0;line-height:1.55}
a.link{color:var(--accent);text-decoration:none;font-weight:600}
a.link:hover{text-decoration:underline}
/* Any inline arrow inside a link (list "Open →", "Manage →") stays small. */
.link{display:inline-flex;align-items:center;gap:4px}
.link svg{width:14px;height:14px;stroke-width:2;flex:0 0 auto}
.kick{font-family:var(--cond);font-weight:600;font-size:11.5px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--faint)}
.code{font-family:var(--mono);font-size:1rem;letter-spacing:.08em;
  background:var(--panel2);padding:.15rem .4rem;border-radius:.25rem;color:var(--accent)}

/* ---- Forms --------------------------------------------------------------- */
form{margin:1.4rem 0 0}
label{display:block;margin:1rem 0 .35rem;font-family:var(--cond);font-weight:600;
  font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
input[type=text],input[type=email],input[type=password],input[type=number],
input[type=time],select,textarea{
  width:100%;padding:.62rem .7rem;border-radius:7px;border:1px solid var(--rule);
  background:var(--panel2);color:var(--ink);font-family:inherit;font-size:14.5px}
textarea{resize:vertical;line-height:1.45}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;
  border-color:transparent}
input[type=color]{width:100%;height:2.6rem;padding:.2rem;border-radius:7px;
  border:1px solid var(--rule);background:var(--panel2)}
input[type=file]{width:100%;padding:.55rem;border-radius:7px;border:1px solid var(--rule);
  background:var(--panel2);color:var(--muted);font-size:.95rem}
.checks{margin-top:1rem}
.checks label{display:flex;gap:.55rem;align-items:center;margin:.55rem 0;
  font-family:var(--sans);font-weight:400;font-size:14px;letter-spacing:0;
  text-transform:none;color:var(--muted);cursor:pointer}
.checks input{width:17px;height:17px;accent-color:var(--accent)}
.row-fields{display:flex;gap:1rem;flex-wrap:wrap}
.row-fields span{flex:1 1 12rem}

/* ---- Buttons ------------------------------------------------------------- */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  margin-top:1.4rem;padding:.62rem 1.1rem;border-radius:7px;border:1px solid var(--accent);
  background:var(--accent);color:var(--accentInk);font-family:inherit;font-size:14px;
  font-weight:700;cursor:pointer;line-height:1;text-decoration:none}
button:hover,.btn:hover{filter:brightness(1.06)}
button svg,.btn svg{width:16px;height:16px;stroke-width:1.8}
button.secondary,.btn-ghost{background:var(--panel);color:var(--ink);
  border-color:var(--rule);font-weight:600}
button.secondary:hover,.btn-ghost:hover{filter:none;border-color:var(--faint)}
.btn-danger{background:var(--panel);color:var(--danger);
  border-color:color-mix(in srgb,var(--danger) 40%,var(--rule))}
.btn-danger:hover{filter:none;background:color-mix(in srgb,var(--danger) 12%,transparent);
  border-color:var(--danger)}
.btn-sm{margin-top:0;padding:.42rem .75rem;font-size:12.5px}
.link-btn{margin-top:0}
/* A scriptless segmented control (Store alerts): buttons in one form, the
 * current one filled. Each posts its own value, so there is no separate Save. */
.seg{display:inline-flex;margin:0;border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.seg button{margin:0;border:0;border-left:1px solid var(--rule);border-radius:0;
  background:var(--panel2);color:var(--muted);font-family:var(--cond);font-weight:600;
  font-size:12.5px;letter-spacing:.02em;padding:.42rem .8rem}
.seg button:first-child{border-left:0}
.seg button:hover{filter:none;color:var(--ink)}
.seg button.on{background:var(--accent);color:var(--accentInk)}

/* ---- Errors and disclaimers (the .error box) ----------------------------- */
.error{border-left:3px solid var(--danger);
  background:color-mix(in srgb,var(--danger) 9%,transparent);
  padding:.8rem 1rem;border-radius:0 6px 6px 0;margin:1rem 0}
.error strong{color:#F0918D;display:block;font-size:14px;margin-bottom:2px}
.error span{color:var(--muted);font-size:13px;line-height:1.5}

/* ---- Cards --------------------------------------------------------------- */
.card{position:relative;background:var(--panel);border:1px solid var(--rule);
  border-radius:8px;padding:16px;margin:1rem 0}
.card h2{font-family:var(--cond);font-weight:700;font-size:18px;margin:0;
  display:flex;align-items:center;gap:.5rem;letter-spacing:.01em}
.card p{margin:.4rem 0}
.card .host,.host{color:var(--faint);font-size:12.5px;font-family:var(--mono);
  margin:.35rem 0}
/* Corner registration marks on feature cards. */
.cm{position:absolute;width:9px;height:9px;color:var(--accent);opacity:.5;pointer-events:none}
.cm::before,.cm::after{content:"";position:absolute;background:currentColor}
.cm::before{left:4px;top:0;width:1px;height:9px}
.cm::after{top:4px;left:0;height:1px;width:9px}
.cm.tl{top:-5px;left:-5px}.cm.tr{top:-5px;right:-5px}
.cm.bl{bottom:-5px;left:-5px}.cm.br{bottom:-5px;right:-5px}

.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.row form{margin:.75rem 0 0}
.row button{margin-top:0}
h2.add{font-family:var(--cond);font-weight:700;font-size:20px;letter-spacing:.01em;
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
.sect-head h2{font-family:var(--cond);font-weight:700;font-size:20px;
  letter-spacing:.01em;margin:0}

/* ---- Stat cards ---------------------------------------------------------- */
a.card{display:block;text-decoration:none;color:inherit;transition:border-color .12s}
a.card:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--rule))}
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
.today-big{font-family:var(--cond);font-weight:700;font-size:26px;margin:6px 0 2px}
.stat .ic{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;
  background:var(--panel2);border:1px solid var(--rule);color:var(--accent)}
.stat .ic svg{width:19px;height:19px;stroke-width:1.6}
.stat .big{font-family:var(--cond);font-weight:700;font-size:30px;line-height:1;
  margin:12px 0 2px}
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
.tag{display:inline-flex;align-items:center;gap:6px;font-family:var(--cond);
  font-weight:600;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;
  padding:3px 9px;border-radius:5px;border:1px solid var(--rule);color:var(--muted)}
.tag-ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.tag-bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent)}
.tag-accent{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;
  background:var(--swatch);flex:0 0 auto;vertical-align:baseline}
img.avatar{width:1.7rem;height:1.7rem;border-radius:50%;object-fit:cover;
  margin-right:.4rem;vertical-align:-.4rem;background:var(--panel2)}

/* ---- Sub-view switcher (per-wall Appearance | Layout) -------------------- */
/* Server-rendered tabs: each is a plain <a> to the same page with a ?view, so
 * there is no client state — the active one is marked when the server draws it. */
.subnav{display:flex;gap:4px;margin:20px 0 22px;border-bottom:1px solid var(--rule)}
.subtab{padding:8px 14px 10px;margin-bottom:-1px;border-bottom:2px solid transparent;
  color:var(--muted);text-decoration:none;font-family:var(--cond);font-weight:600;
  font-size:14px;letter-spacing:.02em}
.subtab:hover{color:var(--ink)}
.subtab.active{color:var(--ink);border-bottom-color:var(--accent)}

/* ---- Store card glyph preview ("screenshot" spelled out in glyphs) -------- */
/* A little inset tile beside the icon, styled like a wall stat panel: a big
 * headline line then a caption or two. First-party glyphs only, no image. */
.cpreview{flex:0 0 auto;width:118px;min-height:64px;display:flex;flex-direction:column;
  justify-content:center;gap:2px;padding:9px 11px;border-radius:8px;
  background:var(--panel2);border:1px solid var(--rule);overflow:hidden}
.cpreview b{font-family:var(--cond);font-weight:700;font-size:22px;line-height:1.05;
  color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpreview i{font-style:normal;font-size:11px;line-height:1.25;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:560px){.cpreview{display:none}}

/* ---- Theme builder (custom themes) --------------------------------------- */
.theme-builder{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start;margin-top:.5rem}
@media(max-width:820px){.theme-builder{grid-template-columns:1fr}}
.tb-controls{min-width:0}
.tb-controls>.tb-group{display:block;margin:1.6rem 0 .2rem;font-family:var(--cond);
  font-weight:600;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
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
.themecard{position:relative;display:block;border:1px solid var(--rule);
  border-radius:9px;overflow:hidden;cursor:pointer}
.themecard input{position:absolute;opacity:0;pointer-events:none}
.themecard .sw{height:60px;display:flex}
.themecard .sw i{flex:1}
.themecard .cap{padding:10px 12px;border-top:1px solid var(--rule)}
.themecard .cap b{font-family:var(--cond);font-weight:700;font-size:15px;display:block}
.themecard .cap small{color:var(--faint);font-size:11.5px}
.themecard:hover{border-color:var(--faint)}
.themecard:has(input:checked){border-color:var(--accent);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 35%,transparent)}

/* ---- Preview panel (calendar test, update-available, shift preview) ------ */
.preview{position:relative;border:1px solid var(--rule);border-radius:8px;
  padding:16px 18px;margin:1rem 0;background:var(--panel2)}
.preview h3{font-family:var(--cond);font-weight:700;font-size:16px;margin:0 0 .3rem}
.preview ul{list-style:none;margin:.6rem 0 0;padding:0}
.preview li{display:flex;gap:.9rem;padding:.5rem 0;font-size:14px;
  border-top:1px solid var(--ruleSoft)}
.preview li:first-child{border-top:0}
.preview .when{color:var(--faint);flex:0 0 12rem;font-family:var(--mono);font-size:12.5px}
.preview .warn{color:var(--warn);font-size:.9rem;margin-top:.6rem}
ul.plain{margin:.6rem 0 .6rem 1.1rem;color:var(--muted)}
ul.plain li{margin:.45rem 0}
ul.plain strong{color:var(--ink)}
pre.log{background:#0B1015;border:1px solid var(--rule);border-radius:7px;padding:.8rem;
  font:12px/1.55 var(--mono);color:var(--muted);max-height:22rem;overflow:auto;
  white-space:pre-wrap;word-break:break-word}

/* ---- QR + short code (pairing) ------------------------------------------ */
.qr{background:#fff;padding:.8rem;border-radius:8px;display:inline-block;margin:.6rem 0}
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
.pv-dow{display:block;font-family:var(--cond);font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--faint)}
.pv-num{display:block;font-family:var(--cond);font-weight:700;font-size:17px;margin:2px 0}
.pv-code{display:block;font-family:var(--cond);font-weight:700;font-size:12px;color:var(--accent)}
.pv-off .pv-code{color:var(--ok)}
.pv-unknown .pv-code{color:var(--faint)}

/* ---- Wall switcher above the layout editor ------------------------------- */
.walls{display:flex;flex-wrap:wrap;gap:8px;margin:.4rem 0 1rem}
.walls a{padding:7px 14px;border-radius:2rem;font-size:13px;font-weight:600;
  text-decoration:none;color:var(--muted);background:var(--panel);border:1px solid var(--rule)}
.walls a:hover{color:var(--ink);border-color:var(--faint)}
.walls a.active{color:var(--accentInk);background:var(--accent);border-color:var(--accent)}

/* ---- Layout editor (behaviour lives in the display bundle; this styles it) */
.le-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:1rem 0}
.le-toggle{display:inline-flex;align-items:center;gap:.5rem;font-size:14px;
  color:var(--muted);margin:0}
.le-toggle input{width:17px;height:17px;accent-color:var(--accent)}
.le-aspect{width:auto;padding:.42rem .6rem;background:var(--panel2);color:var(--ink);
  border:1px solid var(--rule);border-radius:7px}
/* The palette sits inline in the toolbar (the display bundle builds it there),
   so it is a row of dashed add-chips rather than the mockup's side column. */
.le-palette{display:flex;flex-wrap:wrap;gap:6px}
.le-add{display:inline-flex;align-items:center;gap:6px;margin:0;padding:.42rem .7rem;
  border:1px dashed var(--rule);border-radius:7px;background:none;color:var(--muted);
  font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;text-align:left}
.le-add:hover{border-color:var(--ok);color:var(--ink);filter:none}
.le-add svg{width:16px;height:16px;stroke-width:1.6;color:var(--ok);flex:0 0 auto}
.le-delete{margin-top:0;padding:.42rem .75rem;background:var(--panel);color:var(--danger);
  border:1px solid color-mix(in srgb,var(--danger) 40%,var(--rule));border-radius:7px;
  cursor:pointer;font-size:12.5px}
.le-delete:hover{filter:none;background:color-mix(in srgb,var(--danger) 12%,transparent)}
.le-delete:disabled{opacity:.4;cursor:default}
.le-save{margin-top:0;padding:.45rem .9rem;background:var(--accent);color:var(--accentInk);
  border:1px solid var(--accent);border-radius:7px;cursor:pointer;font-weight:700;font-size:12.5px}
.le-status{font-size:12.5px;font-family:var(--mono);color:var(--faint)}
.le-status.is-dirty{color:var(--accent)}
.le-status.is-ok{color:var(--ok)}
.le-status.is-error{color:var(--danger)}
.le-stage{display:flex;justify-content:center;align-items:center;padding:24px;
  background:var(--panel2);border:1px solid var(--rule);border-radius:10px;min-height:420px}
.le-canvas{position:relative;background:var(--bg);border-radius:6px;overflow:hidden;
  box-shadow:inset 0 0 0 1px var(--rule);touch-action:none}
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
.le-widget-label{position:absolute;top:0;left:0;font-family:var(--cond);font-weight:700;
  font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:#05140d;
  background:var(--ok);padding:2px 6px;border-radius:0 0 4px 0;pointer-events:none;user-select:none}
.le-widget.is-selected .le-widget-label{background:var(--accent);color:var(--accentInk)}
.le-handle{position:absolute;right:2px;bottom:2px;width:12px;height:12px;background:var(--accent);
  border-radius:3px 0 3px 0;cursor:se-resize;touch-action:none}
/* Per-widget options, shown under the stage when a widget is selected. */
.le-config{margin-top:16px;border:1px solid var(--rule);border-radius:10px;
  padding:16px 18px;background:var(--panel)}
.le-config>.kick{margin-bottom:12px}
.le-cfg-field{display:block;margin:12px 0 0}
.le-cfg-field>span{display:block;font-family:var(--cond);font-weight:600;font-size:12px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.le-cfg-field select,.le-cfg-field input[type=number]{width:auto;min-width:9rem}
.le-cfg-checks{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:2px}
.le-cfg-check{display:inline-flex;align-items:center;gap:.45rem;font-size:14px;
  color:var(--muted);cursor:pointer;margin:0}
.le-cfg-check input{width:16px;height:16px;accent-color:var(--accent);margin:0}
.le-cfg-btns{display:flex;gap:8px}
.le-cfg-btn{margin:0;padding:.42rem .75rem;border:1px solid var(--rule);border-radius:7px;
  background:var(--panel2);color:var(--ink);font-family:inherit;font-size:12.5px;
  font-weight:600;cursor:pointer}
.le-cfg-btn:hover{filter:none;border-color:var(--faint)}

/* ---- Home Assistant entity picker (first-party JS) ----------------------- */
#ha-entity-picker{margin-top:.6rem}
.hep-search{width:100%;margin-bottom:12px}
.hep-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.hep-chip{margin:0;padding:.34rem .7rem;border-radius:2rem;border:1px solid var(--rule);
  background:var(--panel);color:var(--muted);font-family:inherit;font-size:12.5px;
  font-weight:600;cursor:pointer}
.hep-chip:hover{filter:none;color:var(--ink);border-color:var(--faint)}
.hep-chip.active{background:var(--accent);color:var(--accentInk);border-color:var(--accent)}
.hep-selected{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;min-height:1.4rem}
.hep-pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .3rem .25rem .6rem;
  border-radius:2rem;background:color-mix(in srgb,var(--accent) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);color:var(--ink);font-size:13px}
.hep-pill-x{margin:0;padding:0;width:18px;height:18px;display:grid;place-items:center;
  border:0;border-radius:50%;background:color-mix(in srgb,var(--accent) 30%,transparent);
  color:var(--ink);cursor:pointer;font-size:14px;line-height:1}
.hep-pill-x:hover{filter:none;background:var(--accent);color:var(--accentInk)}
.hep-list{border:1px solid var(--rule);border-radius:8px;background:var(--panel2);
  max-height:22rem;overflow-y:auto}
.hep-row{display:flex;align-items:center;gap:12px;padding:.6rem .8rem;cursor:pointer;
  border-top:1px solid var(--ruleSoft);margin:0}
.hep-row:first-child{border-top:0}
.hep-row:hover{background:var(--panel)}
.hep-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);margin:0;flex:0 0 auto}
.hep-main{flex:1;min-width:0}
.hep-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hep-id{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.hep-state{font-family:var(--mono);font-size:12.5px;color:var(--muted);flex:0 0 auto;
  max-width:10rem;overflow:hidden;text-overflow:ellipsis;text-align:right}
.hep-footer{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px;margin-top:14px}
.hep-field{display:flex;flex-direction:column;gap:6px;margin:0}
.hep-field>span{font-family:var(--cond);font-weight:600;font-size:12px;letter-spacing:.05em;
  text-transform:uppercase;color:var(--muted)}
.hep-field select,.hep-field input{width:auto;min-width:14rem}
.hep-footer .btn-primary{margin-top:0}
.hep-status{font-family:var(--mono);font-size:12.5px;color:var(--faint)}
.hep-status.is-error{color:var(--danger)}
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
    (m.enabled ? '' : `<span class="nav-badge">off</span>`) +
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
      `<div class="card"><i class="cm tl"></i><i class="cm tr"></i>` +
      `<i class="cm bl"></i><i class="cm br"></i>` +
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
