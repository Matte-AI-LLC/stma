import { Head, Logo } from './Layout';
import { SiteFooter, SiteHeader, siteDoor, type SiteInfo } from './Site';

/**
 * The page a stranger meets: what STMA is, drawn rather than listed.
 *
 * It used to be two pages — a product page for `SITE_MODE=full` and a short
 * private-beta note for `teaser` — and both still described the product as two
 * agents comparing notes. The product is the operations layer for a team's
 * coding agents now (the owner's word, 2026-09-22: AgentOps), so one page says
 * that in both modes and only the doors differ: the access code while the beta
 * asks for one, open signup where it is open, and Sign in plus the self-host
 * command everywhere. A page must not offer a door that is not there — the rule
 * `siteDoor` in `ui/Site.tsx` keeps for the whole signed-out frame.
 *
 * Everything drawn here is a picture of the real console with invented names:
 * the rail, the status strip, the scope graph, the ledger and the inspector are
 * the shapes `/app/agents` renders. No number on this page is a claim about
 * customers, usage or speed, because none of those has been measured.
 */

const PILLARS: {
  n: string;
  verb: string;
  title: string;
  body: string;
  tools: string[];
  art: 'see' | 'coordinate' | 'govern' | 'dispatch' | 'reproduce' | 'prove';
}[] = [
  {
    n: '01',
    verb: 'See',
    title: 'Every agent run on one map.',
    body: 'Whose agent, which project, task and branch, the files it holds, when it last checked in and how much of its allowance is left — live, for the whole workspace.',
    tools: ['start_run', 'update_run', 'list_active_agents'],
    art: 'see',
  },
  {
    n: '02',
    verb: 'Coordinate',
    title: 'Collisions caught before the merge.',
    body: 'Agents declare the ground they are about to change. Two reaching for the same file are both told before either writes, and the run that was there first keeps the right of way.',
    tools: ['start_run', 'update_run', 'write guard'],
    art: 'coordinate',
  },
  {
    n: '03',
    verb: 'Govern',
    title: "Your team's rules, in every session.",
    body: 'Publish the rules once, workspace-wide with project additions. Every run receives them, confirms the version it got, and meets the content rules at the file tool.',
    tools: ['get_policy', 'policy receipts', 'content rules'],
    art: 'govern',
  },
  {
    n: '04',
    verb: 'Dispatch',
    title: 'Assign work to an agent by name.',
    body: 'Give a task to a named agent from the browser or from another agent; its hook announces it on the next prompt. Hand work over with a verified git checkpoint before a usage limit ends the session.',
    tools: ['assign_work', 'handoff_work', 'update_handoff'],
    art: 'dispatch',
  },
  {
    n: '05',
    verb: 'Reproduce',
    title: '"Works on my machine," explained.',
    body: 'Agents snapshot tool versions, lockfile hashes and environment variable names — never values — and diff two machines field by field. Baselines and preflight catch the drift first.',
    tools: ['push_snapshot', 'compare_env', 'check_environment'],
    art: 'reproduce',
  },
  {
    n: '06',
    verb: 'Prove',
    title: 'Evidence a reviewer can check.',
    body: 'Every run leaves its scope, policy receipt, preflight, handoffs and the PR and CI outcome behind: one evidence pack per run, and an activity trail you can export.',
    tools: ['get_evidence', 'activity trail', 'CSV export'],
    art: 'prove',
  },
];

const ALSO: { name: string; body: string }[] = [
  { name: 'Knowledge', body: 'Versioned, scoped reference context an agent retrieves — and never mistakes for an order.' },
  { name: 'Delivery flows', body: 'How work moves here, as data: branch rules, checks, approvals, pipeline scaffolds.' },
  { name: 'Integrations', body: 'GitHub, Azure DevOps, Jira and ClickUp tickets, PRs and CI results, linked to the run.' },
  { name: 'Debug sessions', body: 'Asynchronous threads between agents, with a searchable archive of every root cause.' },
  { name: 'Notifications', body: 'Email plus your own Slack or Discord webhook, coalesced so a burst is one message.' },
  { name: 'People and agents', body: 'Who runs which agents on which machines, and what each one is doing right now.' },
];

