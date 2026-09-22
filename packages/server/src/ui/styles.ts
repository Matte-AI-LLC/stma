import { siteCss } from './siteStyles';

/**
 * Design system from the Claude Design project "Agent Bridge.dc.html":
 * Geist / Geist Mono, light theme, green accent #00915A, dark app nav & command blocks.
 */
export const css = /* css */ `
/* Product-flow layouts share the live console, never the design prototype runtime. */
.flow-section { padding:24px; border-bottom:1px solid var(--line); min-width:0; }
.flow-section h2 { margin:0 0 12px; font-size:15px; font-weight:600; }
.flow-section p { color:var(--txt-2); }
.flow-section p:first-child { margin-top:0; }
.flow-section form { display:flex; flex-direction:column; gap:16px; align-items:stretch; }
.flow-section form .btn { align-self:flex-start; }
.flow-section .btn { white-space:normal; height:auto; min-height:38px; max-width:100%; text-align:center; }
.flow-section pre { max-width:100%; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
.flow-steps { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px; }
.flow-steps li { display:flex; gap:10px; color:var(--txt-2); font-size:12px; }
.flow-steps b { display:block; color:var(--ink); font-size:13px; }
.flow-steps p { margin:4px 0; }
.flow-steps time { font:10px var(--mono); overflow-wrap:anywhere; }
.flow-step-number { border:1px solid var(--ctl-border); border-radius:50%; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; flex:none; }
.flow-steps .current .flow-step-number { background:var(--ink); color:white; border-color:var(--ink); }
.flow-steps .done .flow-step-number { color:var(--green-ink); border-color:var(--green-line); background:var(--green-bg); }
.flow-scope,.flow-device { display:inline-block; border:1px solid var(--line); padding:4px 7px; font:11px var(--mono); overflow-wrap:anywhere; }
.flow-scope { border-radius:99px; }
.flow-identity { display:flex; flex-wrap:wrap; align-items:center; gap:7px; font-size:12px; }
.flow-empty { margin: 4px 0; padding: 32px 20px; display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; color:var(--txt-2); border:1px dashed var(--line-frame); border-radius:10px; background:#fcfcfa; }
.flow-empty::before { content:''; width:34px; height:34px; border-radius:9px; border:1px dashed #cfcfc8; background:#fff linear-gradient(var(--line-frame),var(--line-frame)) center/14px 2px no-repeat; }
.flow-empty h3 { margin:0; color:var(--ink); font-size:15px; }
.flow-empty p { margin:0; max-width:58ch; font-size:13px; line-height:1.6; }
.flow-columns { display:grid; grid-template-columns:minmax(200px,.85fr) minmax(0,1.6fr); }
.flow-columns > :first-child { border-right:1px solid var(--line); }
.flow-facts { margin:0; display:grid; grid-template-columns:90px minmax(0,1fr); gap:10px; font-size:12px; }
.flow-facts dt { color:var(--txt-2); }
.flow-facts dd { margin:0; overflow-wrap:anywhere; }
.flow-record { padding:14px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
.flow-record:last-child { border-bottom:0; }
.flow-record summary { cursor:pointer; font-weight:500; }
.flow-status { display:inline-block; padding:3px 7px; border:1px solid var(--line); border-radius:4px; font:11px var(--mono); background:var(--line-2); }
.flow-modes { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.flow-form-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media(max-width:600px) { .flow-form-row { grid-template-columns:1fr; } }
.flow-mode { display:block; border:1px solid var(--ctl-border); padding:14px; border-radius:6px; cursor:pointer; }
.flow-mode:has(input:checked) { border-color:var(--green); background:var(--green-bg); }
.flow-mode p { margin-bottom:0; font-size:12px; }
.flow-timeline { display:flex; flex-direction:column; gap:18px; }
.flow-timeline .flow-steps { grid-template-columns:1fr; }
.flow-timeline .flow-step-number { margin-top:1px; }
.flow-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
.flow-actions form { margin:0; }
.flow-prose { max-width:70ch; }
@media(max-width:900px) { .flow-columns { grid-template-columns:1fr; } .flow-columns > :first-child { border-right:0; } }
@media(max-width:600px) { .flow-section { padding:18px 16px; } .flow-steps,.flow-modes { grid-template-columns:1fr; } .flow-steps { gap:14px; } .flow-facts { grid-template-columns:75px minmax(0,1fr); } .flow-actions > .btn { white-space:normal; height:auto; min-height:38px; } }
:root {
  --ink: #16181a;
  --ink-2: #2b2f33;
  --txt-2: #5b6065;
  --txt-3: #6e7278;
  --mut: #8a8f94;
  --mut-2: #a0a5aa;
  --line: #e6e6e1;
  --line-2: #f0f0ec;
  --line-3: #eaeae5;
  --line-frame: #e2e2dd;
  --ctl-border: #d9d9d3;
  --green: #00915a;
  --green-strong: #00734a;
  --green-border: #007a4c;
  --green-bright: #00c37a;
  --green-bg: #e9f6ef;
  --green-line: #c3e6d5;
  --green-ink: #00603d;
  --red: #b42318;
  --red-border: #99190f;
  --red-line: #eccfcb;
  --red-bg: #fdf3f2;
  --red-bg-line: #f0d3ce;
  --red-ink: #8f2419;
  --amber-bg: #fdf8ef;
  --amber-line: #ecdcc0;
  --amber-ink: #7a5313;
  --blue-bg: #f4f6f8;
  --blue-line: #dde4ea;
  --blue-ink: #37536d;
  --dark: #14171a;
  --dark-line: #2a2f33;
  --dark-line-2: #2f3439;
  --dark-txt: #d6dadd;
  --dark-txt-2: #c9ced2;
  --dark-mut: #9aa0a6;
  --dark-mut-2: #7d848a;
  --sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  /* Geist Mono is for text a machine wrote or will read: a command, a path, a
     branch, a commit, an id, a quoted product message, JSON. It is NOT the
     console's label face. It had become that — 97 rules deep on 2026-09-23,
     including breadcrumbs, role chips, counts, timestamps, footer headings and
     the status strip — and a page where a third of the words are typewritten
     reads as a terminal emulator rather than as a product. Sixty-four of those
     moved to the sans face the same day, on the owner's word. Before reaching
     for it, ask whether the string is something somebody would paste into a
     terminal; if not, it is sans. */
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: #fbfbf9;
  color: var(--ink);
  font: 400 14px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
  text-wrap: pretty;
}
a { color: var(--green-strong); text-decoration: none; }
a:hover { color: var(--green); text-decoration: underline; }
code { font-family: var(--mono); }
.container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.muted { color: var(--mut); }
.small { font-size: 12px; }
.mono { font-family: var(--mono); font-size: 13px; }
.m0 { margin: 0; }
.overline {
  font: 500 12px/1 var(--mono);
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--mut);
}

/* ---------- app nav (dark) ---------- */
.appnav { height: 56px; background: var(--dark); }
.appnav-inner { height: 56px; display: flex; align-items: center; justify-content: space-between; }
.appnav-left { display: flex; align-items: center; gap: 28px; height: 100%; }
.brand { display: inline-flex; align-items: center; gap: 9px; font: 600 15px/1 var(--sans); letter-spacing: -.01em; color: var(--ink); }
.brand:hover { text-decoration: none; }
.appnav .brand, .appnav .brand:hover { color: #fff; }
/* The mark is inline SVG in currentColor (ui/Console.tsx Logo) — these rules
   only size it and pick the ink: dark on the light pages, white on the rail. */
.logo { width: 22px; height: 22px; color: var(--ink); display: inline-flex; flex: none; }
.logo svg { width: 100%; height: 100%; display: block; }
.logo.inv { width: 22px; height: 22px; color: #fff; }
.logo.lg { width: 28px; height: 28px; }
.appnav-links { display: flex; align-items: center; gap: 4px; height: 100%; }
.appnav-link { display: inline-flex; align-items: center; height: 56px; padding: 0 12px; font: 400 14px/1 var(--sans); color: var(--dark-mut); }
a.appnav-link:hover { color: #fff; text-decoration: none; }
.appnav-link.active { color: #fff; font-weight: 500; box-shadow: inset 0 -2px 0 var(--green-bright); }
.appnav-link.disabled { color: #6b7176; }
.soon { font: 500 10px/1 var(--sans); padding: 3px 5px; border-radius: 4px; background: #23272b; color: #8a9096; margin-left: 7px; }
.appnav-right { display: flex; align-items: center; gap: 10px; }
.appnav-user { font: 400 13px/1 var(--sans); color: var(--dark-mut); }
.avatar {
  width: 26px; height: 26px; border-radius: 99px;
  background: #2f3439; border: 1px solid #3d4348;
  display: inline-flex; align-items: center; justify-content: center;
  font: 500 11px/1 var(--sans); color: #d6dadd; flex: none;
}
.avatar.light { background: #f1f1ee; border-color: var(--line-frame); color: var(--txt-2); }
.avatar.ink { background: var(--ink); border-color: var(--ink); color: #fff; }
.btn-signout { background: none; border: none; color: var(--dark-mut-2); font: 400 12px/1 var(--sans); cursor: pointer; padding: 4px 0 4px 6px; }
.btn-signout:hover { color: #fff; }

/* ---------- page scaffolding ---------- */
/* padding-block, not the shorthand: this class sits on the same element as
   .container on every signed-out page, and a shorthand here zeroed that class's
   24px gutter — the guide and /help ran edge to edge on a phone. */
.page { padding-block: 32px 72px; display: flex; flex-direction: column; gap: 22px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1.title, h2.title { margin: 0; font: 600 26px/1.2 var(--sans); letter-spacing: -.02em; }
.sub { margin: 4px 0 0; font: 400 14px/1.5 var(--sans); color: var(--txt-3); }
.crumb { font: 400 13px/1 var(--sans); color: var(--mut); }
.crumb a { color: var(--mut); }
.row { display: flex; align-items: center; gap: 10px; }
.stack { display: flex; flex-direction: column; gap: 16px; }

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 38px; padding: 0 15px; border-radius: 7px;
  border: 1px solid var(--ctl-border); background: #fff;
  font: 500 14px/1 var(--sans); color: var(--ink);
  cursor: pointer; white-space: nowrap;
}
.btn:hover { background: #f7f7f5; text-decoration: none; color: var(--ink); }
.btn-primary { background: var(--green); border-color: var(--green-border); color: #fff; }
.btn-primary:hover { background: var(--green-strong); border-color: #005e3c; color: #fff; }
.btn-danger { border-color: var(--red-line); color: var(--red); }
.btn-danger:hover { background: var(--red-bg); color: var(--red); }
.btn-danger-solid { background: var(--red); border-color: var(--red-border); color: #fff; }
.btn-danger-solid:hover { background: #99190f; color: #fff; }
.btn-dark { background: var(--ink); border-color: var(--ink); color: #fff; height: 46px; font-size: 15px; width: 100%; }
.btn-dark:hover { background: #2b2f33; color: #fff; }
.btn-white { background: #fff; border-color: #fff; color: var(--ink); }
.btn-sm { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 6px; }
.btn-lg { height: 44px; padding: 0 20px; font-size: 16px; }
.linklike { background: none; border: none; padding: 0; font: 500 13px/1 var(--sans); color: var(--red); cursor: pointer; }
.linklike:hover { text-decoration: underline; }
.linklike.plain { color: var(--ink); }
.btn.off { color: var(--mut-2); background: #fafaf9; cursor: default; pointer-events: none; }
.btn:disabled {
  color: var(--mut-2); background: #fafaf9; border-color: var(--line);
  cursor: not-allowed; opacity: .75;
}

/* Plan cards are peers. The general .grid2 is intentionally asymmetric for
   content+sidebar pages, so pricing needs its own equal comparison grid. */
.pricing-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px; align-items: stretch;
}

/* ---------- pagination ---------- */
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 18px; }
/* Separated only when it follows content that has no bottom border of its own. */
.card > table + .pager, .card > .card-pad + .pager { border-top: 1px solid var(--line); }
.pager-note { font: 400 12px/1.4 var(--sans); color: var(--mut); }
.pager-note b { font-weight: 600; color: var(--txt-2); }

/* ---------- cards ---------- */
.card { background: #fff; border: 1px solid var(--line); border-radius: 10px; }
.card-pad { padding: 20px; }
.card-head { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-title { font: 600 15px/1.2 var(--sans); }
.card-note { font: 400 12px/1.4 var(--sans); color: var(--mut); margin-top: 3px; }
.fold-card > summary { cursor: pointer; list-style: none; border-bottom: 0; }
.fold-card > summary::-webkit-details-marker { display: none; }
.fold-card > summary::after {
  content: '+'; flex: none; margin-left: 6px; color: var(--mut);
  font: 500 18px/1 var(--sans);
}
.fold-card[open] > summary { border-bottom: 1px solid var(--line); }
.fold-card[open] > summary::after { content: '−'; }
.section-jump {
  display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px;
  background: #fff; border: 1px solid var(--line); border-radius: 10px;
}
.section-jump a {
  display: inline-flex; align-items: center; gap: 7px; padding: 7px 9px;
  border: 1px solid var(--line); border-radius: 6px; color: var(--txt-2);
  font: 500 12px/1 var(--sans);
}
.section-jump a:hover { border-color: var(--green); color: var(--green-strong); text-decoration: none; }
.section-jump span { color: var(--mut); font: 400 11px/1 var(--sans); }
.activity-filters {
  display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr));
  gap: 12px; align-items: end;
}
.activity-filters label { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.activity-filters label > span {
  color: var(--mut); font: 500 10px/1 var(--sans); letter-spacing: .06em; text-transform: uppercase;
}
.activity-filters input, .activity-filters select {
  width: 100%; height: 34px; padding: 0 9px; border: 1px solid var(--ctl-border);
  border-radius: 6px; background: #fff; color: var(--ink); font: 400 13px/1 var(--sans);
}
.activity-search { grid-column: span 2; }
.activity-filter-actions { display: flex; gap: 8px; align-items: center; }
.scroll-x { overflow-x: auto; }

/* ---------- tables ---------- */
table.tbl { width: 100%; border-collapse: collapse; }
.tbl th {
  padding: 11px 18px; background: #f7f7f5; border-bottom: 1px solid var(--line);
  font: 500 11px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
  color: var(--mut); text-align: left; white-space: nowrap;
}
.tbl td { padding: 13px 18px; border-bottom: 1px solid var(--line-2); font: 400 13px/1.4 var(--sans); vertical-align: middle; }
.tbl tr:last-child td { border-bottom: none; }
.tbl .name { font: 500 14px/1.3 var(--sans); }
.tbl td.mono { font: 400 13px/1.4 var(--mono); color: var(--txt-3); }
.cellrow { display: flex; align-items: center; gap: 10px; }
.chev { color: var(--mut-2); font-size: 15px; }

/* ---------- pills & dots ---------- */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 9px; border-radius: 99px;
  font: 500 11px/1 var(--sans); letter-spacing: .04em; text-transform: uppercase;
  white-space: nowrap;
}
.pill-owner { background: var(--ink); color: #fff; }
.pill-member { background: #f1f1ee; border: 1px solid var(--line-frame); color: #4b5055; }
.pill-danger { background: #fff0ed; border: 1px solid #e8a89b; color: #9a2c1a; }
.pill-active { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); }
.pill-muted { background: #f7f7f5; border: 1px solid var(--line); color: var(--mut); }
/* Where a rule comes from (phase 3 of the console plan): what the workspace gives every
   project stays neutral, what one project adds carries the accent. The origin is also
   written in words beside each group: colour alone must not carry it. */
.pill-own { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); }
/* A rule is a sentence, not a label: the base pill is one fixed-height line and pushed a long
   rule off a narrow screen. This one wraps and keeps the rule's own capitals. */
.pill-rule {
  height: auto; min-height: 22px; padding: 4px 9px; border-radius: 11px;
  white-space: normal; overflow-wrap: anywhere; line-height: 1.35;
  text-transform: none; letter-spacing: 0;
}
.origin-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.origin-row + .origin-row { margin-top: 6px; }
.origin { flex: 0 0 132px; font: 500 11px/1.4 var(--sans); letter-spacing: .04em; color: var(--mut); }
.origin-project { color: var(--green-strong); }
.origin-note { color: var(--mut); font-weight: 400; }
@media (max-width: 640px) { .origin { flex-basis: 100%; } }
.dot { width: 6px; height: 6px; border-radius: 99px; background: var(--green); flex: none; }
.dot.gray { background: #c2c7cb; }
.dot.red { background: var(--red); }

/* ---------- banners & toast ---------- */
.banner { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 8px; font: 400 14px/1.4 var(--sans); }
.banner .ic { width: 16px; height: 16px; border-radius: 99px; color: #fff; font: 600 10px/16px var(--sans); text-align: center; flex: none; }
.banner .x { margin-left: auto; cursor: pointer; opacity: .6; background: none; border: none; font: 400 16px/1 var(--sans); color: inherit; }
.banner-success { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-ink); }
.banner-success .ic { background: var(--green); }
.banner-error { background: var(--red-bg); border: 1px solid var(--red-bg-line); color: var(--red-ink); }
.banner-error .ic { background: var(--red); }
.banner-warn { background: var(--amber-bg); border: 1px solid var(--amber-line); color: var(--amber-ink); }
.banner-warn .ic { background: #b45309; }
.banner-info { background: var(--blue-bg); border: 1px solid var(--blue-line); color: var(--blue-ink); }
.banner-info .ic { background: #37536d; }
.toast {
  position: fixed; left: 20px; bottom: 20px; z-index: 60;
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border-radius: 9px; background: var(--dark); color: #fff;
  font: 400 14px/1 var(--sans);
  box-shadow: 0 14px 30px -12px rgba(20,23,26,.5);
}
.toast .ic { width: 16px; height: 16px; border-radius: 99px; background: var(--green-bright); color: var(--dark); font: 600 10px/16px var(--sans); text-align: center; }

/* ---------- forms ---------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font: 500 13px/1 var(--sans); display: flex; align-items: center; gap: 8px; }
.field .help { font: 400 12px/1.4 var(--sans); color: var(--mut); }
/* Whether a field must be filled, said on the label rather than left to a red
   asterisk nobody has a legend for. Both states are marked: "unmarked means
   optional" is a convention every form claims and no reader knows. */
.fmark { font: 500 9px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; padding: 3px 5px; border-radius: 4px; }
.fmark-req { color: var(--green-strong); background: var(--green-bg); border: 1px solid var(--green-line); }
.fmark-opt { color: var(--mut); background: #f5f5f2; border: 1px solid var(--line); }
input.in {
  height: 38px; padding: 0 12px; border: 1px solid var(--ctl-border); border-radius: 7px;
  font: 400 14px/1.2 var(--sans); color: var(--ink); background: #fff; min-width: 0;
}
input.in:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(0,145,90,.14); }
form.inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.checkrow {
  display: flex; align-items: flex-start; gap: 11px; padding: 12px 13px;
  border: 1px solid var(--line); border-radius: 8px; cursor: pointer;
}
.checkrow:hover { background: #f7f7f5; }
.checkrow input[type="checkbox"] { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--green); flex: none; }
.checkrow-label { display: block; font: 500 14px/1.3 var(--sans); }
.checkrow-note { display: block; margin-top: 3px; font: 400 12px/1.45 var(--sans); color: var(--mut); }

/* ---------- tiles (team/initials) ---------- */
.tile { border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font: 600 11px/1 var(--sans); flex: none; }
/* Renamed from .tile-28 and shrunk to 24 on 2026-09-23: it sits in the status
   strip beside chips and controls that are all 24px, and one 28px box in that
   row reads as misaligned even though it is centred. A class whose name says a
   size it is not is worse than either size. */
.tile-24 { width: 24px; height: 24px; }
.tile-40 { width: 40px; height: 40px; border-radius: 9px; font-size: 14px; }
.tile-44 { width: 44px; height: 44px; border-radius: 9px; font-size: 16px; }
.tile-52 { width: 52px; height: 52px; border-radius: 11px; }
.tile-green { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); }
.tile-gray { background: #f4f4f2; border: 1px solid var(--line-frame); color: var(--txt-2); }
.tile-dashed { border: 1px dashed #cfcfc8; background: #fff; }
.tile-dashed .bar { width: 20px; height: 2px; background: #c2c7cb; }

/* ---------- command blocks ---------- */
.cmd {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 13px 14px; border-radius: 8px; background: var(--dark);
}
.cmd code {
  font: 400 13px/1.6 var(--sans); color: var(--dark-txt);
  white-space: pre-wrap; word-break: break-all; min-width: 0;
}
.cmd.inner { background: #1c2023; border: 1px solid var(--dark-line); padding: 11px 12px; border-radius: 7px; }
.cmd.inner code { font-size: 12px; color: var(--dark-txt-2); }
.copybtn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border-radius: 5px; border: 1px solid var(--dark-line-2); background: none;
  font: 500 11px/1 var(--sans); letter-spacing: .04em; color: var(--dark-mut);
  cursor: pointer; flex: none;
}
.copybtn:hover { color: #fff; border-color: #4a5157; }
.copybtn.copied { background: var(--green); border-color: var(--green); color: #fff; }
.steplabel { font: 500 12px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--mut); }
.step { display: flex; flex-direction: column; gap: 8px; }

/* ---------- token reveal ---------- */
.reveal { border: 1px solid var(--green-line); border-radius: 10px; background: #f3faf6; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.reveal-head { display: flex; align-items: flex-start; gap: 10px; }
.reveal-head .ic { width: 18px; height: 18px; border-radius: 99px; background: var(--green); color: #fff; font: 600 11px/18px var(--sans); text-align: center; flex: none; }
.reveal-title { font: 600 15px/1.3 var(--sans); color: var(--green-ink); }
.reveal-sub { font: 400 13px/1.4 var(--sans); color: #3f7a60; margin-top: 3px; }
.reveal-row { display: flex; align-items: center; gap: 10px; }
.tokenbox {
  flex: 1; display: flex; align-items: center; height: 44px; padding: 0 14px;
  border: 1px solid var(--green-line); border-radius: 7px; background: #fff;
  font: 500 14px/1 var(--sans); letter-spacing: .01em;
  overflow-x: auto; white-space: nowrap; min-width: 0;
}
.copybtn.solid { height: 44px; padding: 0 18px; border-radius: 7px; background: var(--green); border-color: var(--green-border); color: #fff; font: 500 14px/1 var(--sans); letter-spacing: 0; }
.copybtn.solid:hover { background: var(--green-strong); }
.setup-prompt { max-height: 430px; overflow-y: auto; }
.setup-prompt code { word-break: break-word; }
.setup-prompt .copybtn { position: sticky; top: 0; }

/* ---------- invites ---------- */
.invrow { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--line-2); }
.invrow:last-child { border-bottom: none; }
.invrow-main { display: flex; align-items: center; gap: 10px; }
.invurl {
  flex: 1; min-width: 0; display: flex; align-items: center; height: 38px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: 7px; background: #fafaf8;
  font: 400 13px/1 var(--sans); color: #4b5055;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.invmeta { display: flex; align-items: center; gap: 14px; font: 400 12px/1 var(--sans); color: var(--mut); flex-wrap: wrap; }
.with-dot { display: inline-flex; align-items: center; gap: 6px; }

/* ---------- dark side card ---------- */
.darkcard { border: 1px solid var(--ink); border-radius: 10px; background: var(--dark); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.darkcard .overline { color: var(--dark-mut-2); }
.darkcard h3 { margin: 0; font: 600 18px/1.3 var(--sans); color: #fff; }
.darkcard p { margin: 0; font: 400 14px/1.55 var(--sans); color: #a8adb2; }
/* A statement of fact, not a control — kept apart from .checkrow, which is a
   clickable form row with a checkbox in it. They shared a name, and the cascade
   handed these lines a border and a pointer cursor they never wanted. */
.factrow { display: flex; gap: 9px; font: 400 13px/1.5 var(--sans); color: var(--txt-2); }
.factrow .y { color: var(--green); flex: none; }
.factrow .n { color: var(--red); flex: none; }
.factrow em { font-style: normal; font-weight: 600; color: var(--ink); }

/* ---------- tabs ---------- */
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.tab { padding: 9px 14px; font: 400 14px/1 var(--sans); color: var(--txt-3); background: none; border: none; cursor: pointer; }
.tab.active { color: var(--ink); font-weight: 500; box-shadow: inset 0 -2px 0 var(--ink); }
[data-tab-panel] { display: none; }
[data-tab-panel].active { display: flex; flex-direction: column; gap: 16px; }

/* ---------- empty states ---------- */
.empty { padding: 56px 24px 64px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; }
.empty h2 { margin: 0; font: 600 24px/1.2 var(--sans); letter-spacing: -.02em; }
.empty p { margin: 0; font: 400 15px/1.6 var(--sans); color: var(--txt-3); max-width: 52ch; }

/* ---------- grid layouts ---------- */
.grid2 { display: grid; grid-template-columns: 1.75fr 1fr; gap: 24px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 24px; min-width: 0; }

/* ---------- dialog ---------- */
dialog.confirm {
  border: 1px solid var(--line); border-radius: 11px; padding: 24px;
  max-width: 440px; width: calc(100% - 40px);
  box-shadow: 0 22px 50px -20px rgba(20,23,26,.35);
  font: 400 14px/1.5 var(--sans); color: var(--ink);
}
dialog.confirm::backdrop { background: rgba(20,23,26,.4); }
dialog.confirm h3 { margin: 0 0 8px; font: 600 19px/1.3 var(--sans); }
dialog.confirm p { margin: 0 0 16px; color: var(--txt-2); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; }

/* ---------- landing ---------- */
/* The signed-out header stays put while the page moves under it: the one frame a
   visitor keeps, and the way into the docs from anywhere on a long page. */
.site-head {
  position: sticky; top: 0; z-index: 30; height: 64px;
  border-bottom: 1px solid rgba(20,23,26,.07);
  background: rgba(251,251,249,.82);
  -webkit-backdrop-filter: saturate(180%) blur(14px); backdrop-filter: saturate(180%) blur(14px);
}
.site-head-inner { height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.site-nav { display: flex; align-items: center; gap: 22px; }
.site-nav a.plain { font: 400 14px/1 var(--sans); color: var(--txt-2); }
.site-nav a.plain:hover { color: var(--ink); text-decoration: none; }
.site-nav a.plain.on { color: var(--ink); font-weight: 500; }
@media (max-width: 860px) { .site-nav .wide-only { display: none; } .site-nav { gap: 14px; } }
@media (max-width: 420px) { .site-nav .narrow-hide { display: none; } }
.site-foot { padding: 56px 0 28px; border-top: 1px solid var(--line-3); background: #fff; }
.site-foot-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; font: 400 13px/1 var(--sans); color: var(--mut); }
.foot-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: 32px; }
.foot-brand { display: flex; flex-direction: column; gap: 14px; }
.foot-brand p { margin: 0; max-width: 40ch; font: 400 13px/1.6 var(--sans); color: var(--txt-3); }
.foot-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.foot-col h5 { margin: 0 0 4px; font: 500 11px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
.foot-col a { font: 400 13px/1.3 var(--sans); color: var(--txt-2); }
.foot-col a:hover { color: var(--ink); text-decoration: none; }
.foot-addr { margin-top: -6px; font: 400 11px/1.3 var(--sans); color: var(--mut); overflow-wrap: anywhere; }
.foot-base {
  margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line-2);
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  font: 400 12px/1 var(--sans); color: var(--mut);
}
@media (max-width: 860px) { .foot-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .foot-brand { grid-column: 1 / -1; } }
@media (max-width: 480px) { .foot-grid { grid-template-columns: 1fr; } }

/* ---------- auth ---------- */
/* The same ground as the landing page, quieter: arriving at a sign-in card from
   the site should not feel like leaving it. */
.auth-wrap {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px;
  position: relative; isolation: isolate; overflow: hidden;
}
.auth-wrap::before {
  content: ''; position: absolute; inset: 0; z-index: -2; pointer-events: none;
  background-image: radial-gradient(rgba(20,23,26,.08) 1px, transparent 1.3px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 60% 55% at 50% 40%, #000 20%, transparent 75%);
  mask-image: radial-gradient(ellipse 60% 55% at 50% 40%, #000 20%, transparent 75%);
}
.auth-wrap::after {
  content: ''; position: absolute; z-index: -1; pointer-events: none;
  left: 50%; top: -220px; width: 900px; height: 560px; transform: translateX(-50%);
  background: radial-gradient(closest-side, rgba(0,195,122,.13), transparent 100%);
}
a.auth-home { display: inline-flex; color: inherit; }
a.auth-home:hover { text-decoration: none; opacity: .8; }
.auth-card {
  width: 100%; max-width: 460px;
  background: #fff; border: 1px solid var(--line-frame); border-radius: 12px;
  padding: 48px 44px; display: flex; flex-direction: column; align-items: center; gap: 22px;
  box-shadow: 0 34px 70px -38px rgba(20,23,26,.32), 0 1px 2px rgba(20,23,26,.05);
}
.auth-card h1 { margin: 0; font: 600 26px/1.2 var(--sans); letter-spacing: -.02em; text-align: center; }
.auth-card .lede { margin: 8px 0 0; font: 400 15px/1.5 var(--sans); color: var(--txt-3); text-align: center; }
.auth-card .banner { width: 100%; align-items: flex-start; font-size: 13px; }
.auth-card .wide { width: 100%; }
.finenote { margin: 0; font: 400 12px/1.5 var(--sans); color: var(--mut); text-align: center; max-width: 36ch; }
.devbox { width: 100%; border-top: 1px solid var(--line-2); padding-top: 20px; display: flex; flex-direction: column; gap: 10px; }
.authform { display: flex; flex-direction: column; gap: 14px; }
.divider { display: flex; align-items: center; gap: 10px; width: 100%; color: var(--mut); font: 400 12px/1 var(--sans); }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--line-2); }

/* ---------- join ---------- */
.joincard { max-width: 520px; display: flex; flex-direction: column; gap: 18px; }
.join-team { display: flex; align-items: center; gap: 14px; }
.join-name { font: 600 20px/1.2 var(--sans); }

/* ---------- skeleton ---------- */
.skel { height: 12px; border-radius: 3px; background: #f4f4f2; }
.skel.deep { background: #eeeeea; }

/* ---------- docs ---------- */
.toc { display: flex; flex-wrap: wrap; gap: 8px; }
.toc a {
  display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
  border-radius: 99px; background: #fff; border: 1px solid var(--line);
  font: 500 13px/1 var(--sans); color: var(--txt-2);
}
.toc a:hover { text-decoration: none; border-color: var(--green); color: var(--green-strong); }
/* Prose lists — first used by the legal pages; the rest of the app is tables and cards. */
.doc-list { margin: 8px 0 0; padding-left: 20px; }
.doc-list li { margin: 6px 0; }
.doc-list li b { font-weight: 600; }
/* Legal pages: a contents list in two columns (one on a phone), anchors that land below the
   sticky 64px site header rather than under it, and tables of prose that read from the top. */
.legal-toc { margin: 0; padding: 14px 18px 14px 38px; columns: 2 220px; column-gap: 32px; background: #fff; border: 1px solid var(--line); border-radius: 10px; font: 400 14px/1.7 var(--sans); }
.legal .doc-section { scroll-margin-top: 84px; }
.legal .tbl td { vertical-align: top; }
.doc-section { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 24px; }
.doc-section h2 { margin: 18px 0 0; font: 600 22px/1.2 var(--sans); letter-spacing: -.02em; }
.say {
  border-left: 3px solid var(--green); background: #f3faf6;
  padding: 10px 14px; border-radius: 0 8px 8px 0;
  font: 400 14px/1.5 var(--sans); color: var(--ink-2);
}
.say .lbl { display: block; font: 500 10px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--green-strong); margin-bottom: 5px; }
.step-row { display: flex; gap: 12px; align-items: flex-start; }
.num {
  display: inline-flex; width: 22px; height: 22px; border-radius: 99px;
  background: var(--ink); color: #fff; font: 600 12px/22px var(--sans);
  justify-content: center; flex: none; margin-top: 1px;
}
.prompt {
  display: flex; gap: 12px; align-items: flex-start;
  border: 1px solid var(--green-line); background: #f3faf6;
  border-radius: 8px; padding: 12px 14px;
}
.prompt p { margin: 0; flex: 1; font: 400 14px/1.55 var(--sans); color: var(--ink-2); }
.copybtn.onlight { border: 1px solid var(--ctl-border); background: #fff; color: var(--txt-2); }
.copybtn.onlight:hover { color: var(--ink); border-color: #b9b9b3; }
.hero-card { border: 1px solid var(--green-line); background: #f3faf6; border-radius: 10px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.hero-card p { margin: 0; font: 400 15px/1.6 var(--sans); color: var(--ink-2); max-width: 66ch; }
/* /docs: the six jobs, first thing on the page. Each card links to where the guide covers it. */
.pillars { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.pillar { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.pillar-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pillar-head b { font: 600 15px/1.2 var(--sans); color: var(--ink); }
.pillar-tag { font: 400 12px/1.2 var(--sans); color: var(--txt-3); }
.doc-col .pillar p { margin: 0; font: 400 13px/1.55 var(--sans); color: var(--ink-2); }
.pillar-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: auto; font: 400 12px/1.6 var(--sans); }
.pillar-links code { font-size: 12px; }
/* /help: an index of the sections, then one entry per message: the words on screen in
   the product's own spelling, what they mean, what to do. The side table of contents is
   the same list, so below the width where it stops being beside the text it gives way
   to the index rather than repeating it. */
.helpidx { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.helpidx a { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); }
.helpidx a:hover { text-decoration: none; border-color: var(--green-line); background: #f3faf6; }
.helpidx b { font: 600 13px/1.3 var(--sans); }
.helpidx span { font: 400 12px/1.4 var(--sans); color: var(--txt-3); }
.helpidx .count { font: 500 11px/1 var(--sans); color: var(--mut); }
.walls { display: flex; flex-direction: column; gap: 10px; }
.wall { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.wall-top { display: flex; align-items: flex-start; gap: 12px; }
.wall-said { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.doc-col .wall-msg { margin: 0; max-width: none; padding: 8px 12px; border-radius: 7px; background: #f7f7f5; border: 1px solid var(--line-3); font: 400 13px/1.55 var(--mono); color: var(--ink); white-space: pre-wrap; word-break: break-word; }
.doc-col .wall-symptom { margin: 0; font: 500 14px/1.45 var(--sans); color: var(--ink); }
.wall-by { margin-top: -2px; font: 400 11.5px/1.4 var(--sans); color: var(--mut); }
.wall-where { flex: none; max-width: 16ch; text-align: right; font: 500 10px/1.5 var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--mut); padding-top: 5px; overflow-wrap: anywhere; }
.wall-part { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 12px; font: 400 13.5px/1.55 var(--sans); color: var(--ink-2); }
.wall-part > .wall-lbl { font: 500 10.5px/2.1 var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--green-strong); }
.wall-part > div > p, .wall-part > div > ol { margin: 0; }
.wall-part > div > * + * { margin-top: 6px; }
.wall-part ol { padding-left: 18px; }
@media (max-width: 960px) { .sidetoc.helptoc { display: none; } }
@media (max-width: 640px) {
  .wall-top { flex-direction: column-reverse; gap: 4px; }
  .wall-where { max-width: none; text-align: left; padding-top: 0; }
  .wall-part { grid-template-columns: 1fr; gap: 0; }
}

/* ---------- sessions ---------- */
.tabs a.tab:hover { text-decoration: none; color: var(--ink); }
.sesslist { display: flex; flex-direction: column; gap: 10px; }
a.sesscard { display: block; background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 15px 16px; color: inherit; }
a.sesscard:hover { text-decoration: none; color: inherit; border-color: #d0d0ca; }
.sesscard.unread { box-shadow: inset 3px 0 0 var(--green); }
.sesscard.resolved { opacity: .85; }
.sesscard-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.sesscard-title { font: 600 15px/1.35 var(--sans); }
.sesscard.resolved .sesscard-title { color: #4b5055; }
.sesscard-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.sesscard-info { display: flex; align-items: center; gap: 8px; font: 400 12px/1 var(--sans); color: var(--mut); }
.sesscard-root { margin: 8px 0 0; font: 400 13px/1.55 var(--sans); color: var(--txt-2); }
.sesscard-root b { font-weight: 600; color: var(--ink); }
.unreadmark { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/1 var(--sans); color: var(--green-strong); }
.avstack { display: flex; }
.avstack .avatar { width: 22px; height: 22px; font-size: 9px; border: 2px solid #fff; }
.avstack .avatar + .avatar { margin-left: -7px; }
.pill-open { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); }
.kindtag {
  display: inline-flex; align-items: center; height: 19px; padding: 0 7px; border-radius: 4px;
  font: 500 10px/1 var(--sans); letter-spacing: .04em; text-transform: uppercase; flex: none;
}
.kind-question { background: #eef3f8; border: 1px solid #d5e2ee; color: #37536d; }
.kind-hypothesis { background: #fdf3e3; border: 1px solid #ecdcc0; color: #8a5a12; }
.kind-info-request { background: #f4f4f2; border: 1px solid #e2e2dd; color: #4b5055; }
.kind-resolution { background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); }
.kind-answer { background: #f1f6f3; border: 1px solid #dceae3; color: #4b7a63; }
.kind-note { background: #f7f7f5; border: 1px solid var(--line); color: var(--mut); }
.kind-announcement { background: #f3f0fa; border: 1px solid #ddd3ee; color: #5b4a8a; }
.kind-handoff { background: #eef6ff; border: 1px solid #cfe0f5; color: #1f4e79; }
.thread { background: #fbfbf9; padding: 20px 22px; display: flex; flex-direction: column; gap: 18px; }
.msg { display: flex; gap: 12px; }
.msg-main { display: flex; flex-direction: column; gap: 7px; flex: 1; min-width: 0; }
.msg-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.msg-author { font: 500 14px/1 var(--sans); }
.msg-via { font: 400 12px/1 var(--sans); color: var(--mut); }
.msg-time { font: 400 12px/1 var(--sans); color: var(--mut-2); }
.msg-text { margin: 0; font: 400 14px/1.6 var(--sans); color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.attach { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #fff; }
.attach-head { padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; background: #f7f7f5; border-bottom: 1px solid var(--line); font: 500 11px/1 var(--sans); color: #4b5055; }
.attach pre { margin: 0; padding: 11px 12px; background: var(--dark); font: 400 12px/1.65 var(--mono); color: var(--dark-txt-2); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; }
.composer { padding: 16px 22px; border-top: 1px solid var(--line-3); display: flex; flex-direction: column; gap: 12px; background: #fff; }
textarea.in {
  min-height: 74px; padding: 12px 14px; border: 1px solid var(--ctl-border); border-radius: 8px;
  font: 400 14px/1.5 var(--sans); color: var(--ink); resize: vertical; width: 100%;
}
select.in {
  height: 38px; padding: 0 10px; border: 1px solid var(--ctl-border); border-radius: 7px;
  font: 400 13px/1.2 var(--sans); background: #fff; color: var(--ink);
}
textarea.in:focus, select.in:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(0,145,90,.14); }
dialog.formdlg {
  border: 1px solid var(--line); border-radius: 11px; padding: 24px;
  width: min(500px, calc(100% - 40px));
  box-shadow: 0 22px 50px -20px rgba(20,23,26,.35);
  font: 400 14px/1.5 var(--sans); color: var(--ink);
}
dialog.formdlg::backdrop { background: rgba(20,23,26,.4); }
/* A policy has seven fields; a 500px dialog turns that into a scroll race. */
dialog.formdlg.wide { width: min(660px, calc(100% - 40px)); max-height: calc(100vh - 80px); overflow-y: auto; }
dialog.formdlg.wide textarea.in { min-height: 0; font: 400 13px/1.55 var(--mono); }
dialog.formdlg h3 { margin: 0 0 6px; font: 600 19px/1.3 var(--sans); }
dialog.formdlg .dlgsub { margin: 0 0 16px; color: var(--txt-2); }
dialog.formdlg form { display: flex; flex-direction: column; gap: 14px; }
.resolution-note { border-top: 1px solid var(--green-line); background: #f3faf6; padding: 16px 22px; display: flex; flex-direction: column; gap: 6px; }
.resolution-note .t { font: 600 14px/1.3 var(--sans); color: var(--green-ink); }
.resolution-note p { margin: 0; font: 400 13px/1.55 var(--sans); color: var(--txt-2); }
.resolution-note b { font-weight: 600; color: var(--ink); }

/* ---------- env compare ---------- */
.pill-warn { background: #fdf3e3; border: 1px solid #ecdcc0; color: #8a5a12; }
.pill-info { background: #eef3f8; border: 1px solid #d5e2ee; color: #37536d; }
tr.section td {
  background: #fafaf8; padding: 9px 18px;
  font: 500 12px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: #4b5055;
}
tr.section td .soft { text-transform: none; letter-spacing: 0; color: var(--mut); font-weight: 400; }
tr.warm td { background: #fffcf6; }
tr.cool td { background: #f8fafc; }
td.val { font: 400 13px/1.4 var(--mono); word-break: break-all; }
td.val.hot { color: #8a5a12; font-weight: 500; }
.sumbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 18px; border-radius: 10px;
  background: var(--amber-bg); border: 1px solid var(--amber-line); flex-wrap: wrap;
}
.sumbar-left { display: flex; align-items: center; gap: 11px; }
.sumbar .n { font: 600 20px/1 var(--sans); color: #8a5a12; }
.sumbar .t { font: 400 14px/1.4 var(--sans); color: #7a5313; }
.legend { display: flex; align-items: center; gap: 16px; font: 400 12px/1 var(--sans); color: var(--mut); flex-wrap: wrap; }
.legend .sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.compare-pick { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.compare-pick .field { flex: 1; min-width: 220px; }

/* ---------- ops console (admin) ---------- */
.spark { display: flex; align-items: flex-end; gap: 2px; height: 108px; padding: 16px 18px 14px; }
.spark-bar {
  flex: 1 1 0; min-width: 2px; min-height: 2px; border-radius: 2px 2px 0 0;
  background: var(--line-frame);
}
.spark-bar.on { background: var(--green); }
.spark-bar.bad { background: var(--red); }
.meter { display: block; height: 6px; border-radius: 99px; background: var(--line-2); overflow: hidden; min-width: 80px; }
.meter-fill { display: block; height: 100%; border-radius: 99px; background: var(--green); }

/* Docs prose stays at reading width; the diagram gets the whole container. */
.doc-col { max-width: 860px; display: flex; flex-direction: column; gap: 22px; }

/* ---------- system diagram (docs) ---------- */
.diagram { overflow-x: auto; padding: 2px 0; }
/* Capped at the reading column: a figure wider than the text it explains reads
   as a poster, and this one is meant to be glanced at, not studied. */
.diagram svg { display: block; width: 100%; max-width: 860px; min-width: 700px; height: auto; }
.dg-box { fill: #fff; stroke: var(--line-frame); stroke-width: 1; }
.dg-plane { fill: var(--dark); stroke: var(--ink); stroke-width: 1; }
.dg-cell { fill: #1c2023; stroke: var(--dark-line); stroke-width: 1; }
.dg-chip { fill: var(--green-bg); stroke: var(--green-line); stroke-width: 1; }
.dg-arrow { stroke: var(--ctl-border); stroke-width: 1.4; fill: none; }
.dg-tip { fill: var(--mut-2); }
.dg-live { fill: var(--green); }
.dg-band { font: 500 11px var(--mono); letter-spacing: .1em; fill: var(--mut); }
.dg-band.dark { fill: var(--mut-2); }
.dg-t { font: 600 15px var(--sans); fill: var(--ink); }
.dg-t.sm { font-size: 14px; }
.dg-s { font: 400 12px var(--sans); fill: var(--txt-3); }
.dg-chip-t { font: 500 11px var(--mono); fill: var(--green-strong); }
.dg-live-t { font: 500 10px var(--mono); letter-spacing: .06em; fill: var(--mut); }
.dg-link-h { font: 500 12px var(--mono); fill: var(--ink-2); }
.dg-link { font: 400 11px var(--mono); fill: var(--mut); }
.dg-plane-t { font: 600 17px var(--sans); fill: #fff; letter-spacing: -.01em; }
.dg-plane-s { font: 400 11.5px var(--mono); fill: var(--dark-mut); }
.dg-cell-t { font: 600 13px var(--sans); fill: #fff; }
.dg-cell-s { font: 400 11px var(--mono); fill: var(--dark-mut-2); }
.dg-foot { font: 400 12px var(--sans); fill: var(--txt-3); }

/* ---------- scope graph (agent map) ---------- */
/* Capped in height: the graph is the glance and the ledger underneath is the
   detail, so it must never push the rows it summarises off the screen. */
.sg-wrap { border-bottom: 1px solid var(--line); }
.sg-wrap .sg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px 0; flex-wrap: wrap; }
.sg-cap { font: 500 10px var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); white-space: nowrap; }
.sg-key { display: flex; gap: 14px; font: 400 11px var(--sans); color: var(--txt-3); white-space: nowrap; flex-wrap: wrap; }
.sg-key span { display: inline-flex; align-items: center; gap: 6px; }
.sg-key i { display: inline-block; font-style: normal; }
.sg-key i.w { width: 18px; border-top: 2.5px solid var(--txt-2); }
.sg-key i.r { width: 18px; border-top: 1.5px dashed var(--mut-2); }
.sg-key i.c { width: 10px; height: 10px; border-radius: 99px; background: var(--red); }
.sg-key i.g { width: 16px; height: 12px; border: 1.5px dashed var(--mut-2); border-radius: 3px; }
.sg-scroll { overflow-x: auto; padding: 0 10px 4px; }
.sg { display: block; width: 100%; min-width: 660px; max-width: 900px; height: auto; }
.sg a { cursor: pointer; text-decoration: none; }
.sg-node, .sg-link, .sg-task, .sg-who { transition: opacity .15s; }
.sg-node.off { opacity: .25; }
.sg-link { fill: none; stroke: var(--txt-2); stroke-width: 2.5; }
.sg-link.read { stroke: var(--mut-2); stroke-width: 1.5; stroke-dasharray: 4 4; }
.sg-link.hot { stroke: var(--red); }
.sg-link.off { opacity: .12; }
.sg-link.past { stroke: var(--mut-2); stroke-width: 1.5; stroke-dasharray: 1 5; stroke-linecap: round; opacity: .7; }
.sg-link.past.off { opacity: .1; }
.sg-node.ended { opacity: .5; }
.sg-node.past { opacity: .55; }
.sg-node.ended.off, .sg-node.past.off { opacity: .2; }
.sg-node.past .sg-box { stroke-dasharray: 3 3; }
.sg-key i.p { width: 18px; border-top: 2px dotted var(--mut-2); }
.lrow.ended { opacity: .62; }
.lrow.ended:hover, .lrow.ended.sel { opacity: 1; }
.sg-ring { fill: none; stroke: var(--line); stroke-width: 3; }
.sg-quota { fill: none; stroke-width: 3; }
.sg-quota.ok { stroke: var(--green); }
.sg-quota.warn { stroke: var(--amber-ink); }
.sg-quota.bad { stroke: var(--red); }
.sg-pulse { fill: none; stroke: var(--green); stroke-width: 1.5; animation: sg-pulse 1.8s ease-out infinite; }
@keyframes sg-pulse { 0% { opacity: .55; r: 18px; } 100% { opacity: 0; r: 30px; } }
/* A map that breathes is pleasant; a map that breathes at somebody who asked it
   not to is not. The ring stays, it just stops moving. */
@media (prefers-reduced-motion: reduce) { .sg-pulse { animation: none; opacity: .4; } }
.sg-face { fill: #fff; stroke: var(--ctl-border); stroke-width: 2.5; }
.sg-face.live { stroke: var(--green); }
.sg-init { font: 600 8px var(--sans); fill: var(--ink); }
.sg-task { font: 500 12.5px var(--sans); fill: var(--ink); }
.sg-who { font: 400 11px var(--sans); fill: var(--mut); }
.sg-box { fill: #fff; stroke: var(--ctl-border); stroke-width: 1.2; }
.sg-box.hot { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.8; }
.sg-box.sel { stroke: var(--ink); stroke-width: 1.8; }
.sg-kind { font: 500 9.5px var(--sans); letter-spacing: .06em; fill: var(--mut); }
.sg-kind.hot { fill: #b87565; }
.sg-label { font: 400 11px var(--mono); fill: var(--ink); }
.sg-label.hot { fill: var(--red-ink); }
.sg-badge { stroke: #fff; stroke-width: 1.5; fill: var(--ink); }
.sg-badge.ok { fill: var(--ink); }
.sg-badge.warn { fill: var(--amber-ink); }
.sg-badge.bad { fill: var(--red); }
.sg-badge-t { font: 700 8px var(--mono); fill: #fff; }
.sg-sel-ring { fill: none; stroke: var(--ink); stroke-width: 1.5; stroke-dasharray: 2 3; }
.sg-group { fill: none; stroke: var(--mut-2); stroke-width: 1.2; stroke-dasharray: 4 4; }
.sg-group-t { font: 500 10px var(--sans); letter-spacing: .08em; fill: var(--mut); }
.sg-col { font: 500 10px var(--sans); letter-spacing: .1em; fill: var(--mut); }
.sg-over { padding: 0 16px 10px; font: 400 12px var(--sans); color: var(--mut); }

/* ---------- beta ceiling distance (ui/CeilingDistance) ---------- */
.cd-scroll { overflow-x: auto; padding: 4px 10px 6px; }
.cd { display: block; width: 100%; min-width: 740px; max-width: 900px; height: auto; }
.cd a { cursor: pointer; text-decoration: none; }
.cd a:hover .cd-name { fill: var(--green-strong); }
.cd-axis { stroke: var(--line); stroke-width: 1; }
.cd-track { stroke: var(--line-2); stroke-width: 1; }
.cd-sep { stroke: var(--line-3); stroke-width: 1; }
.cd-lane { font: 500 8px var(--mono); fill: var(--mut-2); }
.cd-lane.onit { fill: var(--amber-ink); }
.cd-lane.over { fill: var(--red-ink); }
.cd-ceiling { stroke: var(--ink); stroke-width: 1.4; stroke-dasharray: 3 3; }
.cd-ceiling-t { font: 500 9.5px var(--sans); letter-spacing: .1em; fill: var(--ink); }
.cd-tick { font: 400 9.5px var(--sans); fill: var(--mut-2); }
.cd-col { font: 500 10px var(--sans); letter-spacing: .1em; fill: var(--mut); }
.cd-name { font: 500 12px var(--sans); fill: var(--ink); }
.cd-cohort { font: 400 9.5px var(--mono); fill: var(--mut); }
.cd-dot { fill: #fff; stroke: var(--mut-2); stroke-width: 1.6; }
.cd-dot.onit { stroke: var(--amber-ink); fill: var(--amber-bg); }
.cd-dot.over { fill: var(--red); stroke: var(--red); }
.cd-pin { fill: var(--red); stroke: var(--red); stroke-width: 1.6; stroke-linejoin: round; }
.cd-pulse { fill: none; stroke: var(--red); stroke-width: 1.2; animation: cd-pulse 2s ease-out infinite; }
@keyframes cd-pulse { 0% { opacity: .5; r: 4px; } 100% { opacity: 0; r: 8px; } }
/* Only the marks already past a ceiling move, and only until somebody says they
   would rather nothing did. The ring stays either way. */
@media (prefers-reduced-motion: reduce) { .cd-pulse { animation: none; opacity: .35; } }
.cd-feat { fill: #fff; stroke: var(--ctl-border); stroke-width: 1.2; }
.cd-feat.in_use { fill: var(--red); stroke: var(--red); }
.cd-feat.kept { fill: var(--green-bg); stroke: var(--green-line); }
.cd-feat.unrecorded { stroke-dasharray: 2 2; }
.cd-feat-t { font: 600 8.5px var(--mono); fill: var(--mut-2); }
.cd-feat-t.in_use { fill: #fff; }
.cd-feat-t.kept { fill: var(--green-ink); }
.cd-key { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 0 16px 10px; font: 400 11px var(--sans); color: var(--txt-3); }
.cd-key span { display: inline-flex; align-items: center; gap: 5px; }
.cd-key b { font: 600 10px var(--mono); color: var(--ink); }
.cd-over { padding: 0 16px 10px; font: 400 12px var(--sans); color: var(--mut); }

/* The critical count in the status strip doubles as its own filter. */
.stripfilter { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 99px; border: 1px solid var(--red-bg-line); background: var(--red-bg); color: var(--red-ink); font: 500 11px/1 var(--sans); text-decoration: none; }
.stripfilter .d { width: 6px; height: 6px; border-radius: 99px; background: var(--red); flex: none; }
.stripfilter:hover { border-color: var(--red); }
.stripfilter.on { background: var(--red); border-color: var(--red); color: #fff; }
.stripfilter.on .d { background: #fff; }
.tab-n { margin-left: 6px; font: 400 11px var(--sans); color: var(--mut); }

/* ---------- delivery flow diagram (ui/FlowDiagram) ---------- */
.flowdg { display: block; height: 128px; }
.flow-scroll { scrollbar-gutter: stable; padding-bottom: 4px; }
.flow-scroll:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; border-radius: 4px; }
.fd-node { fill: #fff; stroke: var(--line-frame); stroke-width: 1; }
.fd-gate { stroke: var(--ink-2); }
.fd-env { fill: var(--green-bg); stroke: var(--green-line); }
.fd-title { font: 600 13px var(--sans); fill: var(--ink); }
.fd-sub { font: 400 10.5px var(--mono); fill: var(--mut); }
.fd-arrow { stroke: var(--mut); stroke-width: 1.2; }
.fd-arrowhead { fill: var(--mut); }
.fd-badge { fill: #fdf3e2; stroke: #e5cfa3; stroke-width: 1; }
.fd-badge-t { font: 600 10px var(--mono); fill: #8a5a12; }

/* ---------- fleet visuals (agent map, admin) ---------- */
.fleetbar {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
}
.fleetbar > div { padding: 14px 16px; border-right: 1px solid var(--line-2); display: flex; flex-direction: column; gap: 7px; }
.fleetbar > div:last-child { border-right: none; }
.fleetbar .n { font: 600 22px/1 var(--sans); }
.fleetbar .n.bad { color: var(--red); }
.fleetbar .n.ok { color: var(--green-strong); }
.fleet { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.fleet-card {
  background: #fff; border: 1px solid var(--line); border-radius: 10px;
  padding: 15px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
/* A person whose agents are colliding should be findable without reading a table. */
.fleet-card.hot { border-color: #e8a89b; box-shadow: inset 3px 0 0 var(--red); }
.fleet-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fleet-who { font: 600 15px/1.2 var(--sans); }
.fleet-sub { font: 400 12px/1.3 var(--sans); color: var(--mut); margin-top: 3px; word-break: break-all; }
.fleet-run { border-top: 1px solid var(--line-2); padding-top: 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.fleet-run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.fleet-task { font: 500 13px/1.4 var(--sans); min-width: 0; word-break: break-word; }
.fleet-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font: 400 12px/1.4 var(--sans); color: var(--mut); }
.fleet-line .sep { color: var(--mut-2); }
.claimtags { display: flex; flex-wrap: wrap; gap: 5px; }
.claimtag {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
  height: 20px; padding: 0 7px; border-radius: 4px;
  border: 1px solid var(--line-frame); background: #f7f7f5;
  font: 400 11px/1 var(--sans); color: #4b5055;
}
.claimtag .k { color: var(--mut-2); }
.claimtag .v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.claimtag.clash { background: #fff0ed; border-color: #e8a89b; color: #9a2c1a; }
.claimtag.clash .k { color: #b87565; }
.claimtag.more { border-style: dashed; color: var(--mut); }

/* Collision rows: two agents, one resource, drawn as the tug-of-war it is. */
.clash-row { display: grid; grid-template-columns: 1fr minmax(0, 1.15fr) 1fr; gap: 10px; align-items: center; padding: 13px 16px; border-bottom: 1px solid var(--line-2); }
.clash-row:last-child { border-bottom: none; }
.clash-side { display: flex; align-items: center; gap: 9px; min-width: 0; }
.clash-side.right { flex-direction: row-reverse; text-align: right; }
.clash-name { font: 500 13px/1.3 var(--sans); }
.clash-agent { font: 400 11px/1.3 var(--sans); color: var(--mut); word-break: break-all; }
.clash-mid { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; width: 100%; }
.clash-wire { display: flex; align-items: center; gap: 6px; width: 100%; color: var(--mut-2); }
.clash-wire::before, .clash-wire::after { content: ''; flex: 1; height: 1px; background: #e8a89b; }
.clash-res {
  max-width: 100%; padding: 4px 9px; border-radius: 5px;
  background: #fff0ed; border: 1px solid #e8a89b; color: #9a2c1a;
  font: 500 12px/1.3 var(--sans); word-break: break-all; text-align: center;
}
.clash-note { font: 400 11px/1 var(--sans); color: var(--mut); }

/* Horizontal bar list — fleet composition on the admin overview. */
.barlist { display: flex; flex-direction: column; gap: 11px; padding: 16px 18px; }
.barrow { display: grid; grid-template-columns: 132px 1fr 52px; gap: 12px; align-items: center; }
.barrow .lbl { font: 400 12px/1 var(--sans); color: var(--txt-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.barrow .track { height: 10px; border-radius: 99px; background: var(--line-2); overflow: hidden; }
.barrow .fill { display: block; height: 100%; border-radius: 99px; background: var(--mut); min-width: 2px; }
.barrow .fill.k0 { background: var(--green); }
.barrow .fill.k1 { background: var(--ink); }
.barrow .fill.k2 { background: #37536d; }
.barrow .fill.k3 { background: #8a5a12; }
/* Not ".num": that is the docs step number, a black circle with white text.
   Reusing the name inherited the circle and overrode only the colour, which
   rendered every count as dark grey on near-black. */
.barrow .barval { font: 500 12px/1 var(--sans); color: var(--txt-2); text-align: right; }
.agentchips { display: flex; flex-wrap: wrap; gap: 6px; }
.agentchip {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  border-radius: 5px; border: 1px solid var(--line-frame); background: #f7f7f5;
  font: 400 11px/1 var(--sans); color: #4b5055;
}
.agentchip .dot { width: 5px; height: 5px; }
.agentchip.off { color: var(--mut-2); background: #fafaf9; }
/* Funnel rows carry a line of prose: a step nobody can interpret is a number nobody acts on. */
.funnelrow { display: flex; flex-direction: column; gap: 4px; }
.funnelnote { font: 400 11px/1.4 var(--sans); color: var(--mut); padding-left: 182px; }
@media (max-width: 640px) { .funnelnote { padding-left: 0; } }

/* ============================================================ command console
 * The signed-in shell, from the "STMA Command console" design: rail for place,
 * status strip for truth, ledger for the record, inspector for authority.
 * Same palette and type as the rest of the system — a new layout grammar, not
 * a second design.
 */
.console { min-height: 100vh; display: flex; background: #fbfbf9; }

/* ---- rail (place) */
.rail {
  width: 216px; flex: none; background: var(--dark);
  display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
}
.rail-brand {
  height: 52px; flex: none; display: flex; align-items: center; gap: 9px;
  padding: 0 16px; border-bottom: 1px solid var(--dark-line);
}
.rail-brand .name { font: 600 15px/1 var(--sans); letter-spacing: -.01em; color: #fff; }
a.rail-brand:hover { text-decoration: none; }
/* The workspace this rail belongs to, and the way to another one. The rail is
   the column that says place, and until 2026-09-23 it named every place but the
   outermost: switching meant the scope bar's crumb or a walk back out to the
   account page. Dark, because it lives in the rail; a details element, so it
   needs no script; a plain link when there is nowhere to switch to. */
.rail-ws {
  flex: none; display: block; position: relative;
  padding: 10px 14px 11px; border-bottom: 1px solid var(--dark-line);
}
.rail-ws .cap {
  display: block; font: 500 9px/1 var(--sans); letter-spacing: .12em;
  text-transform: uppercase; color: #5f666c; margin-bottom: 5px;
}
.rail-ws .n {
  display: block; font: 500 13px/1.2 var(--sans); color: #fff;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
a.rail-ws:hover { background: #1c2023; text-decoration: none; }
details.rail-ws > summary {
  display: block; cursor: pointer; list-style: none;
  margin: -10px -14px -11px; padding: 10px 30px 11px 14px;
}
details.rail-ws > summary::-webkit-details-marker { display: none; }
details.rail-ws > summary::marker { content: ''; }
details.rail-ws > summary:hover { background: #1c2023; }
details.rail-ws > summary:hover .n { color: var(--green-bright); }
.rail-ws .caret { position: absolute; right: 14px; bottom: 13px; color: var(--dark-mut-2); font-size: 10px; }
details.rail-ws[open] > summary .caret { transform: rotate(180deg); }
.rail-ws-menu {
  position: absolute; z-index: 40; top: 100%; left: 8px; right: 8px;
  display: flex; flex-direction: column; padding: 5px;
  background: #1c2023; border: 1px solid var(--dark-line-2); border-radius: 6px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, .5);
}
.rail-ws-menu .scope-cap {
  font: 500 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase;
  color: #5f666c; padding: 6px 8px 5px;
}
.rail-ws-menu a {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px;
  font: 400 12px/1 var(--sans); color: var(--dark-mut);
}
.rail-ws-menu a:hover { background: #262c30; color: #fff; text-decoration: none; }
.rail-ws-menu a.on { color: #fff; font-weight: 500; }
.rail-ws-menu .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-ws-menu .r { font: 400 10px/1 var(--sans); color: var(--dark-mut-2); }
.rail-ws-menu .sep { height: 1px; margin: 4px 2px; background: var(--dark-line-2); }
.rail-nav { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; }
.rail-nav-toggle { display:none; }
.rail-group {
  font: 500 10px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase;
  color: #5f666c; padding: 8px 8px 6px;
}
.rail-group.later { padding-top: 18px; }
.rail-link {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 32px; padding: 0 8px; border-radius: 5px;
  font: 400 13px/1 var(--sans); color: var(--dark-mut);
}
a.rail-link:hover { background: #1c2023; color: #fff; text-decoration: none; }
.rail-link.active { background: #22272b; color: #fff; font-weight: 500; box-shadow: inset 2px 0 0 var(--green-bright); }
.rail-badge { font: 400 11px/1 var(--sans); color: var(--dark-mut-2); }
.rail-link.active .rail-badge { color: var(--green-bright); font-weight: 500; }
.rail-foot { flex: none; border-top: 1px solid var(--dark-line); padding: 12px 14px; display: flex; align-items: center; gap: 9px; }
.rail-who { min-width: 0; flex: 1; }
.rail-who .n { font: 500 12px/1.2 var(--sans); color: var(--dark-txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-who .r { font: 400 10px/1.2 var(--sans); color: var(--dark-mut-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-out { background: none; border: none; padding: 0; cursor: pointer; font: 400 11px/1 var(--sans); color: var(--dark-mut-2); }
.rail-out:hover { color: #fff; }

/* Demo credentials on a test environment's sign-in page. Deliberately plain —
   it should read as scaffolding, not as part of the product. */
/* An answer already given: the form is still reachable, folded away, because
   checking what you said is far more common than changing it. */
.answerfold > summary {
  cursor: pointer; list-style: none;
  font: 400 12px/1 var(--sans); color: var(--mut);
}
.answerfold > summary::-webkit-details-marker { display: none; }
.answerfold > summary::before { content: '+ '; }
.answerfold[open] > summary::before { content: '− '; }
.answerfold > summary:hover { color: var(--ink); }
.answerfold[open] > summary { margin-bottom: 10px; }

.demolist { display: flex; flex-direction: column; gap: 6px; }
.demorow {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff;
}

/* A modal that lets the page scroll behind it is a page with two scrollbars and
   the wrong one moving. Locked on the root element and released when the last
   dialog closes; the gutter is reserved so engaging the lock shifts nothing. */
html { scrollbar-gutter: stable; }
html.modal-open { overflow: hidden; }

/* ---- frame */
.frame { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 100vh; }

/* ---- scope bar (where: workspace, then project; and the account) */
.scopebar {
  min-height: 40px; flex: none; background: #fff; border-bottom: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 12px; font: 400 13px/1 var(--sans); color: var(--txt-2); flex-wrap: wrap;
}
.scope-path { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.scope-sep { color: var(--mut-2); }
.scope-pick { position: relative; }
.scope-at {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; max-width: 320px;
  border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink);
  font: 500 13px/1 var(--sans); cursor: pointer; list-style: none; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
a.scope-at:hover, .scope-at:hover { border-color: var(--ctl-border); text-decoration: none; }
.scope-at.all { color: var(--txt-3); font-weight: 400; }
.scope-at.in { border-color: var(--green); color: var(--green-strong); }
.scope-at::-webkit-details-marker { display: none; }
.scope-at::marker { content: ''; }
.scope-at .caret { color: var(--mut-2); font-size: 10px; }
.scope-pick[open] > .scope-at { border-color: var(--ink); }
.scope-pick[open] > .scope-at .caret { transform: rotate(180deg); }
.scope-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 240px; max-width: 360px;
  max-height: 60vh; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px;
  background: #fff; border: 1px solid var(--ctl-border); border-radius: 6px;
}
.scope-menu.right { left: auto; right: 0; min-width: 200px; }
.scope-menu a, .scope-out {
  display: flex; align-items: baseline; gap: 8px; padding: 7px 9px; border-radius: 4px; width: 100%;
  font: 400 13px/1.2 var(--sans); color: var(--txt-2); background: none; border: none; text-align: left; cursor: pointer;
}
.scope-menu a:hover, .scope-out:hover { background: #f4f4f1; color: var(--ink); text-decoration: none; }
.scope-menu a.on { color: var(--ink); font-weight: 500; }
.scope-menu .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scope-menu .r { font: 400 11px/1 var(--sans); color: var(--mut); }
.scope-menu .sep { height: 1px; margin: 3px 2px; background: var(--line); }
.scope-cap { padding: 6px 9px 4px; font: 500 10px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
.scope-me .scope-at { border-color: transparent; font-weight: 400; color: var(--txt-2); }
.scope-me .avatar { width: 20px; height: 20px; font-size: 9px; }
.rail-up { color: var(--dark-mut-2); }

/* ---- status strip (truth) */
.strip {
  height: 34px; flex: none; background: #fff; border-bottom: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 16px; font: 400 12px/1 var(--sans); color: var(--txt-3); overflow-x: auto;
}
.strip-l, .strip-r { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
.strip .lead {
  display: inline-flex; align-items: center; gap: 6px;
  font: 500 11px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--green-strong);
}
.strip .lead .dot { width: 6px; height: 6px; }
.strip .vr { width: 1px; height: 14px; background: var(--line); flex: none; }
.strip .dim { color: var(--mut-2); }
.strip .bad { color: var(--red); font-weight: 500; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px;
  border: 1px solid var(--line-frame); border-radius: 4px;
  font: 400 11px/1 var(--sans); color: var(--mut); background: #fff; white-space: nowrap;
}
a.chip:hover { border-color: var(--green); color: var(--green-strong); text-decoration: none; }
.chip b { color: var(--ink); font-weight: 500; }
/* margin: 0 is load-bearing. The base form rule carries a bottom margin, which
   inside the strip pushed this six pixels above the chips beside it and made
   the row 36px tall in a 34px bar — the misalignment the owner photographed on
   2026-09-23. Chips and controls also agree on 24px so the row has one height. */
.scopeform { display: inline-flex; align-items: center; gap: 6px; margin: 0; }
.scopeform select {
  height: 24px; max-width: 260px; padding: 0 24px 0 6px; border: 1px solid var(--line-frame);
  border-radius: 4px; font: 400 11px/1 var(--sans); color: var(--ink); background-color: #fff;
  background-position: right 8px center;
}
.scopeform .btn { height: 24px; padding: 0 9px; }
.tokhelp { font-size: 12px; color: var(--txt-2); }
.tokhelp summary { cursor: pointer; font: 500 12px/1.4 var(--sans); color: var(--green-strong); }
.tokhelp summary:hover { color: var(--green); }
.tokhelp ol { margin: 8px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.tokhelp li { line-height: 1.5; }

/* ---- page head */
.pagehead {
  flex: none; background: #fff; border-bottom: 1px solid var(--line); padding: 16px 20px;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap;
}
.pagehead h1 { margin: 0; font: 600 22px/1.2 var(--sans); letter-spacing: -.02em; }
.pagehead p { margin: 5px 0 0; font: 400 13px/1.5 var(--sans); color: var(--txt-3); max-width: 78ch; }
.pagehead .crumb { display: block; margin-bottom: 7px; font: 400 11px/1 var(--sans); color: var(--mut); }
.pagehead .crumb a { color: var(--txt-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.pagehead .crumb a:hover { color: var(--ink); text-decoration-color: var(--ink); }
.crumb-sep { color: var(--mut-2); }
.headacts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ---- alert band */
.band2 {
  flex: none; display: flex; align-items: center; gap: 14px; padding: 10px 20px;
  border-bottom: 1px solid; font: 400 13px/1.4 var(--sans); flex-wrap: wrap;
}
.band2 .tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 4px;
  color: #fff; font: 500 10px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase; flex: none;
}
.band2 .acts { margin-left: auto; display: flex; gap: 8px; flex: none; }
.band2 b { font-weight: 600; }
.band-danger { background: var(--red-bg); border-color: var(--red-bg-line); color: var(--red-ink); }
.band-danger .tag { background: var(--red); }
.band-warn { background: var(--amber-bg); border-color: var(--amber-line); color: var(--amber-ink); }
.band-warn .tag { background: #b45309; }
.band-info { background: var(--blue-bg); border-color: var(--blue-line); color: var(--blue-ink); }
.band-info .tag { background: #37536d; }

/* ---- body: ledger + inspector */
.cbody { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.cmain { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #fff; }
.cpad { padding: 24px 20px 40px; display: flex; flex-direction: column; gap: 20px; }
.readiness-stack { display: flex; flex-direction: column; gap: 14px; max-width: 960px; min-width: 0; }
.readiness-stack > h1, .readiness-stack > h2, .readiness-stack > p, .readiness-stack > ol { margin-top: 0; margin-bottom: 0; }
.readiness-stack code { overflow-wrap: anywhere; }
.readiness-stack input, .readiness-stack select, .readiness-stack textarea { max-width: 100%; box-sizing: border-box; }
.rail-nav details > summary { cursor: pointer; }
.inspector {
  width: 392px; flex: none; background: #fff; border-left: 1px solid var(--line);
  display: flex; flex-direction: column; min-height: 0;
}

/* ---- ledger */
.ledger { display: flex; flex-direction: column; }
.lhead, .lrow { display: grid; align-items: center; gap: 10px; padding: 0 14px; }
.lhead {
  height: 32px; background: #f7f7f5; border-bottom: 1px solid var(--line);
  font: 500 10px/1 var(--sans); letter-spacing: .09em; text-transform: uppercase; color: var(--mut);
}
.lrow { padding: 11px 14px; border-bottom: 1px solid var(--line-2); }
a.lrow { color: inherit; }
a.lrow:hover { background: #fafaf8; text-decoration: none; color: inherit; }
.lrow.sel { background: #f4f8f6; }
a.lrow.sel:hover { background: #eef5f1; }
.lend { padding: 11px 14px; border-bottom: 1px solid var(--line-2); font: 400 12px/1.4 var(--sans); color: var(--mut); }
/* Column templates live here, not in an inline style, so the narrow-screen
   rules below can drop columns instead of squeezing six of them to three
   characters each. */
.grid-runs { grid-template-columns: 26px minmax(0, 1.5fr) minmax(0, 1.2fr) minmax(0, 1fr) 88px 92px; }
.lcell { min-width: 0; }
.lcell .t { font: 500 13px/1.35 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lcell .s { margin-top: 3px; font: 400 11px/1.3 var(--sans); color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmono {
  font: 400 11px/1.4 var(--mono); color: var(--txt-3); min-width: 0;
  /* Truncate rather than break inside a path: a ledger row that reflows to three
     lines stops being scannable, and the inspector holds the full value. */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lmono .l2 { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmono .l2 + .l2 { margin-top: 3px; color: var(--mut); }
.lwhen { font: 400 11px/1 var(--sans); color: var(--txt-2); }
.lwhen.old { color: var(--mut); }

/* ---- inspector sections */
.ins-head { padding: 14px 18px; border-bottom: 1px solid var(--line); }
.ins-title { font: 600 17px/1.25 var(--sans); letter-spacing: -.01em; overflow-wrap: anywhere; }
/* A path is read character by character, so the inspector shows one in mono. */
.ins-title.mono { font: 600 15px/1.3 var(--mono); letter-spacing: 0; }
.ins-kicker { display: block; margin-bottom: 6px; font: 500 10px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
a.holds { text-decoration: none; color: inherit; }
a.holds:hover { border-color: var(--ctl-border); background: #fff; }
.ins-meta { margin-top: 7px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 400 12px/1 var(--sans); color: var(--txt-3); }
.ins-acts { padding: 12px 18px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; }
.ins-sec { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
.ins-sec:last-child { border-bottom: none; }
.ins-label { font: 500 10px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
.ins-empty { padding: 44px 20px; text-align: center; font: 400 13px/1.6 var(--sans); color: var(--mut); }
.holds { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid var(--line-frame); border-radius: 6px; background: #fafaf8; font: 400 12px/1.35 var(--mono); overflow-wrap: anywhere; }
.holds.hot { border-color: #e8a89b; background: var(--red-bg); color: var(--red-ink); }
.holds .k { color: var(--mut-2); flex: none; }
.holds.hot .k { color: #b87565; }
.check { display: flex; align-items: flex-start; gap: 9px; font: 400 12px/1.5 var(--sans); color: var(--txt-2); }
.check .y { color: var(--green); flex: none; }
.check .n { color: var(--red); flex: none; }
.check .w { color: #b45309; flex: none; }
.trail { display: flex; flex-direction: column; gap: 6px; font: 400 11px/1.55 var(--sans); color: var(--txt-2); }
.trail .at { color: var(--mut); }

/* ---- keyboard hint bar */
.keys {
  height: 28px; flex: none; border-top: 1px solid var(--line); background: #fff;
  display: flex; align-items: center; gap: 16px; padding: 0 16px;
  font: 400 11px/1 var(--sans); color: var(--mut); overflow-x: auto; white-space: nowrap;
}
.keys b { color: var(--ink); font-weight: 500; font-family: var(--mono); }
.keys .note { margin-left: auto; }

@media (max-width: 900px) {
  .activity-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .activity-search { grid-column: span 2; }
  /* A ledger is a desktop instrument. On a phone it becomes a list: identity,
     when, and the one verdict that matters — the rest is in the inspector,
     which now sits directly underneath. */
  .lhead { display: none; }
  .grid-runs { grid-template-columns: 14px minmax(0, 1fr) auto; }
  .hide-sm { display: none; }
  .console { flex-direction: column; }
  /* The rail lies down, and then it has to WRAP. Left as one row it gave the
     brand and the identity the width they asked for and squeezed the whole of
     the navigation into what was left — 59px at 375px, holding 580px of links,
     scrollable with nothing on screen saying so. The no-script fallback wraps
     destinations; enhanced mobile navigation uses the labelled Menu control. */
  .rail { width: 100%; height: auto; position: static; flex-direction: row; align-items: center; flex-wrap: wrap; }
  .rail-brand { border-bottom: none; border-right: 1px solid var(--dark-line); }
  /* Laid down as a row, the switcher sits beside the brand and the bottom
     border would draw a short line under one item only. */
  .rail-ws { border-bottom: none; padding: 8px 14px 9px; }
  .rail-ws-menu { left: 0; right: auto; min-width: 220px; max-width: calc(100vw - 24px); }
  .rail-nav {
    order: 2; flex: 1 0 100%; flex-direction: row; flex-wrap: wrap; gap: 4px;
    padding: 8px 10px; overflow: visible; border-top: 1px solid var(--dark-line);
  }
  .rail-link { flex: none; height: 28px; padding: 0 9px; font-size: 12px; background: #1c2023; }
  .rail-group { display: none; }
  .rail-nav details > summary.rail-group { display: block; padding: 8px 9px; margin: 0; color: var(--dark-txt-2); }
  .rail-foot { border-top: none; border-left: 1px solid var(--dark-line); margin-left: auto; }
  .frame { min-height: 0; }
  .cbody { flex-direction: column; }
  .inspector { width: 100%; border-left: none; border-top: 1px solid var(--line); }
  .keys { display: none; }
}

@media (max-width: 960px) {
  .grid2 { grid-template-columns: 1fr; }
  .pricing-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .appnav-user { display: none; }
  .scopeform select { max-width: 200px; }
  .activity-filters { grid-template-columns: 1fr; }
  .activity-search { grid-column: auto; }
}

/* ---------- v2: the team switcher, page tabs, stat strips and reading layouts ---------- */
/* Ported from the "STMA v2" prototype. Everything above is unchanged: v2 keeps
   the whole design system and adds the components the new screens are built
   from. What is deliberately NOT here is the prototype's own scaffolding — the
   floating screen switcher and the padding it needed — because that exists to
   demo twenty screens in one file, not to ship. */


.railme { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; }
.railme:hover { text-decoration: none; }
.railme:hover .n { color: #fff; }

.pagetabs { background: #fff; border-bottom: 1px solid var(--line); padding: 0 20px; display: flex; gap: 2px; }

/* The Assign work ticket picker. A bounded list inside a dialog that already
   scrolls, so it scrolls itself instead: twenty rows at the ledger's own row
   height would push Agent and Brief off the bottom of the dialog. */
.tickets { border: 1px solid var(--line); border-radius: 9px; max-height: 250px; overflow-y: auto; background: #fff; }
.tickets .introw { padding: 9px 12px; }
.tickets a.introw { color: inherit; text-decoration: none; }
.tickets a.introw:hover { background: var(--line-2); text-decoration: none; }
.tickets .introw[aria-current] { background: var(--green-bg); }

.introw { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line-2); }
.introw:last-child { border-bottom: none; }
.introw .who { flex: 1; min-width: 0; }
.introw .who .t { font: 500 14px/1.3 var(--sans); }
.introw .who .s { margin-top: 2px; font: 400 12px/1.4 var(--sans); color: var(--mut); }

.stat3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.stat3 > div { padding: 14px 16px; border-right: 1px solid var(--line-2); display: flex; flex-direction: column; gap: 7px; }
.stat3 > div:last-child { border-right: none; }
.stat3 .n { font: 600 20px/1 var(--sans); }
.stat3 .n.ok { color: var(--green-strong); }
.stat3 .n.bad { color: var(--red); }

.docgrid { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 32px; align-items: start; }
.sidetoc { position: sticky; top: 16px; display: flex; flex-direction: column; gap: 2px; }
.sidetoc a { padding: 6px 10px; border-left: 2px solid var(--line-2); font: 400 13px/1.3 var(--sans); color: var(--txt-3); }
.sidetoc a:hover { color: var(--ink); text-decoration: none; }
.sidetoc a.on { color: var(--green-strong); font-weight: 500; border-left-color: var(--green); }

.toolrow { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 14px; padding: 10px 18px; border-bottom: 1px solid var(--line-2); }
.toolrow:last-child { border-bottom: none; }
.toolrow .tn { font: 400 13px/1.4 var(--mono); color: var(--txt-3); }
.toolrow .td { font: 400 13px/1.5 var(--sans); }

/* Editor layout: the document on the left, what it will produce on the right. */
.edgrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 20px; align-items: start; }

/* Wide screens (phase 4 of the console plan; measured at 1920 and 2560, 2026-09-20).
   Cards and tables are fluid and should be: a ledger wants the room. What must not grow
   with them is a line of prose or a form field — the sweep found 1607px inputs and
   200-character lines on seven pages. Text keeps a readable measure and a field a usable
   width however wide the card around it gets; the room goes to tables, ledgers and second
   columns, never to centring the content. An inline max-width still wins where a page
   means it. */
:root { --measure: 88ch; --field-max: 720px; }
.cpad p, .cpad li, .card-note, .field .help, .dlgsub, .doc-col p, .doc-col li { max-width: var(--measure); }
.field, input.in, textarea.in, select.in { max-width: var(--field-max); }

/* Past about 2300px the agent map's graph (capped at 900px, because an SVG that scales with
   width draws glyphs the size of a fist) left a thousand pixels of nothing beside it. There
   the graph and the ledger stand side by side; below it they stack as before. */
@media (min-width: 2300px) {
  .map-split { display: grid; grid-template-columns: minmax(660px, 900px) minmax(0, 1fr); align-items: start; }
  .map-split > .sg-wrap { border-bottom: none; border-right: 1px solid var(--line); }
  .map-split.solo { display: block; }
}

/* The ledger stops being squeezed before the inspector does. */
.cbody .cmain { min-width: 520px; }
@media (max-width: 1200px) {
  .cbody { overflow-x: auto; }
  .inspector { width: 320px; min-width: 320px; }
}
@media (max-width: 960px) {
  .cbody .cmain { min-width: 420px; }
  .lrow.grid-runs, .lhead.grid-runs { grid-template-columns: 26px minmax(0, 1.4fr) minmax(0, 1.6fr) 92px; }
  .grid-runs > *:nth-child(4), .grid-runs > *:nth-child(5) { display: none; }
  .docgrid { grid-template-columns: 1fr; gap: 18px; }
  .sidetoc { position: static; flex-direction: row; flex-wrap: wrap; }
  .edgrid { grid-template-columns: 1fr; }
  .toolrow { grid-template-columns: 1fr; gap: 4px; }
}
@media (max-width: 640px) {
  .cbody .cmain { min-width: 0; width: 100%; }
  .cpad { padding: 20px 14px 32px; }
  .readiness-stack .btn { white-space: normal; text-align: left; }
}
@media(max-width:900px) {
  /* Progressive enhancement: without JS every destination remains visible. */
  .rail.nav-ready:not(.nav-open) .rail-nav { display:none; }
  .rail.nav-ready .rail-nav-toggle { display:block; order:1; margin:10px; padding:8px 12px; border:1px solid var(--dark-line-2); border-radius:5px; color:#fff; background:#1c2023; font:500 12px var(--sans); }
  .rail .rail-brand,.rail .rail-ws,.rail .rail-foot { order:0; }
  .rail .rail-foot { padding:10px; max-width:calc(100% - 106px); }
  .scopebar { padding: 6px 10px; }
  .scope-at { max-width: 46vw; }
  .scope-menu { max-width: calc(100vw - 24px); }
  .rail .rail-nav { order:2; }
  .inspector { width:100%; min-width:0; }
}

/* ---------- controls nobody gave a class (2026-09-22) ----------
   A console built page by page grew controls outside the design system: a select
   in the platform's own chrome beside a green button, a file input still reading
   "Choose file" in the browser's language, a disclosure triangle from 1998 on half
   the folded sections. Everything below is a default at zero specificity (:where),
   so any rule a page already wrote still wins; it only catches what nobody styled. */
:where(input, select, textarea, button) { font-family: inherit; }
input[type="checkbox"], input[type="radio"] { accent-color: var(--green); }
:where(.frame, dialog) :where(select:not([class])) {
  height: 34px; max-width: 100%; padding: 0 30px 0 10px;
  border: 1px solid var(--ctl-border); border-radius: 7px; background-color: #fff;
  font: 400 13px/1.2 var(--sans); color: var(--ink);
}
:where(.frame, dialog) :where(input:not([class]):not([type="hidden"], [type="checkbox"], [type="radio"], [type="file"], [type="submit"], [type="button"], [type="range"], [type="color"])) {
  height: 36px; max-width: 100%; padding: 0 11px;
  border: 1px solid var(--ctl-border); border-radius: 7px; background: #fff;
  font: 400 13px/1.2 var(--sans); color: var(--ink);
}
:where(.frame, dialog) :where(textarea:not([class])) {
  max-width: 100%; padding: 10px 12px; border: 1px solid var(--ctl-border); border-radius: 8px;
  background: #fff; font: 400 13px/1.5 var(--sans); color: var(--ink); resize: vertical;
}
:where(.frame, dialog) :where(select:not([class]), input:not([class]), textarea:not([class])):focus {
  outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(0,145,90,.14);
}
/* One chevron for every select, classed or not, instead of each platform's own. */
select.in, .activity-filters select, .scopeform select,
:where(.frame, dialog) :where(select:not([class])) {
  -webkit-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f94' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 11px center; background-size: 10px 6px;
}
select.in, .activity-filters select { padding-right: 30px; }
select:disabled { opacity: .6; cursor: not-allowed; }
/* The file picker's button speaks the design system; its label stays the browser's. */
input[type="file"] { max-width: 100%; font: 400 13px/1.3 var(--sans); color: var(--txt-2); }
input[type="file"]::file-selector-button {
  height: 30px; margin-right: 10px; padding: 0 12px; cursor: pointer;
  border: 1px solid var(--ctl-border); border-radius: 6px; background: #fff;
  font: 500 12.5px/1 var(--sans); color: var(--ink);
}
input[type="file"]::file-selector-button:hover { background: #f7f7f5; }
input.in[type="file"] { height: auto; padding: 5px; }
/* Folded sections: a drawn chevron, not the platform triangle. The three folds that
   draw their own marker (cards, answers, the scope pickers) are left alone. */
details:not(.fold-card, .scope-pick, .answerfold) > summary:not(.scope-at, .rail-group) { list-style: none; cursor: pointer; }
details:not(.fold-card, .scope-pick, .answerfold) > summary:not(.scope-at, .rail-group)::-webkit-details-marker { display: none; }
details:not(.fold-card, .scope-pick, .answerfold) > summary:not(.scope-at, .rail-group)::before {
  content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 10px 2px 2px; vertical-align: middle;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); opacity: .55; transition: transform .15s ease;
}
details[open]:not(.fold-card, .scope-pick, .answerfold) > summary:not(.scope-at, .rail-group)::before { transform: rotate(45deg); margin-bottom: 4px; }
details:not(.fold-card, .scope-pick, .answerfold) > summary:not(.scope-at, .rail-group):hover::before { opacity: 1; }
@media (prefers-reduced-motion: reduce) { details > summary::before { transition: none; } }
/* A column a tab left with nothing in it still took a gap: the band of blank above
   the Integrations tab was an empty .col plus the 24px after it. */
.col:empty { display: none; }

/* Two flow columns beside an inspector left the first one about 230px on a laptop,
   and every sentence in it wrapped after three words. Beside an inspector they
   stack until the screen can give both a readable measure. */
@media (max-width: 1500px) {
  .cbody:has(> .inspector) .flow-columns { grid-template-columns: 1fr; }
  .cbody:has(> .inspector) .flow-columns > :first-child { border-right: 0; border-bottom: 1px solid var(--line); }
}

/* A run row names its task and owner first; the ground it holds is the detail, and a
   long list of claims used to take the width and squeeze the task to one word a line. */
.introw-claims { flex: 0 1 45%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.introw .who .t, .introw .who .s { overflow-wrap: anywhere; }

/* ---------- integrations (team page, Integrations tab) ---------- */
.integ-head { display: flex; align-items: center; gap: 12px; }
.integ-mark {
  width: 36px; height: 36px; flex: none; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--dark); color: #fff; font: 600 12px/1 var(--sans); letter-spacing: .02em;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
}
.integ-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
/* A field whose label wraps it: the visible name a placeholder never was. */
.ifield { display: flex; flex-direction: column; gap: 6px; max-width: var(--field-max); }
.ifield > span { font: 500 12.5px/1.2 var(--sans); color: var(--ink); }

/* ---------- the first-result card (ui/FirstExchange) ---------- */
.xchg { display: flex; flex-direction: column; overflow: hidden; }
.xchg-head { padding: 20px 22px 4px; display: flex; flex-direction: column; gap: 6px; }
.xchg-head .overline { color: var(--green-strong); }
.xchg-head h3 { margin: 0; font: 600 18px/1.3 var(--sans); letter-spacing: -.01em; }
.xchg-head p { margin: 0; font: 400 13.5px/1.6 var(--sans); color: var(--txt-2); }
.xchg-steps {
  margin: 14px 22px 0; padding: 0; list-style: none; counter-reset: xchg;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;
}
.xchg-steps li {
  counter-increment: xchg; position: relative; display: flex; flex-direction: column; gap: 4px;
  padding: 12px 14px 13px; border: 1px solid var(--line); border-radius: 9px; background: #fafaf8;
}
.xchg-steps li::before {
  content: counter(xchg); width: 22px; height: 22px; margin-bottom: 4px; border-radius: 99px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); font: 600 11px/1 var(--sans);
}
.xchg-steps b { font: 600 13px/1.3 var(--sans); color: var(--ink); }
.xchg-steps span { font: 400 12px/1.5 var(--sans); color: var(--txt-3); }
.xchg-foot {
  margin-top: 16px; padding: 16px 22px 18px; border-top: 1px solid var(--line); background: #fcfcfa;
  display: flex; flex-direction: column; gap: 10px;
}
.xchg-form { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin: 0; }
.xchg-form .field { min-width: 220px; }
.xchg-foot .card-note { margin: 0; }
@media (max-width: 720px) { .xchg-steps { grid-template-columns: 1fr; } }

/* A bare <pre> is a block of text somebody will copy: set it like one. */
:where(.frame, dialog) :where(pre:not([class])) {
  margin: 0; padding: 12px 14px; max-height: 420px; overflow: auto;
  border: 1px solid var(--line); border-radius: 8px; background: #f7f7f5;
  font: 400 12px/1.6 var(--mono); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere;
}
` + siteCss;
