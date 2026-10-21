import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { Head, Logo } from './Layout';
import { SiteFooter, SiteHeader, siteDoor, type SiteInfo } from './Site';

/**
 * The page a stranger meets: what STMA is, drawn rather than listed.
 *
 * One page in both site modes; only the doors differ — the access code while
 * the beta asks for one, open signup where it is open, and Sign in plus the
 * self-host command everywhere. A page must not offer a door that is not there,
 * the rule `siteDoor` in `ui/Site.tsx` keeps for the whole signed-out frame.
 *
 * The headline is the platform (owner's word, 2026-09-27: mission control for a
 * team's coding agents) and the page shows it the way a person would meet it:
 * the live map first, then one collision from both agents' side, then the other
 * things agents hear from STMA, how to connect, what is read from and written
 * to each tracker, and what the server will and will not do.
 *
 * Everything drawn is a picture of the real product with invented names, and the
 * exchanges follow the messages the server sends (`shared/conflicts.ts`, the
 * CLI's file guard, `check_environment`, the handoff checkpoint), trimmed to
 * fit a card and with one punctuation change: this page carries no em dash
 * (owner's word), so the two product messages that join their halves with one
 * join them with a colon here. No number is a claim about customers, usage or
 * speed, because none of those has been measured.
 */

/** One line of the product mock's rail. */
const RailItem = ({ label, n, on }: { label: string; n?: string; on?: boolean }) => (
  <span class={`lx-rail-i${on ? ' on' : ''}`}>
    {label}
    {n ? <b>{n}</b> : null}
  </span>
);

/** The numbered dot that ties a spot on the mock to the line under it. */
const No = ({ n }: { n: number }) => <span class="lx-no">{n}</span>;

/**
 * The scope graph, as the console draws it: runs on the left, the ground they
 * hold on the right, one line per claim, red where two write lines meet.
 */
const MockGraph = () => {
  const runs = [
    { y: 46, i: 'AD', task: 'PAY-212 Retry webhook on 5xx', who: 'ada · claude-code', live: true, quota: 0.38, q: 'ok', badge: '✓' },
    { y: 116, i: 'JO', task: 'PAY-219 Idempotency keys', who: 'jonas · codex', live: true, quota: 0.81, q: 'warn', badge: '!', hot: true },
    { y: 186, i: 'MI', task: 'WEB-88 Checkout copy', who: 'mira · cursor', live: true, quota: 0.22, q: 'ok', badge: '✓' },
    { y: 256, i: 'LB', task: 'OPS-14 Bump pnpm to 9', who: 'lead-b2 · claude-code', live: false, quota: null, q: 'ok', badge: null },
  ];
  const scopes = [
    { y: 34, label: 'src/payments/webhook.ts', kind: 'FILE' },
    { y: 92, label: 'src/payments/retry.ts', kind: 'FILE', hot: true },
    { y: 150, label: 'db/migrations/0042_keys.sql', kind: 'MIGRATION' },
    { y: 208, label: 'web/checkout.tsx', kind: 'FILE' },
    { y: 266, label: 'pnpm-lock.yaml', kind: 'LOCKFILE' },
  ];
  const links: { from: number; to: number; cls: string }[] = [
    { from: 0, to: 0, cls: '' },
    { from: 0, to: 1, cls: 'hot' },
    { from: 1, to: 1, cls: 'hot' },
    { from: 1, to: 2, cls: '' },
    { from: 2, to: 3, cls: '' },
    { from: 3, to: 4, cls: 'read' },
  ];
  const X1 = 236;
  const X2 = 356;
  const ARC = 2 * Math.PI * 19;
  return (
    <svg class="lxg" viewBox="0 0 564 300" role="img" aria-label="Four agent runs and the files they hold; two runs hold src/payments/retry.ts">
      <text class="lxg-col" x="16" y="14">RUNS</text>
      <text class="lxg-col" x="356" y="14">GROUND HELD</text>
      {links.map((l) => {
        const y1 = runs[l.from]!.y;
        const y2 = scopes[l.to]!.y + 14;
        return <path class={`lxg-link ${l.cls}`} d={`M${X1},${y1} C${X1 + 70},${y1} ${X2 - 70},${y2} ${X2},${y2}`} />;
      })}
      {runs.map((r) => (
        <g class={`lxg-run${r.live ? '' : ' idle'}`}>
          <text class="lxg-task" x="186" y={r.y - 3} text-anchor="end">{r.task}</text>
          <text class="lxg-who" x="186" y={r.y + 12} text-anchor="end">{r.who}</text>
          {r.live ? <circle class="lxg-pulse" cx="212" cy={r.y} r="16" /> : null}
          <circle class="lxg-ring" cx="212" cy={r.y} r="19" />
          {r.quota !== null ? (
            <circle
              class={`lxg-quota ${r.q}`}
              cx="212"
              cy={r.y}
              r="19"
              stroke-dasharray={`${(ARC * r.quota).toFixed(1)} ${ARC.toFixed(1)}`}
              transform={`rotate(-90 212 ${r.y})`}
            />
          ) : null}
          <circle class={`lxg-face${r.live ? ' live' : ''}`} cx="212" cy={r.y} r="14" />
          <text class="lxg-init" x="212" y={r.y + 3} text-anchor="middle">{r.i}</text>
          {r.badge ? (
            <>
              <circle class={`lxg-badge${r.hot ? ' bad' : ''}`} cx="224" cy={r.y - 12} r="6" />
              <text class="lxg-badge-t" x="224" y={r.y - 9.5} text-anchor="middle">{r.badge}</text>
            </>
          ) : null}
        </g>
      ))}
      {scopes.map((s) => (
        <g>
          <rect class={`lxg-box${s.hot ? ' hot' : ''}`} x={X2} y={s.y} width="200" height="28" rx="5" />
          <text class={`lxg-kind${s.hot ? ' hot' : ''}`} x={X2 + 10} y={s.y + 11}>{s.kind}</text>
          <text class={`lxg-label${s.hot ? ' hot' : ''}`} x={X2 + 10} y={s.y + 22}>{s.label}</text>
        </g>
      ))}
      {/* Caption 2 under the window: the one file two runs hold. */}
      <circle class="lxg-no" cx="548" cy="92" r="9" />
      <text class="lxg-no-t" x="548" y="95.5" text-anchor="middle">2</text>
    </svg>
  );
};

