/**
 * The one picture of how STMA works, used on /docs.
 *
 * Inline SVG rather than an image: it inherits the design-system CSS variables,
 * stays sharp at any width, needs no asset pipeline and costs no extra request.
 * Geometry is written out literally — a diagram nobody can read in the source is
 * a diagram nobody will keep accurate.
 */

/**
 * Vertical rhythm, and the two rules that keep it readable:
 *
 * 1. The band between the machines and the plane belongs to the arrows and
 *    their labels, nothing else. The "2 · THE CONTROL PLANE" caption lives
 *    INSIDE the plane as an overline — it used to sit in this band and the
 *    left arrow ran straight through it.
 * 2. The two label blocks face inward from arrows at x=210 and x=790, so they
 *    must not meet in the middle. Lengthening a label eats that gap; there is
 *    about 60 units of slack at the current wording.
 */
/** Column geometry, kept in one place so the two machine cards stay symmetric. */
const CARD = { y: 34, h: 106, w: 380, left: 60, right: 560 };
const PLANE = { x: 60, y: 258, w: 880, h: 198 };
const CELL = { y: 344, h: 90, w: 156, gap: 14, x0: 82 };
const OUT = { y: 528, h: 72, w: 205, gap: 20, x0: 60 };

const cellX = (i: number) => CELL.x0 + i * (CELL.w + CELL.gap);
const outX = (i: number) => OUT.x0 + i * (OUT.w + OUT.gap);

const Chip = ({ x, w, label }: { x: number; w: number; label: string }) => (
  <>
    <rect class="dg-chip" x={x} y={92} width={w} height={26} rx={13} />
    <text class="dg-chip-t" x={x + w / 2} y={109} text-anchor="middle">
      {label}
    </text>
  </>
);

const Machine = ({
  x,
  who,
  hooks,
  chips,
}: {
  x: number;
  who: string;
  hooks: string;
  chips: Array<{ label: string; w: number }>;
}) => {
  let cursor = x + 20;
  return (
    <>
      <rect class="dg-box" x={x} y={CARD.y} width={CARD.w} height={CARD.h} rx={10} />
      <text class="dg-t" x={x + 20} y={62}>
        {who}
      </text>
      <circle class="dg-live" cx={x + CARD.w - 52} cy={58} r={4} />
      <text class="dg-live-t" x={x + CARD.w - 20} y={62} text-anchor="end">
        live
      </text>
      <text class="dg-s" x={x + 20} y={82}>
        {hooks}
      </text>
      {chips.map((chip) => {
        const at = cursor;
        cursor += chip.w + 10;
        return <Chip x={at} w={chip.w} label={chip.label} />;
      })}
    </>
  );
};

const Cell = ({
  i,
  title,
  a,
  b,
}: {
  i: number;
  title: string;
  a: string;
  b: string;
}) => (
  <>
    <rect class="dg-cell" x={cellX(i)} y={CELL.y} width={CELL.w} height={CELL.h} rx={8} />
    <text class="dg-cell-t" x={cellX(i) + 16} y={370}>
      {title}
    </text>
    <text class="dg-cell-s" x={cellX(i) + 16} y={392}>
      {a}
    </text>
    <text class="dg-cell-s" x={cellX(i) + 16} y={410}>
      {b}
    </text>
  </>
);

const Surface = ({ i, title, sub }: { i: number; title: string; sub: string }) => (
  <>
    <rect class="dg-box" x={outX(i)} y={OUT.y} width={OUT.w} height={OUT.h} rx={9} />
    <text class="dg-t sm" x={outX(i) + 16} y={555}>
      {title}
    </text>
    <text class="dg-s" x={outX(i) + 16} y={577}>
      {sub}
    </text>
  </>
);

