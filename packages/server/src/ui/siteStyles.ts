/**
 * The signed-out site's own rules: the landing page (`ui/Landing.tsx`).
 *
 * Kept beside the console's stylesheet rather than inside it because the two
 * are read for different reasons — a console rule is judged against a ledger
 * somebody works in all day, a landing rule against a first impression — and
 * appended to it (`css` in `ui/styles.ts`), so the browser still fetches one
 * content-hashed file. Same tokens, same type, same green: a second page
 * grammar, not a second design system.
 */
export const siteCss = /* css */ `
/* ---------- landing (lx) ---------- */
body.lx { background: #fbfbf9; }
.lx .overline { color: var(--green-strong); }
.lx-h2 { margin: 12px 0 0; font: 650 40px/1.08 var(--sans); letter-spacing: -.035em; color: var(--ink); text-wrap: balance; }
.lx-head { max-width: 720px; }
.lx-head p { margin: 14px 0 0; font: 400 17px/1.6 var(--sans); color: var(--txt-2); max-width: 62ch; }

/* hero */
.lx-hero { position: relative; isolation: isolate; overflow: hidden; padding: 84px 0 0; text-align: center; }
.lx-hero::before {
  content: ''; position: absolute; inset: 0; z-index: -2; pointer-events: none;
  background-image: radial-gradient(rgba(20,23,26,.10) 1px, transparent 1.3px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse 72% 60% at 50% 22%, #000 30%, transparent 78%);
  mask-image: radial-gradient(ellipse 72% 60% at 50% 22%, #000 30%, transparent 78%);
}
.lx-hero::after {
  content: ''; position: absolute; z-index: -1; pointer-events: none;
  left: 50%; top: -300px; width: 1200px; height: 760px; transform: translateX(-50%);
  background: radial-gradient(closest-side, rgba(0,195,122,.17), rgba(0,195,122,.06) 55%, transparent 100%);
}
.lx-eyebrow {
  display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 13px 0 11px;
  border-radius: 99px; background: rgba(255,255,255,.9); border: 1px solid var(--line-frame);
  box-shadow: 0 1px 2px rgba(20,23,26,.05);
  font: 500 12px/1 var(--mono); letter-spacing: .04em; color: var(--txt-2);
  white-space: nowrap; max-width: 100%;
}
.lx-eyebrow b { color: var(--green-strong); font-weight: 500; }
.lx-eyebrow .sep { color: var(--mut-2); }
.lx-eyebrow .dot { background: var(--green-bright); box-shadow: 0 0 0 3px rgba(0,195,122,.18); }
.lx-h1 {
  margin: 24px auto 0; max-width: 15ch;
  font: 680 72px/1.0 var(--sans); letter-spacing: -.048em; color: var(--ink); text-wrap: balance;
}
.lx-h1 em {
  font-style: normal;
  background: linear-gradient(95deg, var(--green-strong) 10%, var(--green-bright) 90%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.lx-lede { margin: 24px auto 0; max-width: 58ch; font: 400 19px/1.6 var(--sans); color: var(--txt-2); }
.lx-note { margin: 12px auto 0; max-width: 64ch; font: 400 14px/1.55 var(--sans); color: var(--txt-3); }
.lx-ctas { margin-top: 30px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.btn-glow { box-shadow: 0 12px 26px -12px rgba(0,145,90,.75), inset 0 1px 0 rgba(255,255,255,.18); }
.lx-selfhost { margin-top: 18px; display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
.lx-selfhost-note { font: 400 13px/1.4 var(--sans); color: var(--mut); }
.lx-cmd {
  display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 6px 0 14px; max-width: 100%;
  border-radius: 9px; background: #fff; border: 1px solid var(--line-frame);
  box-shadow: 0 1px 2px rgba(20,23,26,.05); text-align: left;
}
.lx-cmd code { font: 400 13px/1 var(--mono); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lx-cmd .p { font: 400 13px/1 var(--mono); color: var(--mut-2); }
.lx-with {
  margin-top: 28px; display: flex; justify-content: center; align-items: center; gap: 8px 22px; flex-wrap: wrap;
  font: 400 13px/1 var(--sans); color: var(--mut);
}
.lx-with b { font: 500 13px/1 var(--mono); color: var(--txt-2); letter-spacing: -.01em; }

/* the product, drawn */
.lx-stage { position: relative; max-width: 1136px; margin: 60px auto 0; padding: 0 24px; }
.lx-stage::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 90px; pointer-events: none;
  background: linear-gradient(to bottom, rgba(255,255,255,0), #fff 92%);
}
.lx-window {
  border-radius: 14px 14px 0 0; background: #fff; border: 1px solid var(--line-frame); border-bottom: 0;
  box-shadow: 0 50px 110px -40px rgba(20,23,26,.38), 0 24px 50px -30px rgba(20,23,26,.2);
  overflow: hidden; text-align: left;
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
  height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--line);
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

/* why */
.lx-band { background: #fff; border-bottom: 1px solid var(--line-3); position: relative; z-index: 1; }
.lx-why { padding: 72px 24px; display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 2fr); gap: 56px; align-items: start; }
.lx-why-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
.lx-why-grid > div { padding-top: 16px; border-top: 2px solid var(--ink); }
.lx-why-grid h3 { margin: 0; font: 600 17px/1.3 var(--sans); letter-spacing: -.01em; }
.lx-why-grid p { margin: 8px 0 0; font: 400 14.5px/1.6 var(--sans); color: var(--txt-3); }

/* platform */
.lx-section { padding: 96px 0; }
.lx-alt { background: #fff; border-top: 1px solid var(--line-3); border-bottom: 1px solid var(--line-3); }
.lx-pillars { margin-top: 44px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.lx-pillar {
  position: relative; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 22px; min-width: 0;
  background: #fff; border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(20,23,26,.04);
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.lx-pillar:hover { border-color: var(--green-line); box-shadow: 0 18px 40px -24px rgba(0,96,61,.35); transform: translateY(-2px); }
.lx-pillar-k { margin-top: 6px; font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--green-strong); }
.lx-pillar h3 { margin: 0; font: 600 19px/1.25 var(--sans); letter-spacing: -.02em; color: var(--ink); }
.lx-pillar p { margin: 0; font: 400 14px/1.6 var(--sans); color: var(--txt-3); }
.lx-tags { margin-top: auto; padding-top: 6px; display: flex; flex-wrap: wrap; gap: 5px; }
.lx-tags code { height: 22px; display: inline-flex; align-items: center; padding: 0 7px; border-radius: 5px; border: 1px solid var(--line); background: #f7f7f5; font: 400 11px/1 var(--mono); color: var(--txt-2); }
.lx-art {
  height: 132px; border-radius: 10px; border: 1px solid var(--line-2); background: #fafaf8; padding: 14px;
  display: flex; flex-direction: column; justify-content: center; gap: 7px; overflow: hidden;
  font: 400 11.5px/1.3 var(--mono); color: var(--txt-2);
}
.lx-art-rows > span { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; background: #fff; border: 1px solid var(--line-2); }
.lx-art-rows b { font-weight: 500; color: var(--ink); min-width: 52px; }
.lx-art-rows em { margin-left: auto; font-style: normal; color: var(--mut); }
.lx-art-rows .off { opacity: .55; }
.lx-art-rows .dot { animation: lx-blink 2.4s ease-in-out infinite; }
.lx-art-clash { align-items: stretch; gap: 12px; }
.lx-art-clash .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lx-art-clash .who { flex: none; padding: 5px 9px; border-radius: 99px; background: #fff; border: 1px solid var(--line-frame); color: var(--ink); }
.lx-art-clash .wire { flex: 1 1 10px; min-width: 8px; height: 1px; background: #e8a89b; }
.lx-art-clash .res { flex: none; padding: 6px 8px; border-radius: 6px; background: var(--red-bg); border: 1px solid #e8a89b; color: var(--red-ink); font-size: 10.5px; }
.lx-art-clash .note { text-align: center; font: 400 11px/1.3 var(--sans); color: var(--mut); }
.lx-art-clash .note b { color: var(--green-strong); font-weight: 500; }
.lx-art-code { background: var(--dark); border-color: var(--dark); color: var(--dark-txt-2); gap: 6px; }
.lx-art-code em { font-style: normal; color: #7fd7ae; }
.lx-art-code .stop { margin-top: 3px; color: #f0a592; }
.lx-art-steps { gap: 14px; }
.lx-art-steps .to { font: 400 12px/1.3 var(--sans); color: var(--txt-2); }
.lx-art-steps .to b { color: var(--ink); font-family: var(--mono); font-weight: 500; }
.lx-art-steps .track { display: flex; gap: 6px; }
.lx-art-steps .track i {
  flex: 1; position: relative; padding-top: 16px; font-style: normal; font-size: 10.5px; color: var(--mut); text-align: center;
}
.lx-art-steps .track i::before { content: ''; position: absolute; top: 3px; left: 0; right: 0; height: 4px; border-radius: 99px; background: var(--line); }
.lx-art-steps .track i.done { color: var(--green-strong); }
.lx-art-steps .track i.done::before { background: var(--green); }
.lx-art-steps .track i.now { color: var(--ink); }
.lx-art-steps .track i.now::before { background: linear-gradient(90deg, var(--green) 55%, var(--line) 55%); }
.lx-art-diff { padding: 10px; gap: 1px; background: #23272b; border-color: #23272b; }
.lx-art-diff > span { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; padding: 6px 8px; background: #16191c; color: var(--dark-txt-2); border-radius: 2px; }
.lx-art-diff i { font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lx-art-diff .h { font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dark-mut-2); background: #1b1f22; }
.lx-art-diff .w { background: #1e1a12; color: #f3d9a8; }
.lx-art-diff .bad { color: #e08f7a; }
.lx-art-proof { gap: 6px; }
.lx-art-proof span { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 6px; background: #fff; border: 1px solid var(--line-2); color: var(--ink-2); }
.lx-art-proof .y { font-style: normal; color: var(--green); }

.lx-also { margin-top: 48px; padding-top: 28px; border-top: 1px solid var(--line); }
.lx-also-grid { margin-top: 18px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 28px; }
.lx-also-grid > div { display: flex; flex-direction: column; gap: 4px; }
.lx-also-grid b { font: 600 14px/1.3 var(--sans); color: var(--ink); }
.lx-also-grid span { font: 400 13.5px/1.55 var(--sans); color: var(--txt-3); }

/* how */
.lx-how { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 56px; align-items: center; }
.lx-steps { margin: 28px 0 0; padding: 0; list-style: none; counter-reset: lx; display: flex; flex-direction: column; gap: 18px; }
.lx-steps li { counter-increment: lx; position: relative; padding-left: 46px; display: flex; flex-direction: column; gap: 4px; }
.lx-steps li::before {
  content: counter(lx, decimal-leading-zero); position: absolute; left: 0; top: 0;
  width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--green-bg); border: 1px solid var(--green-line); color: var(--green-strong); font: 500 11px/1 var(--mono);
}
.lx-steps li:not(:last-child)::after { content: ''; position: absolute; left: 15px; top: 36px; bottom: -14px; width: 1px; background: var(--green-line); }
.lx-steps b { font: 600 16px/1.3 var(--sans); color: var(--ink); padding-top: 5px; }
.lx-steps span { font: 400 14.5px/1.6 var(--sans); color: var(--txt-3); }
.lx-term { border-radius: 12px; overflow: hidden; background: var(--dark); border: 1px solid #0f1113; box-shadow: 0 40px 80px -40px rgba(20,23,26,.55); }
.lx-term-bar { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid var(--dark-line); font: 400 11px/1 var(--mono); color: var(--dark-mut-2); }
.lx-term-bar .lx-dots i { background: #33393e; }
.lx-term pre { margin: 0; padding: 18px 20px 22px; font: 400 12.5px/1.75 var(--mono); color: var(--dark-txt); white-space: pre-wrap; overflow-wrap: anywhere; }
.lx-term .c { color: #6f767c; }
.lx-term .p { color: #7fd7ae; }
.lx-term .ok { color: #7fd7ae; }

/* security */
.lx-dark { position: relative; overflow: hidden; background: var(--dark); color: var(--dark-txt); padding: 96px 0; }
.lx-dark::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(900px 480px at 85% 0%, rgba(0,195,122,.14), transparent 70%);
}
.lx-dark .overline { color: var(--green-bright); }
.lx-dark .lx-h2 { color: #fff; max-width: 18ch; }
.lx-sec { position: relative; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 56px; align-items: center; }
.lx-sec-grid { margin-top: 34px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 28px; }
.lx-sec-grid > div { display: flex; flex-direction: column; gap: 6px; padding-left: 14px; border-left: 1px solid var(--dark-line-2); }
.lx-sec-grid b { font: 600 14.5px/1.3 var(--sans); color: #fff; }
.lx-sec-grid span { font: 400 13.5px/1.6 var(--sans); color: #a8adb2; }
.lx-json { border-radius: 12px; border: 1px solid var(--dark-line-2); background: #0f1214; overflow: hidden; }
.lx-json-h { display: block; padding: 11px 16px; border-bottom: 1px solid var(--dark-line); font: 500 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--dark-mut-2); }
.lx-json pre { margin: 0; padding: 16px 18px; font: 400 12.5px/1.75 var(--mono); color: var(--dark-txt-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.lx-json .k { color: #9ecbff; }
.lx-json .s { color: #7fd7ae; }
.lx-json-f { display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-top: 1px solid var(--dark-line); font: 400 12px/1.5 var(--sans); color: var(--dark-mut); }
.lx-json-f code { color: var(--dark-txt); font-size: 11.5px; }
.lx-json-f .dot { background: var(--green-bright); }

/* hosted / self-hosted */
.lx-run { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.lx-run-card { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 28px; border-radius: 14px; background: #fff; border: 1px solid var(--line); }
.lx-run-card h3 { margin: 0; font: 600 22px/1.2 var(--sans); letter-spacing: -.02em; }
.lx-run-card p { margin: 0; font: 400 14.5px/1.6 var(--sans); color: var(--txt-3); max-width: 52ch; }
.lx-run-card .btn, .lx-run-card .lx-cmd { margin-top: auto; }

/* closing call */
.lx-final { padding: 0 0 96px; }
.lx-final-inner {
  position: relative; overflow: hidden; isolation: isolate; text-align: center; padding: 64px 24px;
  border-radius: 20px; background: var(--dark); color: #fff;
}
.lx-final-inner::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  background:
    radial-gradient(600px 300px at 50% 120%, rgba(0,195,122,.35), transparent 70%),
    radial-gradient(rgba(255,255,255,.07) 1px, transparent 1.3px) 0 0 / 22px 22px;
}
.lx-final h2 { margin: 0; font: 650 44px/1.05 var(--sans); letter-spacing: -.04em; }
.lx-final p { margin: 14px auto 0; max-width: 52ch; font: 400 16px/1.6 var(--sans); color: #b9bec3; }
.lx-final .btn:not(.btn-primary) { background: transparent; border-color: #3a4045; color: #fff; }
.lx-final .btn:not(.btn-primary):hover { background: #1c2023; }

@media (prefers-reduced-motion: reduce) {
  .lxg-pulse, .lx-live .dot, .lx-art-rows .dot { animation: none; }
  .lx-pillar, .lx-pillar:hover { transition: none; transform: none; }
}
@media (max-width: 1080px) {
  .lx-app { grid-template-columns: 160px minmax(0, 1fr); }
  .lx-ins { display: none; }
}
@media (max-width: 960px) {
  .lx-h1 { font-size: 56px; }
  .lx-why { grid-template-columns: 1fr; gap: 28px; }
  .lx-pillars { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lx-how, .lx-sec { grid-template-columns: 1fr; gap: 40px; }
  .lx-also-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .lx-hero { padding-top: 56px; }
  .lx-eyebrow { font-size: 10.5px; letter-spacing: 0; gap: 6px; padding: 0 10px 0 9px; }
  .lx-h1 { font-size: 42px; letter-spacing: -.04em; }
  .lx-lede { font-size: 17px; }
  .lx-h2 { font-size: 30px; }
  .lx-app { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .lx-rail { display: none; }
  .lx-main { border-right: 0; }
  .lx-strip .wide, .lx-lrow .wide { display: none; }
  .lx-lrow { grid-template-columns: minmax(0, 1fr) 64px 118px; }
  .lx-why-grid, .lx-pillars, .lx-also-grid, .lx-sec-grid, .lx-run { grid-template-columns: 1fr; }
  .lx-section, .lx-dark { padding: 64px 0; }
  .lx-final-inner { padding: 48px 20px; border-radius: 16px; }
  .lx-final h2 { font-size: 32px; }
  .lx-selfhost-note { flex-basis: 100%; }
}
`;