/** The console, drawn: what `/app/agents` looks like with a busy morning on it. */
const ProductMock = () => (
  <div class="lx-window" aria-label="The STMA console's agent map, with example data">
    <div class="lx-bar">
      <span class="lx-dots">
        <i />
        <i />
        <i />
      </span>
      <span class="lx-url">stma.ai/app/teams/acme/agents</span>
      <span class="lx-live">
        <span class="dot" /> LIVE
      </span>
    </div>
    <div class="lx-app">
      <aside class="lx-rail">
        <span class="lx-rail-brand">
          <Logo inv />
          Acme
        </span>
        <span class="lx-rail-g">Workspace</span>
        <RailItem label="Agents" n="4" on />
        <RailItem label="Work" n="2" />
        <RailItem label="Sessions" n="1" />
        <RailItem label="Governance" />
        <RailItem label="Activity" />
        <RailItem label="Knowledge" />
        <RailItem label="Environments" />
        <RailItem label="Delivery" />
        <span class="lx-rail-g">Projects</span>
        <RailItem label="payments-api" />
        <RailItem label="web-checkout" />
      </aside>
      <div class="lx-main">
        <div class="lx-strip">
          <No n={1} />
          <span class="lx-lead">
            <span class="dot" /> Live
          </span>
          <span class="txt">4 agents running · 2 projects</span>
          <span class="lx-chip bad">
            <i /> 1 collision
          </span>
          <No n={3} />
          <span class="lx-chip">
            Policy <b>v12</b> · 3 of 4 confirmed
          </span>
        </div>
        <div class="lx-graph">
          <MockGraph />
        </div>
        <div class="lx-ledger">
          <div class="lx-lrow head">
            <span>Agent · task</span>
            <span>Holds</span>
            <span class="wide">Heartbeat</span>
            <span>Status</span>
          </div>
          <div class="lx-lrow">
            <span>
              <b>ada</b> · PAY-212
            </span>
            <span class="m">2 files</span>
            <span class="m wide">12s ago</span>
            <span class="lx-pill ok">right of way</span>
          </div>
          <div class="lx-lrow sel">
            <span>
              <b>jonas</b> · PAY-219
            </span>
            <span class="m">2 files</span>
            <span class="m wide">40s ago</span>
            <span class="lx-pill bad">waiting on ada</span>
          </div>
          <div class="lx-lrow">
            <span>
              <b>mira</b> · WEB-88
            </span>
            <span class="m">1 file</span>
            <span class="m wide">1m ago</span>
            <span class="lx-pill">clear</span>
          </div>
        </div>
      </div>
      <aside class="lx-ins">
        <span class="lx-kick">Run</span>
        <span class="lx-ins-t">PAY-219 Idempotency keys</span>
        <span class="lx-ins-m">jonas · codex · feat/pay-219</span>
        <span class="lx-ins-l">Collision</span>
        <span class="lx-holds hot">src/payments/retry.ts</span>
        <span class="lx-ins-p">
          <b>ada</b> declared it first, for PAY-212. Waiting until that run lets go.
        </span>
        <span class="lx-ins-l">Checks</span>
        <span class="lx-check">
          <i class="y">✓</i> Policy v12 received and confirmed
        </span>
        <span class="lx-check">
          <i class="y">✓</i> Preflight matches the baseline
        </span>
        <span class="lx-check warn">
          <i class="w">!</i>
          <span>Allowance 81%, measured · handoff prepared</span>
          <No n={4} />
        </span>
        <span class="lx-check">
          <i class="y">✓</i>
          <span>
            Tested checkpoint <code>4f1c2a0</code> · reported by the agent
          </span>
        </span>
      </aside>
    </div>
  </div>
);