/** Two-way link between a machine and the control plane. */
const Link = ({
  x,
  labelX,
  anchor,
  head,
  down,
  up,
}: {
  x: number;
  labelX: number;
  anchor: 'start' | 'end';
  head: string;
  down: string;
  up: string;
}) => (
  <>
    <line
      class="dg-arrow"
      x1={x}
      y1={164}
      x2={x}
      y2={250}
      marker-start="url(#dg-tip)"
      marker-end="url(#dg-tip)"
    />
    <text class="dg-link-h" x={labelX} y={188} text-anchor={anchor}>
      {head}
    </text>
    <text class="dg-link" x={labelX} y={210} text-anchor={anchor}>
      {down}
    </text>
    <text class="dg-link" x={labelX} y={228} text-anchor={anchor}>
      {up}
    </text>
  </>
);

export const SystemDiagram = () => (
  <div class="diagram">
    <svg viewBox="0 0 1000 650" role="img" aria-labelledby="dg-title dg-desc">
      <title id="dg-title">How STMA works</title>
      <desc id="dg-desc">
        Each teammate's machine runs coding agents behind the STMA CLI and lifecycle hooks. Agents
        talk to the hosted control plane over MCP and the agent control API; the control plane holds
        identity, environment snapshots, debug sessions, runs and work claims, and policy. People
        read the result on the agent map, governance, activity and notification surfaces.
      </desc>

      <defs>
        <marker
          id="dg-tip"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path class="dg-tip" d="M0 0 L7 4 L0 8 Z" />
        </marker>
      </defs>

      <text class="dg-band" x={60} y={26}>
        1 · YOUR MACHINES
      </text>
      <Machine
        x={CARD.left}
        who="alice · macbook"
        hooks="stma CLI · lifecycle hooks"
        chips={[
          { label: 'Claude Code', w: 96 },
          { label: 'Cursor', w: 66 },
        ]}
      />
      <Machine
        x={CARD.right}
        who="bob · win-desktop"
        hooks="stma CLI · lifecycle hooks"
        chips={[
          { label: 'Codex', w: 62 },
          { label: 'Claude Code', w: 96 },
        ]}
      />

      <Link
        x={210}
        labelX={232}
        anchor="start"
        head="MCP · /mcp"
        down="↓ snapshots · env diffs · sessions"
        up="↑ inbox · answers · past issues"
      />
      <Link
        x={790}
        labelX={768}
        anchor="end"
        head="CLI + hooks · /api/agent"
        down="↓ runs · claims · receipts · preflight"
        up="↑ effective policy · conflicts"
      />

      <rect class="dg-plane" x={PLANE.x} y={PLANE.y} width={PLANE.w} height={PLANE.h} rx={12} />
      <text class="dg-band dark" x={84} y={284}>
        2 · THE CONTROL PLANE
      </text>
      <text class="dg-plane-t" x={84} y={310}>
        STMA
      </text>
      <text class="dg-plane-s" x={84} y={329}>
        stma.ai — hosted, or your own instance
      </text>
      <text class="dg-plane-s" x={916} y={310} text-anchor="end">
        one team · every agent · every machine
      </text>
      <Cell i={0} title="Identity" a="teams · projects" b="tokens · invites" />
      <Cell i={1} title="Snapshots" a="names & versions" b="no values, no code" />
      <Cell i={2} title="Sessions" a="async debug threads" b="searchable archive" />
      <Cell i={3} title="Runs & claims" a="who owns what file" b="overlap detection" />
      <Cell i={4} title="Policy & env" a="one rule set" b="drift receipts" />

      <line class="dg-arrow" x1={500} y1={470} x2={500} y2={520} marker-end="url(#dg-tip)" />
      <text class="dg-link" x={520} y={500}>
        server-rendered · 30s auto-refresh
      </text>

      <text class="dg-band" x={60} y={516}>
        3 · WHAT THE TEAM SEES
      </text>
      <Surface i={0} title="Agent map" sub="who is on what, right now" />
      <Surface i={1} title="Governance" sub="policy, drift, run timeline" />
      <Surface i={2} title="Activity & sessions" sub="what changed, and why" />
      <Surface i={3} title="Notifications" sub="email · webhook · Slack" />

      <text class="dg-foot" x={60} y={628}>
        Environment values and source code never leave the machine — snapshots carry names,
        versions and hashes only.
      </text>
    </svg>
  </div>
);
