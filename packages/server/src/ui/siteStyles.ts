/**
 * The signed-out site's own rules: the landing page (`ui/Landing.tsx`).
 *
 * Kept beside the console's stylesheet rather than inside it because the two
 * are read for different reasons — a console rule is judged against a ledger
 * somebody works in all day, a landing rule against a first impression — and
 * appended to it (`css` in `ui/styles.ts`), so the browser still fetches one
 * content-hashed file. Same type, same green: a second page grammar, not a
 * second design system. The page itself is dark (the 2026-10 homepage design),
 * the console it draws inside it stays light, and the header and footer are the
 * shared frame (`ui/Site.tsx`) re-skinned under `body.lx` rather than copies.
 */

/**
 * The feature exchanges on the landing page are tabs without script: a radio
 * per tab ahead of the list and the panels, and a sibling selector per key.
 * The keys live here because the rules are generated from them; `Landing.tsx`
 * renders one input per tab and `visuals.test.ts` fails if a tab has no rule.
 */
export const LX_TAB_KEYS = ['rules', 'handoff', 'assign', 'env', 'evidence', 'ledger'] as const;

export const siteCss = /* css */ `/* ---------- the page: dark, and the shared frame drawn to match ---------- */
html:has(body.lx) { background: #0f1214; }
body.lx { background: #0f1214; color: #d6dadd; -webkit-font-smoothing: antialiased; text-wrap: pretty; }
.lx a { color: #7fd7ae; }
.lx a:hover { color: #00c37a; }
.lx .container { max-width: 1200px; padding: 0 32px; }
.lx-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* header and footer are the signed-out frame (ui/Site.tsx); only the skin is the page's */
.lx .site-head { border-bottom-color: #23272b; background: rgba(15,18,20,.82); }
.lx .brand, .lx .logo { color: #fff; }
.lx .site-nav a.plain { color: #9aa0a6; }
.lx .site-nav a.plain:hover, .lx .site-nav a.plain.on { color: #fff; }
.lx .btn { background: transparent; border-color: #3a4045; color: #fff; }
.lx .btn:hover { background: #1c2023; color: #fff; text-decoration: none; }
.lx .btn.btn-primary { background: #00915a; border-color: #007a4c; }
.lx .btn.btn-primary:hover { background: #00734a; border-color: #007a4c; }
.lx .site-foot { border-top-color: #23272b; background: #0b0d0f; }
.lx .foot-brand p { color: #9aa0a6; }
.lx .foot-col h5 { color: #7d848a; }
.lx .foot-col a { color: #c9ced2; }
.lx .foot-col a:hover { color: #fff; }
.lx .foot-addr { color: #7d848a; }
.lx .foot-base { border-top-color: #1c2023; color: #7d848a; }

/* ---------- hero ---------- */
.lx-hero { position: relative; isolation: isolate; overflow: hidden; padding: 88px 0 96px; text-align: center; }
.lx-hero::before {
  content: ''; position: absolute; inset: 0; z-index: -2; pointer-events: none;
  background-image: radial-gradient(rgba(255,255,255,.07) 1px, transparent 1.3px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 72% 55% at 50% 20%, #000 30%, transparent 78%);
  mask-image: radial-gradient(ellipse 72% 55% at 50% 20%, #000 30%, transparent 78%);
}
.lx-hero::after {
  content: ''; position: absolute; z-index: -1; pointer-events: none;
  left: 50%; top: -340px; width: 1300px; height: 820px; transform: translateX(-50%);
  background: radial-gradient(closest-side, rgba(0,195,122,.22), rgba(0,195,122,.07) 55%, transparent 100%);
}
.lx-eyebrow {
  display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 13px 0 11px;
  border-radius: 99px; background: rgba(255,255,255,.04); border: 1px solid #2f3439;
  font: 500 12px/1 var(--mono); letter-spacing: .04em; color: #9aa0a6;
  white-space: nowrap; max-width: 100%;
}
.lx-eyebrow b { color: #00c37a; font-weight: 500; }
.lx-eyebrow .sep { color: #5f666c; }
.lx-eyebrow .dot { background: #00c37a; box-shadow: 0 0 0 3px rgba(0,195,122,.22); }
.lx-h1 {
  margin: 24px auto 0; max-width: 19ch;
  font: 680 66px/1.02 var(--sans); letter-spacing: -.045em; color: #fff; text-wrap: balance;
}
.lx-h1 em {
  font-style: normal;
  background: linear-gradient(95deg, #00c37a 10%, #7fd7ae 90%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.lx-lede { margin: 24px auto 0; max-width: 56ch; font: 400 19px/1.6 var(--sans); color: #b9bec3; }
.lx-ctas { margin-top: 30px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.lx .btn-lg { height: 46px; padding: 0 22px; font-size: 16px; border-radius: 8px; }
.lx .btn-glow { box-shadow: 0 14px 30px -12px rgba(0,195,122,.6), inset 0 1px 0 rgba(255,255,255,.18); }
.lx-micro {
  margin-top: 16px; display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 14px;
  font: 400 13px/1.4 var(--sans); color: #7d848a;
}
.lx-micro i { font-style: normal; color: #3a4045; }
.lx-stage { margin-top: 64px; }
.lx-caps { margin-top: 28px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 24px; text-align: left; }
.lx-cap { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 4px 10px; }
.lx-cap .lx-no { width: 22px; height: 22px; font-size: 11px; box-shadow: none; }
.lx-cap b { font: 600 15px/1.4 var(--sans); color: #fff; }
.lx-cap .d { grid-column: 2; font: 400 13.5px/1.55 var(--sans); color: #a8adb2; }

.lx-window {
  border-radius: 14px; background: #fff; border: 1px solid #2f3439;
  box-shadow: 0 60px 120px -40px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04);
  overflow: hidden; text-align: left; color: var(--ink);
}
.lx-bar { height: 40px; display: flex; align-items: center; gap: 14px; padding: 0 14px; border-bottom: 1px solid var(--line); background: #f6f6f3; }
.lx-dots { display: inline-flex; gap: 6px; flex: none; }
.lx-dots i { display: block; width: 10px; height: 10px; border-radius: 99px; background: #dcdcd5; }
.lx-url {
  flex: 1; max-width: 420px; margin: 0 auto; height: 24px; border-radius: 6px;
  background: #fff; border: 1px solid var(--line); display: flex; align-items: center; justify-content: center;
  font: 400 11.5px/1 var(--mono); color: var(--mut); overflow: hidden; white-space: nowrap;
}
.lx-live { display: inline-flex; align-items: center; gap: 6px; flex: none; font: 500 10.5px/1 var(--mono); letter-spacing: .1em; color: var(--green-strong); }
.lx-live .dot { animation: lx-blink 2s ease-in-out infinite; }
@keyframes lx-blink { 50% { opacity: .35; } }
.lx-app { display: grid; grid-template-columns: 176px minmax(0, 1fr) 272px; min-height: 480px; }
.lx-rail { background: var(--dark); padding: 12px 10px 16px; display: flex; flex-direction: column; gap: 2px; }
.lx-rail-brand { display: flex; align-items: center; gap: 8px; padding: 2px 6px 12px; margin-bottom: 6px; border-bottom: 1px solid var(--dark-line); font: 600 13px/1 var(--sans); color: #fff; }
.lx-rail-brand .logo { width: 18px; height: 18px; }
.lx-rail-g { padding: 10px 6px 5px; font: 500 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: #5f666c; }
.lx-rail-i { display: flex; align-items: center; justify-content: space-between; height: 27px; padding: 0 8px; border-radius: 5px; font: 400 12px/1 var(--sans); color: var(--dark-mut); }
.lx-rail-i b { font: 400 10px/1 var(--mono); color: var(--dark-mut-2); }
.lx-rail-i.on { background: #22272b; color: #fff; font-weight: 500; box-shadow: inset 2px 0 0 var(--green-bright); }
.lx-rail-i.on b { color: var(--green-bright); }
.lx-main { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
.lx-strip {
  height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--line);
  font: 400 11.5px/1 var(--sans); color: var(--txt-3); white-space: nowrap; overflow: hidden;
}
.lx-lead { display: inline-flex; align-items: center; gap: 6px; font: 500 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--green-strong); }
.lx-chip { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8px; border: 1px solid var(--line-frame); border-radius: 4px; font: 400 10.5px/1 var(--mono); color: var(--mut); }
.lx-chip b { color: var(--ink); font-weight: 500; }
.lx-chip.bad { border-color: var(--red-bg-line); background: var(--red-bg); color: var(--red-ink); }
.lx-chip.bad i { width: 6px; height: 6px; border-radius: 99px; background: var(--red); }
.lx-graph { padding: 8px 10px 0; border-bottom: 1px solid var(--line); }
.lxg { display: block; width: 100%; height: auto; }
.lxg-col { font: 500 9px var(--sans); letter-spacing: .12em; fill: var(--mut); }
.lxg-link { fill: none; stroke: var(--txt-2); stroke-width: 2.2; }
.lxg-link.read { stroke: var(--mut-2); stroke-width: 1.4; stroke-dasharray: 4 4; }
.lxg-link.hot { stroke: var(--red); }
.lxg-task { font: 500 11.5px var(--sans); fill: var(--ink); }
.lxg-who { font: 400 10px var(--mono); fill: var(--mut); }
.lxg-ring { fill: none; stroke: var(--line); stroke-width: 3; }
.lxg-quota { fill: none; stroke-width: 3; stroke-linecap: round; }
.lxg-quota.ok { stroke: var(--green); }
.lxg-quota.warn { stroke: #b7791f; }
.lxg-face { fill: #fff; stroke: var(--ctl-border); stroke-width: 2; }
.lxg-face.live { stroke: var(--green); }
.lxg-pulse { fill: none; stroke: var(--green); stroke-width: 1.4; animation: lxg-pulse 2.2s ease-out infinite; }
@keyframes lxg-pulse { 0% { opacity: .55; r: 16px; } 100% { opacity: 0; r: 27px; } }
.lxg-run.idle { opacity: .55; }
.lxg-init { font: 600 8px var(--sans); fill: var(--ink); }
.lxg-badge { fill: var(--ink); stroke: #fff; stroke-width: 1.5; }
.lxg-badge.bad { fill: var(--red); }
.lxg-badge.unk { fill: var(--mut-2); }
.lxg-badge-t { font: 700 7.5px var(--mono); fill: #fff; }
.lxg-box { fill: #fff; stroke: var(--ctl-border); stroke-width: 1.1; }
.lxg-box.hot { fill: var(--red-bg); stroke: var(--red); stroke-width: 1.6; }
.lxg-kind { font: 500 7.5px var(--sans); letter-spacing: .08em; fill: var(--mut); }
.lxg-kind.hot { fill: #b87565; }
.lxg-label { font: 400 10px var(--mono); fill: var(--ink); }
.lxg-label.hot { fill: var(--red-ink); }
.lx-ledger { display: flex; flex-direction: column; }
.lx-lrow {
  display: grid; grid-template-columns: minmax(0, 1.4fr) 80px 90px 128px; align-items: center; gap: 10px;
  padding: 9px 14px; border-bottom: 1px solid var(--line-2); font: 400 12px/1.3 var(--sans); color: var(--txt-2);
}
.lx-lrow b { color: var(--ink); font-weight: 600; }
.lx-lrow .m { font: 400 11px/1 var(--mono); color: var(--mut); }
.lx-lrow.head { padding: 8px 14px; background: #f7f7f5; font: 500 9px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--mut); }
.lx-lrow.sel { background: #f4f8f6; }
.lx-pill {
  justify-self: start; display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 99px;
  border: 1px solid var(--line); background: #f7f7f5; font: 500 10px/1 var(--mono); letter-spacing: .02em; color: var(--mut);
}
.lx-pill.ok { border-color: var(--green-line); background: var(--green-bg); color: var(--green-strong); }
.lx-pill.bad { border-color: var(--red-bg-line); background: var(--red-bg); color: var(--red-ink); }
.lx-ins { display: flex; flex-direction: column; gap: 7px; padding: 16px 16px 20px; background: #fff; min-width: 0; }
.lx-kick { font: 500 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--mut); }
.lx-ins-t { font: 600 15px/1.25 var(--sans); letter-spacing: -.01em; color: var(--ink); }
.lx-ins-m { font: 400 10.5px/1.3 var(--mono); color: var(--txt-3); }
.lx-ins-l { margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--line); font: 500 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--mut); }
.lx-holds { padding: 8px 9px; border: 1px solid var(--line-frame); border-radius: 6px; background: #fafaf8; font: 400 11px/1.3 var(--mono); overflow-wrap: anywhere; }
.lx-holds.hot { border-color: #e8a89b; background: var(--red-bg); color: var(--red-ink); }
.lx-ins-p { font: 400 12px/1.5 var(--sans); color: var(--txt-2); }
.lx-ins-p b { color: var(--ink); }
.lx-check { display: flex; gap: 8px; font: 400 11.5px/1.45 var(--sans); color: var(--txt-2); }
.lx-check i { font-style: normal; flex: none; width: 12px; }
.lx-check .y { color: var(--green); }
.lx-check .w { color: #b45309; font-weight: 700; }
.lx-check code { font: 400 10.5px var(--mono); color: var(--ink); }

.lx-no {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 19px; height: 19px; border-radius: 99px; background: #00c37a; color: #0f1214;
  font: 600 10px/1 var(--mono); box-shadow: 0 0 0 3px rgba(0,195,122,.22);
}
.lxg-no { fill: #00c37a; stroke: #fff; stroke-width: 2; }
.lxg-no-t { font: 600 9.5px var(--mono); fill: #0f1214; }
.lx-check.warn { align-items: flex-start; padding: 6px 7px; margin: 0 -7px; border-radius: 6px; background: #fdf8ef; }
.lx-check.warn > span:not(.lx-no) { flex: 1; }
.lx-check.warn .lx-no { box-shadow: none; }

/* ---------- sections ---------- */
.lx-sec { padding: 104px 0; }
.lx-sec-pad { padding: 96px 0; }
.lx-alt { background: #14171a; border-top: 1px solid #23272b; border-bottom: 1px solid #23272b; }
.lx-line { border-bottom: 1px solid #23272b; }
.lx-ov { font: 500 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #00c37a; }
.lx-ov.dim { color: #7d848a; }
.lx-ov.wide { letter-spacing: .12em; }
.lx-h2 { margin: 14px 0 0; font: 650 44px/1.05 var(--sans); letter-spacing: -.04em; color: #fff; text-wrap: balance; }
.lx-h2.lg { font-size: 48px; line-height: 1.03; letter-spacing: -.045em; }
.lx-h2.sm { margin-top: 12px; font-size: 42px; line-height: 1.06; letter-spacing: -.035em; }
.lx-coord .lx-h2 { font-size: 52px; line-height: 1.02; letter-spacing: -.045em; }
.lx-sub { margin: 18px 0 0; max-width: 46ch; font: 400 17px/1.6 var(--sans); color: #a8adb2; }
.lx-sub.dim { margin-top: 14px; font-size: 15px; color: #7d848a; }
.lx-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 24px 64px; }
.lx-split.lx-end { align-items: end; }
.lx-split.lx-end .lx-sub { margin: 0; }
.lx-split.lx-mid { align-items: center; gap: 48px 64px; }
.lx-head { max-width: 760px; }
.lx-head .lx-sub { margin-top: 14px; max-width: 56ch; }

/* an agent's session */
.lx-sess {
  min-width: 0; border-radius: 14px; background: #0a0c0e; border: 1px solid #2f3439;
  overflow: hidden; box-shadow: 0 40px 80px -40px rgba(0,0,0,.8);
}
.lx-sess-bar {
  height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid #23272b;
  font: 400 11.5px/1 var(--mono); color: #7d848a; white-space: nowrap; overflow: hidden;
}
.lx-sess-bar b { color: #fff; font-weight: 500; }
.lx-sess-bar span { margin-left: auto; }
.lx-sess-body { padding: 18px 18px 22px; display: flex; flex-direction: column; gap: 12px; }
.lx-ln { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; font: 400 12.5px/1.6 var(--mono); color: #9aa0a6; overflow-wrap: anywhere; }
.lx-ln .g { color: #7fd7ae; }
.lx-ln .r { color: #e08f7a; }
.lx-ln .m { color: #7d848a; }
.lx-ln.you { color: #fff; }
.lx-reply { margin-left: 26px; padding: 11px 14px; border-left: 2px solid; border-radius: 0 8px 8px 0; font: 400 12.5px/1.65 var(--mono); color: #d6dadd; overflow-wrap: anywhere; }
.lx-reply.ok { border-color: #00c37a; background: rgba(0,195,122,.06); }
.lx-reply.stop { border-color: #e08f7a; background: rgba(224,143,122,.08); }
.lx-reply.note { border-color: #f3d9a8; background: rgba(243,217,168,.06); }
.lx-reply.plain { border-color: #5b6065; background: rgba(255,255,255,.03); }
.lx-reply .hl { color: #7fd7ae; }
.lx-reply.stop .hl { color: #f0a592; }
.lx-reply b { color: #fff; font-weight: 400; }
.lx-say { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; }
.lx-say > span:first-child { font: 400 12.5px/1.6 var(--mono); color: #fff; }
.lx-say > span:last-child { font: 400 14.5px/1.6 var(--sans); color: #d6dadd; }
.lx-brk { display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; font: 400 11px/1 var(--mono); color: #7d848a; }
.lx-brk span { flex: 1; height: 1px; background: #23272b; }
.lx-diff { display: grid; grid-template-columns: 130px 90px minmax(0, 1fr); gap: 4px 12px; margin-bottom: 10px; }
.lx-diff .bad { color: #f0a592; }
.lx-diff .dim { color: #9aa0a6; }

/* collision */
.lx-flow { margin-top: 56px; display: flex; align-items: center; gap: 14px; }
.lx-who {
  flex: none; display: inline-flex; align-items: center; gap: 9px; height: 38px; padding: 0 14px 0 6px;
  border-radius: 99px; background: #0f1214; border: 1px solid #2f3439;
}
.lx-who i {
  width: 26px; height: 26px; border-radius: 99px; background: #fff; box-shadow: 0 0 0 2px #00915a;
  display: inline-flex; align-items: center; justify-content: center; font: 600 9px/1 var(--sans); font-style: normal; color: #16181a;
}
.lx-who.wait i { box-shadow: 0 0 0 2px #b7791f; }
.lx-who b { font: 500 12.5px/1 var(--mono); color: #fff; }
.lx-who em { font: 500 10.5px/1 var(--mono); font-style: normal; color: #7fd7ae; }
.lx-who.wait em { color: #f3d9a8; }
.lx-wire { flex: 1; min-width: 12px; height: 2px; background: #5b6065; }
.lx-wire.dash { background: repeating-linear-gradient(90deg, #e08f7a 0 6px, transparent 6px 11px); }
.lx-file {
  flex: none; display: inline-flex; flex-direction: column; gap: 6px; padding: 9px 14px; border-radius: 8px;
  background: rgba(224,143,122,.08); border: 1.5px solid #e08f7a;
}
.lx-file small { font: 500 9px/1 var(--sans); letter-spacing: .1em; color: #e08f7a; }
.lx-file code { font: 400 13px/1 var(--mono); color: #fff; }
.lx-pair { margin-top: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 20px; align-items: start; }
.lx-ticks { margin-top: 32px; display: flex; flex-wrap: wrap; gap: 12px 36px; font: 400 14px/1.5 var(--sans); color: #a8adb2; }
.lx-ticks span { display: inline-flex; gap: 9px; }
.lx-ticks i { font-style: normal; color: #7fd7ae; }

/* the features, one exchange at a time: radio buttons and sibling selectors, so it works with script off */
.lx-tabs { position: relative; margin-top: 44px; display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); gap: 40px; align-items: start; }
.lx-tab-in { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.lx-tablist { display: flex; flex-direction: column; gap: 6px; }
.lx-tab { display: flex; flex-direction: column; gap: 7px; padding: 16px 18px; border-radius: 10px; border: 1px solid transparent; cursor: pointer; }
.lx-tab:hover { background: #14171a; }
.lx-tab-h { display: flex; align-items: baseline; gap: 12px; }
.lx-tab-h .n { font: 500 11px/1 var(--mono); color: #7d848a; }
.lx-tab-h b { font: 600 16px/1.3 var(--sans); color: #9aa0a6; }
.lx-tab-d { display: none; padding-left: 27px; font: 400 14px/1.55 var(--sans); color: #a8adb2; }
.lx-panels { min-width: 0; min-height: 470px; }
.lx-panel { display: none; }
.lx-also {
  margin-top: 56px; padding-top: 24px; border-top: 1px solid #23272b; display: flex; flex-wrap: wrap;
  align-items: baseline; gap: 10px 28px; font: 400 14px/1.5 var(--sans); color: #9aa0a6;
}
.lx-also .k { font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #7d848a; }

${LX_TAB_KEYS.map((k) => `
#lxt-${k}:checked ~ .lx-tablist .t-${k} { border-color: #2f3439; background: #14171a; box-shadow: inset 2px 0 0 #00c37a; }
#lxt-${k}:checked ~ .lx-tablist .t-${k} .lx-tab-h b { color: #fff; }
#lxt-${k}:checked ~ .lx-tablist .t-${k} .lx-tab-d { display: block; }
#lxt-${k}:checked ~ .lx-panels .p-${k} { display: block; }
#lxt-${k}:focus-visible ~ .lx-tablist .t-${k} { outline: 2px solid #00c37a; outline-offset: 2px; }`).join('')}
/* evidence and ledger are the console's own pages, light, in the dark frame */
.lx-doc { border-radius: 14px; background: #fff; border: 1px solid #e2e2dd; overflow: hidden; color: #16181a; box-shadow: 0 40px 80px -40px rgba(0,0,0,.8); }
.lx-doc-h { padding: 20px 24px 16px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1.5px solid #16181a; margin: 0 0 4px; }
.lx-doc-k { font: 500 10.5px/1 var(--mono); letter-spacing: .12em; color: #8a8f94; }
.lx-doc-t { margin-top: 8px; font: 600 19px/1.2 var(--sans); letter-spacing: -.02em; }
.lx-doc-m { margin-top: 5px; font: 400 11.5px/1.3 var(--mono); color: #6e7278; }
.lx-doc-btn { flex: none; display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid #d9d9d3; font: 500 11.5px/1 var(--sans); color: #2b2f33; }
.lx-doc-rows { padding: 0 24px 6px; }
.lx-ev { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px dotted #d9d9d3; font: 400 13px/1.3 var(--sans); }
.lx-ev .l { color: #8a8f94; }
.lx-ev .v { color: #16181a; }
.lx-ev .v.mono { font: 400 12px/1.3 var(--mono); }
.lx-ev .v .y { font-style: normal; color: #00915a; margin-right: 7px; }
.lx-ev .src { font: 500 10px/1 var(--mono); letter-spacing: .06em; padding: 4px 6px; border-radius: 4px; color: #6e7278; border: 1px solid #e2e2dd; }
.lx-ev .src.obs { color: #00734a; border-color: #c3e6d5; background: #e9f6ef; }
.lx-doc-f { padding: 12px 24px 18px; font: 400 12px/1.5 var(--sans); color: #8a8f94; }
.lx-led-h { display: flex; justify-content: space-between; gap: 12px; padding: 14px 22px; border-bottom: 1px solid #e6e6e1; background: #f7f7f5; font: 500 10px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: #8a8f94; }
.lx-led { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.lx-led-a, .lx-led-b { padding: 22px 24px; }
.lx-led-a { border-right: 1px solid #e6e6e1; }
.lx-led-b { background: #f3faf6; }
.lx-led .k { font: 500 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: #8a8f94; }
.lx-led-b .k { color: #3f7a60; }
.lx-led .big { margin-top: 12px; font: 600 44px/1 var(--sans); letter-spacing: -.04em; }
.lx-led-b .big { color: #00603d; }
.lx-led .rows { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; font: 400 13.5px/1.4 var(--sans); color: #5b6065; }
.lx-led .rows > span { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dotted #d9d9d3; padding-bottom: 7px; }
.lx-led .rows > span:last-child { border-bottom: 0; padding-bottom: 0; }
.lx-led .rows b { font: 500 13px var(--mono); color: #16181a; text-align: right; }
.lx-led-b .rows { color: #3f7a60; }
.lx-led-b .rows > span { border-bottom-color: #c3e6d5; }
.lx-led-b .rows b { color: #00603d; }
.lx-led-f { padding: 12px 22px 16px; border-top: 1px solid #e6e6e1; }

/* how */
.lx-how { padding: 96px 0; }
.lx-howgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 56px; align-items: center; }
.lx-steps { margin: 28px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.lx-steps li { display: grid; grid-template-columns: 40px minmax(0, 1fr); padding: 14px 0; border-top: 1px solid #2a2f33; font: 400 15px/1.55 var(--sans); color: #a8adb2; }
.lx-steps li:last-child { border-bottom: 1px solid #2a2f33; }
.lx-steps .n { font: 500 12px/1.5 var(--mono); color: #7fd7ae; }
.lx-steps b { color: #fff; font-weight: 600; }
.lx-term { border-radius: 12px; overflow: hidden; background: #0a0c0e; border: 1px solid #2f3439; box-shadow: 0 40px 80px -40px rgba(0,0,0,.8); }
.lx-term-bar { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid #23272b; font: 400 11px/1 var(--mono); color: #7d848a; }
.lx-term-bar .lx-dots i { background: #2f3439; }
.lx-term-body { padding: 18px 20px 22px; font: 400 12.5px/1.75 var(--mono); color: #d6dadd; overflow-wrap: anywhere; }
.lx-term-body .c { color: #6f767c; }
.lx-term-body .p, .lx-term-body .ok { color: #7fd7ae; }
.lx-term-body .gap { height: 21.875px; }

/* integrations */
.lx-prov { margin-top: 72px; width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
.lx-prov thead th { padding: 0 32px 12px 0; border-bottom: 1px solid #3a4045; font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #7d848a; }
.lx-prov th[scope=row], .lx-prov td { padding: 20px 32px 20px 0; border-bottom: 1px solid #23272b; vertical-align: top; text-align: left; }
.lx-prov td:last-child, .lx-prov thead th:last-child { padding-right: 0; }
.lx-prov thead th:first-child, .lx-prov th[scope=row] { width: 262px; }
.lx-prov th[scope=row] b { display: block; font: 600 16px/1.3 var(--sans); color: #fff; }
.lx-prov th[scope=row] span { display: block; margin-top: 6px; font: 400 11.5px/1.3 var(--mono); color: #7d848a; }
.lx-prov td { font: 400 14.5px/1.6 var(--sans); color: #a8adb2; }
.lx-prov td.w { color: #d6dadd; }
.lx-prov td.none { color: #7d848a; }
.lx-prov-note { margin: 20px 0 0; max-width: 90ch; font: 400 13.5px/1.6 var(--sans); color: #7d848a; }

/* security */
.lx-sechead { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
.lx-lic { font: 400 14px/1.5 var(--sans); color: #7d848a; }
.lx-secgrid { margin-top: 36px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 22px 28px; }
.lx-secgrid > div { display: flex; flex-direction: column; gap: 6px; padding-left: 14px; border-left: 1px solid #2f3439; }
.lx-secgrid b { font: 600 14.5px/1.3 var(--sans); color: #fff; }
.lx-secgrid span { font: 400 13.5px/1.6 var(--sans); color: #a8adb2; }

/* pricing */
.lx-price { padding: 0 0 96px; position: relative; }
.lx-pricegrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 18px; }
.lx-plan { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 30px; border-radius: 14px; background: #14171a; border: 1px solid #2a2f33; }
.lx-plan.hosted { border-color: #00734a; box-shadow: 0 0 0 1px rgba(0,195,122,.12), 0 30px 60px -40px rgba(0,195,122,.4); }
.lx-plan-h { display: flex; align-items: baseline; gap: 12px; }
.lx-plan h3 { margin: 0; font: 650 34px/1 var(--sans); letter-spacing: -.03em; color: #fff; }
.lx-plan-h span { font: 400 14px var(--sans); color: #a8adb2; }
.lx-plan p { margin: 0; max-width: 46ch; font: 400 14.5px/1.6 var(--sans); color: #a8adb2; }
.lx-plan .btn, .lx-plan .lx-cmd { margin-top: 8px; }
.lx .btn.btn-lg { height: 46px; }
.lx-plan .btn.btn-lg { height: 42px; padding: 0 18px; font-size: 15px; }
.lx-cmd { display: inline-flex; align-items: center; gap: 9px; height: 42px; padding: 0 8px 0 14px; max-width: 100%; border-radius: 8px; background: #0a0c0e; border: 1px solid #2f3439; text-align: left; }
.lx-cmd .p { font: 400 13px/1 var(--mono); color: #7fd7ae; }
.lx-cmd code { font: 400 13px/1 var(--mono); color: #d6dadd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* closing call */
.lx-final { position: relative; isolation: isolate; overflow: hidden; padding: 128px 0 168px; text-align: center; }
.lx-final-glow {
  position: absolute; inset: 0; z-index: -1; pointer-events: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 42%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 42%, transparent 100%);
}
.lx-final-glow::before {
  content: ''; position: absolute; left: 50%; top: -60px; width: 1240px; height: 680px; transform: translateX(-50%);
  background: radial-gradient(closest-side, rgba(0,195,122,.26), rgba(0,195,122,.08) 55%, transparent 100%);
}
.lx-final-glow::after {
  content: ''; position: absolute; inset: 0;
  background-image: radial-gradient(rgba(255,255,255,.08) 1px, transparent 1.3px); background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 55% 70% at 50% 38%, #000 20%, transparent 72%);
  mask-image: radial-gradient(ellipse 55% 70% at 50% 38%, #000 20%, transparent 72%);
}
.lx-final h2 { margin: 18px auto 0; max-width: 15ch; font: 680 62px/1.02 var(--sans); letter-spacing: -.045em; color: #fff; text-wrap: balance; }
.lx-final p { margin: 22px auto 0; font: 500 19px/1.5 var(--sans); letter-spacing: -.01em; color: #c9ced2; }
.lx-final .lx-ctas { margin-top: 36px; }

@media (prefers-reduced-motion: reduce) {
  .lxg-pulse, .lx-live .dot { animation: none; }
}
@media (max-width: 1080px) {
  .lx-app { grid-template-columns: 160px minmax(0, 1fr); }
  .lx-ins { display: none; }
}
@media (max-width: 960px) {
  .lx-strip .txt { display: none; }
  .lx-h1 { font-size: 52px; }
  .lx-coord .lx-h2 { font-size: 42px; }
  .lx-h2.lg { font-size: 40px; }
  .lx-final h2 { font-size: 50px; }
  .lx-tabs { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .lx-tablist { flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; scrollbar-width: thin; scrollbar-color: #3a4045 transparent; }
  .lx-tab { flex: none; padding: 10px 14px; }
  .lx-tab-h .n, .lx-tab-d { display: none !important; }
  .lx-panels { min-height: 0; }
  .lx-prov thead { display: none; }
  .lx-prov, .lx-prov tbody, .lx-prov tr, .lx-prov th[scope=row], .lx-prov td { display: block; width: auto; }
  .lx-prov tr { padding: 18px 0; border-bottom: 1px solid #23272b; }
  .lx-prov th[scope=row], .lx-prov td { padding: 0; border: 0; }
  .lx-prov td { margin-top: 10px; }
  .lx-prov td::before { content: attr(data-l); display: block; margin-bottom: 3px; font: 500 10.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #5f666c; }
}
@media (max-width: 720px) {
  .lx .container { padding: 0 20px; }
  .lx-hero { padding: 56px 0 64px; }
  .lx-eyebrow { font-size: 10.5px; letter-spacing: 0; gap: 6px; padding: 0 10px 0 9px; }
  .lx-h1 { font-size: 38px; letter-spacing: -.035em; }
  .lx-lede { font-size: 17px; }
  .lx-stage { margin-top: 44px; }
  .lx-app { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .lx-rail { display: none; }
  .lx-main { border-right: 0; }
  .lx-strip .wide, .lx-lrow .wide { display: none; }
  .lx-lrow { grid-template-columns: minmax(0, 1fr) 64px 118px; }
  .lx-strip { height: auto; min-height: 40px; flex-wrap: wrap; gap: 6px 10px; padding: 8px 14px; white-space: normal; }
  .lx-sec, .lx-sec-pad, .lx-how { padding: 64px 0; }
  .lx-h2, .lx-h2.lg, .lx-h2.sm, .lx-coord .lx-h2 { font-size: 30px; }
  .lx-sub { font-size: 16px; }
  .lx-flow { flex-direction: column; align-items: stretch; gap: 0; margin-top: 36px; }
  .lx-flow .lx-who, .lx-flow .lx-file { align-self: center; }
  .lx-wire { flex: none; width: 2px; height: 22px; align-self: center; }
  .lx-wire.dash { background: repeating-linear-gradient(180deg, #e08f7a 0 6px, transparent 6px 11px); }
  .lx-sess-body { padding: 14px 14px 18px; }
  .lx-reply { margin-left: 0; }
  .lx-diff { grid-template-columns: 100px 70px minmax(0, 1fr); }
  .lx-ev { grid-template-columns: 88px minmax(0, 1fr) auto; gap: 8px; }
  .lx-doc-h, .lx-doc-rows, .lx-doc-f { padding-left: 16px; padding-right: 16px; }
  .lx-led-a, .lx-led-b { padding: 18px 16px; }
  .lx-led-a { border-right: 0; border-bottom: 1px solid #e6e6e1; }
  .lx-howgrid { gap: 36px; }
  .lx-plan { padding: 22px; }
  .lx-final { padding: 80px 0 104px; }
  .lx-final h2 { font-size: 36px; }
  .lx-final p { font-size: 17px; }
}
`;