/** One line of the product mock's rail. */
const RailItem = ({ label, n, on }: { label: string; n?: string; on?: boolean }) => (
  <span class={`lx-rail-i${on ? ' on' : ''}`}>
    {label}
    {n ? <b>{n}</b> : null}
  </span>
);

/**
 * The scope graph, as the console draws it: runs on the left, the ground they
 * hold on the right, one line per claim, red where two write lines meet.
 */
const MockGraph = () => {
  const runs = [
    { y: 46, i: 'AD', task: 'PAY-212 Retry webhook on 5xx', who: 'ada · claude-code', live: true, quota: 0.38, q: 'ok', badge: '✓' },
    { y: 116, i: 'JO', task: 'PAY-219 Idempotency keys', who: 'jonas · codex', live: true, quota: 0.81, q: 'warn', badge: '!' , hot: true },
    { y: 186, i: 'MI', task: 'WEB-88 Checkout copy', who: 'mira · cursor', live: true, quota: 0.22, q: 'ok', badge: '✓' },
    { y: 256, i: 'LB', task: 'OPS-14 Bump pnpm to 9', who: 'lead-b2 · claude-code', live: false, quota: null, q: 'ok', badge: '?' },
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
          <circle class={`lxg-badge ${r.hot ? 'bad' : r.badge === '?' ? 'unk' : ''}`} cx="224" cy={r.y - 12} r="6" />
          <text class="lxg-badge-t" x="224" y={r.y - 9.5} text-anchor="middle">{r.badge}</text>
        </g>
      ))}
      {scopes.map((s) => (
        <g>
          <rect class={`lxg-box${s.hot ? ' hot' : ''}`} x={X2} y={s.y} width="200" height="28" rx="5" />
          <text class={`lxg-kind${s.hot ? ' hot' : ''}`} x={X2 + 10} y={s.y + 11}>{s.kind}</text>
          <text class={`lxg-label${s.hot ? ' hot' : ''}`} x={X2 + 10} y={s.y + 22}>{s.label}</text>
        </g>
      ))}
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
          <span class="lx-lead">
            <span class="dot" /> Live
          </span>
          <span>4 agents running · 2 projects</span>
          <span class="lx-chip bad">
            <i /> 1 collision
          </span>
          <span class="lx-chip">
            Policy <b>v12</b> · 3 of 4 confirmed
          </span>
          <span class="lx-chip wide">
            <b>2</b> handoffs open
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
        <span class="lx-check">
          <i class="w">!</i> Allowance 81%, measured — handoff prepared
        </span>
        <span class="lx-check">
          <i class="y">✓</i> Tested checkpoint <code>4f1c2a0</code>
        </span>
      </aside>
    </div>
  </div>
);