const CAPTIONS: { title: string; body: string }[] = [
  { title: 'Every run, live', body: 'Whose agent, which ticket and branch, which files, when it last checked in.' },
  { title: 'Collision caught', body: 'Two runs want retry.ts. Ada was first and keeps going; Jonas is told before he writes.' },
  { title: 'Rules confirmed', body: 'Policy v12 reached all four runs. Three confirmed it; the fourth is counted.' },
  { title: 'A limit coming, a handoff ready', body: 'At 81% of its allowance, the run has a handoff prepared at a tested commit.' },
];

/* ---- an agent's session, drawn the way the tools print it ---- */

const Session = ({ who, meta, children }: { who: string; meta: string; children?: Child }) => (
  <div class="lx-sess">
    <div class="lx-sess-bar">
      <b>{who}'s session</b>
      <span>{meta}</span>
    </div>
    <div class="lx-sess-body">{children}</div>
  </div>
);

/** A tool call the agent made. */
const Call = ({ children }: { children?: Child }) => (
  <div class="lx-ln">
    <span class="g">●</span>
    <span>
      <span class="g">stma</span> · {children}
    </span>
  </div>
);

/** A tool call that was stopped. */
const Stopped = ({ children }: { children?: Child }) => (
  <div class="lx-ln">
    <span class="r">✕</span>
    <span>{children}</span>
  </div>
);

/** What the person typed. */
const You = ({ children }: { children?: Child }) => (
  <div class="lx-ln you">
    <span class="m">›</span>
    <span>{children}</span>
  </div>
);

/** What STMA answered. */
const Reply = ({ tone, children }: { tone: 'ok' | 'stop' | 'note' | 'plain'; children?: Child }) => (
  <div class={`lx-reply ${tone}`}>{children}</div>
);

/** What the agent said back to its person. */
const Say = ({ children }: { children?: Child }) => (
  <div class="lx-say">
    <span>●</span>
    <span>{children}</span>
  </div>
);

const Break = ({ children }: { children?: Child }) => (
  <div class="lx-brk">
    <span />
    {children}
    <span />
  </div>
);

/* ---- the six exchanges ---- */

const TABS: { key: string; title: string; desc: string }[] = [
  { key: 'rules', title: 'Team rules', desc: 'Published once and served to every run. With hooks, a forbidden edit is stopped at the file tool.' },
  { key: 'handoff', title: 'Handoffs', desc: 'Before a usage limit ends a session, the work moves to another agent at the exact commit.' },
  { key: 'assign', title: 'Assign work', desc: 'Give a task to a named agent from the browser, or from another agent.' },
  { key: 'env', title: 'Environment drift', desc: "Preflight compares the machine with the project's baseline before the first edit." },
  { key: 'evidence', title: 'Evidence', desc: 'One page per run, with what the agent reported kept apart from what was observed.' },
  { key: 'ledger', title: 'Savings ledger', desc: 'What STMA prevented, next to what your team confirmed it prevented.' },
];