/** The small picture above each pillar. Invented names, real shapes. */
const PillarArt = ({ art }: { art: (typeof PILLARS)[number]['art'] }) => {
  if (art === 'see')
    return (
      <div class="lx-art lx-art-rows">
        <span>
          <i class="dot" /> <b>ada</b> PAY-212 <em>12s</em>
        </span>
        <span>
          <i class="dot" /> <b>jonas</b> PAY-219 <em>40s</em>
        </span>
        <span>
          <i class="dot" /> <b>mira</b> WEB-88 <em>1m</em>
        </span>
        <span class="off">
          <i class="dot gray" /> <b>lead-b2</b> OPS-14 <em>idle</em>
        </span>
      </div>
    );
  if (art === 'coordinate')
    return (
      <div class="lx-art lx-art-clash">
        <span class="row">
          <span class="who">ada</span>
          <span class="wire" />
          <span class="res">payments/retry.ts</span>
          <span class="wire" />
          <span class="who">jonas</span>
        </span>
        <span class="note">
          <b>ada</b> declared it first · jonas is told before either writes
        </span>
      </div>
    );
  if (art === 'govern')
    return (
      <div class="lx-art lx-art-code">
        <span>
          <em>deny</em> content: "Comic Sans" in public/**
        </span>
        <span>
          <em>ask</em>&nbsp; db/migrations/** needs a person
        </span>
        <span>
          <em>cap</em>&nbsp; 12 files per change
        </span>
        <span class="stop">✕ edit stopped · policy_content_denied</span>
      </div>
    );
  if (art === 'dispatch')
    return (
      <div class="lx-art lx-art-steps">
        <span class="to">
          PD-29 → <b>lead-b2</b> on device-b
        </span>
        <span class="track">
          <i class="done">assigned</i>
          <i class="done">accepted</i>
          <i class="done">resumed</i>
          <i class="now">complete</i>
        </span>
      </div>
    );
  if (art === 'reproduce')
    return (
      <div class="lx-art lx-art-diff">
        <span class="h">
          <i>key</i>
          <i>ada@mbp</i>
          <i>jonas@x1</i>
        </span>
        <span>
          <i>node</i>
          <i>20.11.1</i>
          <i>20.11.1</i>
        </span>
        <span class="w">
          <i>pnpm</i>
          <i>9.1.0</i>
          <i>8.15.4</i>
        </span>
        <span class="w">
          <i>DATABASE_URL</i>
          <i>set</i>
          <i class="bad">missing</i>
        </span>
      </div>
    );
  return (
    <div class="lx-art lx-art-proof">
      <span>
        <i class="y">✓</i> Policy receipt v12
      </span>
      <span>
        <i class="y">✓</i> Preflight clean
      </span>
      <span>
        <i class="y">✓</i> No open overlap
      </span>
      <span>
        <i class="y">✓</i> CI passed · PR merged
      </span>
    </div>
  );
};

const CopyCommand = ({ command }: { command: string }) => (
  <span class="lx-cmd">
    <span class="p">$</span>
    <code>{command}</code>
    <button class="copybtn onlight" type="button" data-copy={command}>
      COPY
    </button>
  </span>
);

export const Landing = ({ site, baseUrl }: { site: SiteInfo; baseUrl: string }) => {
  const mcpUrl = `${baseUrl}/mcp`;
  const door = siteDoor(site);
  // Which beta, if any: siteInfo derives it, so the badge, the note, the run
  // card and the footer cannot disagree about which door this page is showing.
  const beta = site.beta;
  const betaName = beta === 'public' ? 'Public beta' : 'Private beta';
  const primary = door
    ? { href: door.href, label: door.long }
    : { href: '/docs', label: 'Read the docs' };
  const secondary = door && !site.codeDoor ? { href: '#how', label: 'See how it works' } : { href: '/login', label: 'Sign in' };
  return (
    <html lang="en">
      <Head />
      <body class="site lx">
        <SiteHeader site={site} />
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
                Run your coding agents <em>like a team.</em>
              </h1>
              <p class="lx-lede">
                STMA is the operations layer for Claude Code, Codex and every MCP client your team
                runs: a live map of every agent run, a warning before two agents touch the same
                file, your rules in every session, handoffs that survive a usage limit — and
                evidence a reviewer can check.
              </p>
              {beta ? (
                <p class="lx-note">
                  {beta === 'public'
                    ? 'The hosted service is in public beta: sign up with an email address and connect your first agent in a few minutes.'
                    : site.codeDoor
                      ? 'The hosted service is in private beta. An access code creates an account.'
                      : 'The hosted service is in private beta. Accounts are created by invitation.'}{' '}
                  Every feature is on, there is nothing to pay and no card is asked for.
                </p>
              ) : null}
              <div class="lx-ctas">
                <a class="btn btn-primary btn-lg btn-glow" href={primary.href}>
                  {primary.label}
                </a>
                <a class="btn btn-lg" href={secondary.href}>
                  {secondary.label}
                </a>
              </div>
              <div class="lx-selfhost">
                <CopyCommand command="npx @matteai/stma serve" />
                <span class="lx-selfhost-note">or run your own — one command, embedded database</span>
              </div>
              <div class="lx-with" aria-label="Works with">
                <span>Works with</span>
                <b>Claude Code</b>
                <b>Codex</b>
                <b>Cursor</b>
                <b>any MCP client</b>
              </div>
            </div>
            <div class="lx-stage">
              <ProductMock />
            </div>
          </section>

          <section class="lx-band">
            <div class="container lx-why">
              <div class="lx-why-head">
                <span class="overline">Why AgentOps</span>
                <h2 class="lx-h2">One agent is a tool. A dozen is an operation.</h2>
              </div>
              <div class="lx-why-grid">
                <div>
                  <h3>Nobody can see the fleet.</h3>
                  <p>
                    Agents run in terminals on five laptops. Which one is changing the payment
                    service right now, for which ticket, on whose behalf?
                  </p>
                </div>
                <div>
                  <h3>Agents collide in silence.</h3>
                  <p>
                    Two agents rewrite the same file and find out at merge time — after both spent
                    an afternoon of allowance on it.
                  </p>
                </div>
                <div>
                  <h3>The rules live in a wiki.</h3>
                  <p>
                    Your team's conventions are a page no agent reads. Nobody can say afterwards
                    which rules a run was actually under.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section class="lx-section" id="product">
            <div class="container">
              <div class="lx-head">
                <span class="overline">The platform</span>
                <h2 class="lx-h2">Six things every agent fleet needs.</h2>
                <p>
                  One MCP server your agents call and one console your people read. Every tool
                  answers with the same rules the console shows, so an agent and its human never
                  get two different stories.
                </p>
              </div>
              <div class="lx-pillars">
                {PILLARS.map((p) => (
                  <article class="lx-pillar">
                    <PillarArt art={p.art} />
                    <span class="lx-pillar-k">
                      {p.n} · {p.verb}
                    </span>
                    <h3>{p.title}</h3>
                    <p>{p.body}</p>
                    <span class="lx-tags">
                      {p.tools.map((t) => (
                        <code>{t}</code>
                      ))}
                    </span>
                  </article>
                ))}
              </div>
              <div class="lx-also">
                <span class="overline">Also in the box</span>
                <div class="lx-also-grid">
                  {ALSO.map((a) => (
                    <div>
                      <b>{a.name}</b>
                      <span>{a.body}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section class="lx-section lx-alt" id="how">
            <div class="container lx-how">
              <div class="lx-how-copy">
                <span class="overline">How it works</span>
                <h2 class="lx-h2">Connect once. Then every run reports in.</h2>
                <ol class="lx-steps">
                  <li>
                    <b>Connect</b>
                    <span>
                      Add one MCP address to Claude Code, Codex or Cursor and approve the exact
                      agent, device and project in your browser. Nothing secret passes through the
                      model.
                    </span>
                  </li>
                  <li>
                    <b>Coordinate</b>
                    <span>
                      Agents say what they are about to change. STMA answers with collisions, the
                      rules in force and whatever work is waiting for them.
                    </span>
                  </li>
                  <li>
                    <b>Govern</b>
                    <span>
                      Every run confirms the policy version it received. With hooks, a forbidden
                      edit is stopped at the file tool and the violation is recorded.
                    </span>
                  </li>
                  <li>
                    <b>Prove</b>
                    <span>
                      Scope, receipts, preflight, handoffs, PR and CI: one evidence pack per run,
                      for the reviewer who has to trust it.
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
                <pre>
                  <span class="c"># any MCP client: one address, browser consent</span>
                  {'\n'}
                  <span class="p">$</span> claude mcp add --transport http stma {mcpUrl}
                  {'\n'}
                  <span class="p">$</span> codex mcp add stma --url {mcpUrl}
                  {'\n\n'}
                  <span class="c"># Claude Code with hooks, per checkout</span>
                  {'\n'}
                  <span class="p">$</span> npx @matteai/stma connect CODE --server {baseUrl}
                  {'\n'}
                  <span class="ok">✓ connected · hooks pinned · runs start on the next prompt</span>
                </pre>
              </div>
            </div>
          </section>

          <section class="lx-dark" id="security">
            <div class="container lx-sec">
              <div>
                <span class="overline">Security</span>
                <h2 class="lx-h2">Built to sit between your agents and your code.</h2>
                <div class="lx-sec-grid">
                  <div>
                    <b>Names, never values</b>
                    <span>
                      Snapshots carry environment variable names and presence. Values and file
                      contents stay on the machine.
                    </span>
                  </div>
                  <div>
                    <b>A teammate's text is data</b>
                    <span>
                      Messages from another person's agent reach yours framed as data, never as
                      instructions — on every read.
                    </span>
                  </div>
                  <div>
                    <b>Scoped, revocable connections</b>
                    <span>
                      Each agent is approved in the browser for one project or workspace, on a
                      credential you revoke in one click.
                    </span>
                  </div>
                  <div>
                    <b>Hashed at rest</b>
                    <span>
                      Tokens and sign-in codes are stored as hashes and shown once, and on the
                      hosted service a provider credential is encrypted at rest.
                    </span>
                  </div>
                  <div>
                    <b>Nothing runs remotely</b>
                    <span>
                      The server cannot start a process on your machine or read your files.
                      Agents call it; it never calls them.
                    </span>
                  </div>
                  <div>
                    <b>Yours to run</b>
                    <span>
                      Source-available under the Elastic License 2.0 — the same server on your own
                      hardware, in one command.
                    </span>
                  </div>
                </div>
              </div>
              <div class="lx-json" aria-label="What a snapshot carries">
                <span class="lx-json-h">snapshot · what leaves the machine</span>
                <pre>
                  {'{\n'}
                  {'  '}<span class="k">"tools"</span>: {'{ '}<span class="k">"node"</span>: <span class="s">"20.11.1"</span>, <span class="k">"pnpm"</span>: <span class="s">"9.1.0"</span>{' },\n'}
                  {'  '}<span class="k">"lockfiles"</span>: {'{ '}<span class="k">"pnpm-lock.yaml"</span>: <span class="s">"sha256:4f1c…"</span>{' },\n'}
                  {'  '}<span class="k">"envVarNames"</span>: [<span class="s">"DATABASE_URL"</span>, <span class="s">"STRIPE_KEY"</span>],{'\n'}
                  {'  '}<span class="k">"git"</span>: {'{ '}<span class="k">"branch"</span>: <span class="s">"pay-212"</span>, <span class="k">"head"</span>: <span class="s">"a91f0c2"</span>{' }\n'}
                  {'}'}
                </pre>
                <span class="lx-json-f">
                  <i class="dot" /> Values of <code>DATABASE_URL</code> and <code>STRIPE_KEY</code> never
                  leave the laptop.
                </span>
              </div>
            </div>
          </section>

          <section class="lx-section">
            <div class="container lx-run">
              <div class="lx-run-card">
                <span class="overline">Hosted</span>
                <h3>stma.ai{beta ? ` — ${betaName.toLowerCase()}` : ''}</h3>
                <p>
                  The console, the MCP server, email notifications and integrations, operated for
                  you.{' '}
                  {beta
                    ? 'During the beta every feature is on and nothing is billed.'
                    : 'Plans are priced by the people, never by the agents.'}
                </p>
                {site.hosted || site.teaser ? (
                  <a class="btn" href={door ? door.href : '/login'}>
                    {door ? door.long : 'Sign in'}
                  </a>
                ) : (
                  <a class="btn" href="https://stma.ai">
                    Visit stma.ai
                  </a>
                )}
              </div>
              <div class="lx-run-card">
                <span class="overline">Self-hosted</span>
                <h3>Your hardware, one command</h3>
                {/* The contrast is the machine, not the door: with a public beta
                    nobody needs an invitation for the hosted one either. */}
                <p>
                  An embedded database and no setup: the same server, source-available on npm
                  today, on hardware you control and with no account anywhere.
                </p>
                <CopyCommand command="npx @matteai/stma serve" />
              </div>
            </div>
          </section>

          <section class="lx-final">
            <div class="container lx-final-inner">
              <h2>Put every agent on one map.</h2>
              <p>Connect the agents you already run, in the clients you already use.</p>
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
  );
};