const EVIDENCE: { label: string; value: Child; mono?: boolean; from: 'AGENT' | 'STMA' | 'GITHUB' }[] = [
  { label: 'Policy', value: <><i class="y">✓</i>v12 served · confirmed</>, from: 'AGENT' },
  { label: 'Scope', value: 'retry.ts · 0042_keys.sql', mono: true, from: 'AGENT' },
  { label: 'Preflight', value: <><i class="y">✓</i>matches the baseline</>, from: 'STMA' },
  { label: 'Overlap', value: <><i class="y">✓</i>none open at delivery</>, from: 'STMA' },
  { label: 'Delivered', value: '4f1c2a0', mono: true, from: 'AGENT' },
  { label: 'CI at 4f1c2a0', value: <><i class="y">✓</i>passed</>, from: 'GITHUB' },
];

const TabPanel = ({ k }: { k: string }) => {
  if (k === 'rules')
    return (
      <Session who="ada" meta="WEB-90 · claude-code">
        <Call>get_policy</Call>
        <Reply tone="ok">
          Policy v12 served · workspace rules + payments-api additions · <span class="hl">confirmed by this run</span>
        </Reply>
        <You>Make the checkout banner friendlier</You>
        <Stopped>edit · public/banner.css</Stopped>
        <Reply tone="stop">
          <span class="hl">STMA stopped this file edit: policy_content_denied.</span> Your team's published policy denies
          this content here: deny content "Comic Sans" in public/**. Tell your human which rule stopped you; do not
          bypass it through a shell or another tool.
        </Reply>
        <Say>Your team's policy denies that font under public/. I'll keep the brand font and make the copy and colours friendlier instead.</Say>
      </Session>
    );
  if (k === 'handoff')
    return (
      <Session who="jonas" meta="PAY-219 · codex">
        <Call>update_run · allowance 81%, measured</Call>
        <Call>handoff_work → lead-b2 on device-b</Call>
        <Reply tone="ok">
          Handed over at 4f1c2a0 · worktree clean · 3 tests passed · 2 next steps. <span class="hl">lead-b2 resumes only from this commit.</span>
        </Reply>
        <Break>device-b · lead-b2 · claude-code</Break>
        <You>read your STMA inbox and do what is assigned to you</You>
        <Reply tone="note">
          This handoff has an immutable checkpoint. Report repository_identity, commit_sha and worktree_clean before resuming.
        </Reply>
        <Say>The checkout is at 4f1c2a0 and clean. Resuming PAY-219: next, wire the keys into retry.ts.</Say>
      </Session>
    );
  if (k === 'assign')
    return (
      <Session who="laptop-agent" meta="laptop · claude-code">
        <You>assign the filter change to desktop-agent through STMA</You>
        <Call>assign_work → desktop-agent on desktop</Call>
        <Reply tone="ok">
          Assigned by name to desktop-agent on desktop. <span class="hl">Its hook announces it on the next prompt.</span>
        </Reply>
        <Break>desktop · desktop-agent</Break>
        <You>read your STMA inbox and do what is assigned to you</You>
        <Say>One assignment from laptop-agent: the filter change. Starting on it now.</Say>
      </Session>
    );
  if (k === 'env')
    return (
      <Session who="mira" meta="WEB-88 · cursor">
        <Call>check_environment</Call>
        <Reply tone="stop">
          <span class="lx-diff">
            <span>pnpm</span>
            <span class="bad">8.15.4</span>
            <span class="dim">baseline 9.1.0</span>
            <span>DATABASE_URL</span>
            <span class="bad">missing</span>
            <span class="dim">baseline set</span>
          </span>
          Do not start until this is fixed: the baseline says this machine cannot reproduce the project. Tell your human
          exactly which line differs.
        </Reply>
        <Say>Two lines differ from the project baseline: pnpm is 8.15.4 instead of 9.1.0, and DATABASE_URL is not set. I'll wait until both are fixed.</Say>
      </Session>
    );
  if (k === 'evidence')
    return (
      <div class="lx-doc">
        <div class="lx-doc-h">
          <div>
            <span class="lx-doc-k">EVIDENCE · RUN</span>
            <div class="lx-doc-t">PAY-219 Idempotency keys</div>
            <div class="lx-doc-m">jonas · codex · feat/pay-219</div>
          </div>
          <span class="lx-doc-btn">Copy as Markdown</span>
        </div>
        <div class="lx-doc-rows">
          {EVIDENCE.map((e) => (
            <div class="lx-ev">
              <span class="l">{e.label}</span>
              <span class={`v${e.mono ? ' mono' : ''}`}>{e.value}</span>
              <span class={`src ${e.from === 'AGENT' ? '' : 'obs'}`}>{e.from}</span>
            </div>
          ))}
        </div>
        <div class="lx-doc-f">Grey: reported by the agent. Green: observed by STMA or a connected provider.</div>
      </div>
    );
  return (
    <div class="lx-doc">
      <div class="lx-led-h">
        <span>Savings ledger · last 30 days</span>
        <span>Example workspace</span>
      </div>
      <div class="lx-led">
        <div class="lx-led-a">
          <span class="k">Observed by STMA</span>
          <div class="big">24</div>
          <div class="rows">
            <span><span>Collisions warned about</span><b>14</b></span>
            <span><span>Duplicate work caught</span><b>3</b></span>
            <span><span>Machines stopped</span><b>2</b></span>
            <span><span>Work handed over</span><b>5</b></span>
          </div>
        </div>
        <div class="lx-led-b">
          <span class="k">Confirmed by a person</span>
          <div class="big">9</div>
          <div class="rows">
            <span><span>Helped and changed what happened</span><b>9</b></span>
            <span><span>Said it did not help</span><b>2</b></span>
            <span><span>Time saved, as reported</span><b>6 h 40 m</b></span>
            <span><span>Value</span><b>set an hourly cost</b></span>
          </div>
        </div>
      </div>
      <div class="lx-doc-f lx-led-f">
        Answers that say it did not help are kept and shown. Money appears only once you say what an hour costs.
      </div>
    </div>
  );
};

/* ---- what is read from and written to each tracker ---- */

const PROVIDERS: { name: string; how: string; reads: string; writes: string; none?: 'reads' | 'writes' }[] = [
  {
    name: 'GitHub',
    how: 'repository token · webhooks',
    reads:
      "Open issues, which agents list and start a run from by number. Pull request and workflow results, by webhook. New issues reach every agent's inbox as announcements.",
    writes: 'A comment on the issue when the run finishes or hands off.',
  },
  {
    name: 'Jira',
    how: 'Jira Cloud · read-only',
    reads: "The ticket's summary, when a run or an assignment names a key like PROJ-42.",
    writes: 'Nothing. The connection is read-only.',
    none: 'writes',
  },
  {
    name: 'ClickUp',
    how: 'OAuth · one List per project',
    reads: 'Open tasks from the List mapped to the project, by id, by a custom id like PD-207, or by link.',
    writes: 'A comment on the task when the run finishes or hands off.',
  },
  {
    name: 'Azure DevOps',
    how: 'personal access token · service hooks',
    reads: 'Pull request and build results, by service hook, matched to the commit that was built.',
    writes: "The delivery flow's pipeline, committed to the repository and registered when an owner applies it.",
  },
  {
    name: 'Slack, Discord, email',
    how: 'your own webhook',
    reads: 'Nothing.',
    writes: 'Thread replies, handoffs sent to you and opt-in announcements. A burst arrives as one message.',
    none: 'reads',
  },
];

const SECURITY: { title: string; body: string }[] = [
  {
    title: 'Names, never values',
    body: 'Snapshots carry environment variable names and presence. Values and file contents stay on the machine.',
  },
  {
    title: 'Nothing runs remotely',
    body: 'The server cannot start a process on your machine or read your files. Agents call it; it never calls them.',
  },
  {
    title: 'Scoped, revocable connections',
    body: 'Each agent is approved for one project or workspace, on a credential you revoke in one click.',
  },
  {
    title: "A teammate's text is data",
    body: "Messages from another person's agent reach yours framed as data, never as instructions.",
  },
  {
    title: 'Hashed at rest',
    body: 'Tokens and sign-in codes are stored as hashes and shown once, and on the hosted service a provider credential is encrypted at rest.',
  },
  {
    title: 'Yours to run',
    body: 'Source-available under the Elastic License 2.0 and free to self-host: the same server on your own hardware, in one command.',
  },
];

const CopyCommand = ({ command }: { command: string }) => (
  <span class="lx-cmd">
    <span class="p">$</span>
    <code>{command}</code>
    <button class="copybtn" type="button" data-copy={command}>
      COPY
    </button>
  </span>
);

export const Landing = ({ site, baseUrl }: { site: SiteInfo; baseUrl: string }) => {
  const mcpUrl = `${baseUrl}/mcp`;
  const door = siteDoor(site);
  // Which beta, if any: siteInfo derives it, so the badge, the microline, the
  // hosted card and the footer cannot disagree about which door this page shows.
  const beta = site.beta;
  const betaName = beta === 'public' ? 'Public beta' : 'Private beta';
  const primary = door
    ? { href: door.href, label: door.long }
    : { href: '/docs', label: 'Read the docs' };
  const betaDoor =
    beta === 'public'
      ? 'The hosted service is in public beta.'
      : site.codeDoor
        ? 'The hosted service is in private beta. An access code creates an account.'
        : 'The hosted service is in private beta. Accounts are created by invitation.';
  return (
    <>
      {/* The product's pages are served without a doctype, so a browser draws
          them in quirks mode: line boxes, table text and replaced elements
          follow rules from the nineties. This page was designed in standards
          mode and is the one place that says so; the rest of the console has
          never been audited for the change. */}
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <Head themeColor="#0f1214" />
        <body class="site lx">
          <SiteHeader site={site} landing />
          <main>
            <section class="lx-hero">
              <div class="container">
                <span class="lx-eyebrow">
                  <span class="dot" />
                  {beta ? <b>{betaName}</b> : null}
                  {beta ? <span class="sep">·</span> : null}
                  AgentOps for coding agents
                </span>
                <h1 class="lx-h1">
                  Mission control for your <em>team's coding agents.</em>
                </h1>
                <p class="lx-lede">
                  One live map of every agent run on your team: whose agent, which ticket, which files. STMA warns two
                  agents before they touch the same file and gives every session your team's rules.
                </p>
                <div class="lx-ctas">
                  <a class="btn btn-primary btn-lg btn-glow" href={primary.href}>
                    {primary.label}
                  </a>
                  <a class="btn btn-lg" href="#coordinate">
                    See a collision caught
                  </a>
                </div>
                <div class="lx-micro">
                  {beta ? (
                    <>
                      <span>Free during the {beta} beta</span>
                      <i>·</i>
                      <span>No card</span>
                      <i>·</i>
                    </>
                  ) : null}
                  <span>Claude Code, Codex, Cursor and any MCP client</span>
                </div>
              </div>
              <div class="container lx-stage">
                <ProductMock />
                <div class="lx-caps">
                  {CAPTIONS.map((c, i) => (
                    <div class="lx-cap">
                      <No n={i + 1} />
                      <b>{c.title}</b>
                      <span class="d">{c.body}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="lx-sec lx-alt lx-coord" id="coordinate">
              <div class="container">
                <div class="lx-split lx-end">
                  <div>
                    <span class="lx-ov">Collision warnings</span>
                    <h2 class="lx-h2">Two agents reach for one file. Both hear about it first.</h2>
                  </div>
                  <p class="lx-sub">
                    Every run declares the files it is about to change. When a second run declares the same one, STMA
                    answers both before either writes. These are the messages each agent gets.
                  </p>
                </div>
                <div class="lx-flow" aria-hidden="true">
                  <span class="lx-who ok">
                    <i>AD</i>
                    <b>ada · claude-code</b>
                    <em>right of way</em>
                  </span>
                  <span class="lx-wire" />
                  <span class="lx-file">
                    <small>FILE · DECLARED TWICE</small>
                    <code>src/payments/retry.ts</code>
                  </span>
                  <span class="lx-wire dash" />
                  <span class="lx-who wait">
                    <i>JO</i>
                    <b>jonas · codex</b>
                    <em>told to wait</em>
                  </span>
                </div>
                <div class="lx-pair">
                  <Session who="ada" meta="PAY-212 · 09:14:41">
                    <Call>update_run · ground src/payments/retry.ts</Call>
                    <Reply tone="ok">
                      Another run declared ground you already hold (src/payments/retry.ts).{' '}
                      <span class="hl">You were first, so you keep the right of way</span> and that run was told to wait
                      for you: carry on, and complete, finish or release when your work is done, which is what frees the
                      ground for it. Do not stop on its account.
                    </Reply>
                    <Say>Carrying on with the webhook retry. I'll release retry.ts as soon as the change is committed.</Say>
                  </Session>
                  <Session who="jonas" meta="PAY-219 · 09:14:40">
                    <Stopped>edit · src/payments/retry.ts</Stopped>
                    <Reply tone="stop">
                      <span class="hl">STMA stopped this file edit: work_conflict.</span> The ground to leave alone is
                      src/payments/retry.ts, held by ada (PAY-212), which declared it first. Tell your human, and wait or
                      coordinate through a session; do not bypass it through a shell or another tool.
                    </Reply>
                    <Say>
                      retry.ts is held by Ada's run, so I'll leave it alone. I'll write the 0042_keys migration first and
                      pick up retry.ts once it's released.
                    </Say>
                  </Session>
                </div>
                <div class="lx-ticks">
                  <span>
                    <i>✓</i>Checked across people, machines and branches
                  </span>
                  <span>
                    <i>✓</i>Two runs on one ticket are caught the same way
                  </span>
                  <span>
                    <i>✓</i>Every catch is counted in the savings ledger
                  </span>
                </div>
              </div>
            </section>

            <section class="lx-sec" id="product">
              <div class="container">
                <div class="lx-head">
                  <span class="lx-ov">More from STMA</span>
                  <h2 class="lx-h2 md">What else your agents hear from STMA.</h2>
                  <p class="lx-sub">
                    Pick a feature to see the exchange. The examples follow the messages the server sends; names and data
                    are invented.
                  </p>
                </div>
                <div class="lx-tabs">
                  {TABS.map((t, i) => (
                    <input class="lx-tab-in" type="radio" name="lx-tab" id={`lxt-${t.key}`} checked={i === 0} />
                  ))}
                  <div class="lx-tablist" role="group" aria-label="Features">
                    {TABS.map((t, i) => (
                      <label class={`lx-tab t-${t.key}`} for={`lxt-${t.key}`}>
                        <span class="lx-tab-h">
                          <span class="n">{String(i + 1).padStart(2, '0')}</span>
                          <b>{t.title}</b>
                        </span>
                        <span class="lx-tab-d">{t.desc}</span>
                      </label>
                    ))}
                  </div>
                  <div class="lx-panels">
                    {TABS.map((t) => (
                      <div class={`lx-panel p-${t.key}`}>
                        <TabPanel k={t.key} />
                      </div>
                    ))}
                  </div>
                </div>
                <div class="lx-also">
                  <span class="k">Also in the box</span>
                  <span>Live agent map</span>
                  <span>Knowledge</span>
                  <span>Delivery flows</span>
                  <span>Debug sessions</span>
                  <span>Activity export</span>
                </div>
              </div>
            </section>

            <section class="lx-sec lx-alt lx-how" id="how">
              <div class="container lx-howgrid">
                <div>
                  <span class="lx-ov">How it works</span>
                  <h2 class="lx-h2 sm">Connect once. Then every run reports in.</h2>
                  <ol class="lx-steps">
                    <li>
                      <span class="n">01</span>
                      <span>
                        <b>Add one address.</b> Paste the MCP address into Claude Code, Codex or Cursor.
                      </span>
                    </li>
                    <li>
                      <span class="n">02</span>
                      <span>
                        <b>Approve it in the browser.</b> The exact agent, device and project. Nothing secret passes
                        through the model.
                      </span>
                    </li>
                    <li>
                      <span class="n">03</span>
                      <span>
                        <b>Work as usual.</b> Runs appear on the map, with collisions, rules and waiting work answered as
                        they go.
                      </span>
                    </li>
                  </ol>
                </div>
                <div class="lx-term" aria-label="Connection commands">
                  <div class="lx-term-bar">
                    <span class="lx-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>terminal</span>
                  </div>
                  <div class="lx-term-body">
                    <div class="c"># any MCP client: one address, browser consent</div>
                    <div>
                      <span class="p">$</span> claude mcp add --transport http stma {mcpUrl}
                    </div>
                    <div>
                      <span class="p">$</span> codex mcp add stma --url {mcpUrl}
                    </div>
                    <div class="gap" />
                    <div class="c"># Claude Code with hooks, per checkout</div>
                    <div>
                      <span class="p">$</span> npx @matteai/stma connect CODE --server {baseUrl}
                    </div>
                    <div class="ok">✓ connected · hooks pinned · runs start on the next prompt</div>
                  </div>
                </div>
              </div>
            </section>

            <section class="lx-sec lx-line" id="integrations">
              <div class="container">
                <div class="lx-split lx-mid">
                  <div>
                    <span class="lx-ov">Integrations</span>
                    <h2 class="lx-h2 lg">Your tracker in. Your CI back.</h2>
                    <p class="lx-sub">
                      A run can start from a ticket, and what became of the change comes back to it: the pull request,
                      the CI result, a comment on the issue.
                    </p>
                    <p class="lx-sub dim">
                      A workspace owner connects each provider. The table below says exactly what STMA reads and what it
                      writes.
                    </p>
                  </div>
                  <Session who="mira" meta="web-checkout · claude-code">
                    <You>pick up issue 42</You>
                    <Call>start_run {'{"issue": 42}'}</Call>
                    <Reply tone="ok">
                      task #42 · intent from the issue title: <b>Show the delivery date at checkout</b>
                    </Reply>
                    <Say>Working on #42. I'll declare web/checkout.tsx before editing it.</Say>
                    <Break>40 minutes later</Break>
                    <Call>finish_run</Call>
                    <Reply tone="ok">
                      run finished · <span class="hl">comment posted on #42</span>
                    </Reply>
                    <Break>GitHub webhook</Break>
                    <Reply tone="plain">
                      pull_request merged · last CI result: success · <span class="hl">run_merged</span> in the activity feed
                    </Reply>
                  </Session>
                </div>
                <table class="lx-prov">
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">STMA reads</th>
                      <th scope="col">STMA writes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PROVIDERS.map((p) => (
                      <tr>
                        <th scope="row">
                          <b>{p.name}</b>
                          <span>{p.how}</span>
                        </th>
                        <td data-l="STMA reads" class={p.none === 'reads' ? 'none' : ''}>
                          {p.reads}
                        </td>
                        <td data-l="STMA writes" class={p.none === 'writes' ? 'none' : 'w'}>
                          {p.writes}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="lx-prov-note">
                  Delivery flows render CI for GitHub Actions or Azure DevOps. When you assign work in the browser, GitHub
                  issues and ClickUp tasks can be browsed and searched; Jira tickets are entered by key.
                </p>
              </div>
            </section>

            <section class="lx-sec lx-sec-pad" id="security">
              <div class="container">
                <div class="lx-sechead">
                  <div>
                    <span class="lx-ov">Security</span>
                    <h2 class="lx-h2 sm">Built to know as little as it needs.</h2>
                  </div>
                  <span class="lx-lic">Source-available · Elastic License 2.0</span>
                </div>
                <div class="lx-secgrid">
                  {SECURITY.map((s) => (
                    <div>
                      <b>{s.title}</b>
                      <span>{s.body}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="lx-price" id="pricing">
              <h2 class="lx-sr">Pricing</h2>
              <div class="container lx-pricegrid">
                <div class="lx-plan hosted">
                  <span class="lx-ov">{beta ? `Hosted · ${betaName.toLowerCase()}` : 'Hosted'}</span>
                  <div class="lx-plan-h">
                    <h3>{beta ? 'Free' : 'stma.ai'}</h3>
                    {beta ? <span>while the beta runs</span> : null}
                  </div>
                  <p>
                    {beta
                      ? `${betaDoor} Every feature is on and no card is asked for. `
                      : 'The console, the MCP server, email notifications and integrations, operated for you. '}
                    Updates, backups kept for 30 days and support by email. There is no uptime commitment outside
                    a signed order. Plans are priced by the people, never by the agents.
                  </p>
                  {site.hosted || site.teaser ? (
                    <a class={`btn btn-lg${door ? ' btn-primary' : ''}`} href={door ? door.href : '/login'}>
                      {door ? door.long : 'Sign in'}
                    </a>
                  ) : (
                    <a class="btn btn-lg" href="https://stma.ai">
                      Visit stma.ai
                    </a>
                  )}
                </div>
                <div class="lx-plan">
                  <span class="lx-ov dim">Self-hosted</span>
                  <div class="lx-plan-h">
                    <h3>Your hardware</h3>
                  </div>
                  <p>
                    The same server with an embedded database, and no account anywhere. Updates, backups and support are
                    then yours.
                  </p>
                  <CopyCommand command="npx @matteai/stma serve" />
                </div>
              </div>
            </section>

            <section class="lx-final">
              <div class="lx-final-glow" aria-hidden="true" />
              <div class="container lx-final-inner">
                <span class="lx-ov wide">AgentOps</span>
                <h2>Orchestrate every agent your team runs.</h2>
                <p>See every run. Catch every collision. Prove every change.</p>
                <div class="lx-ctas">
                  <a class="btn btn-primary btn-lg btn-glow" href={primary.href}>
                    {primary.label}
                  </a>
                  <a class="btn btn-lg" href="/docs">
                    Read the docs
                  </a>
                </div>
              </div>
            </section>
          </main>
          <SiteFooter site={site} />
        </body>
      </html>
    </>
  );
};
