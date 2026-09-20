/**
 * The scope graph above the agent ledger: who is holding what, as a picture.
 *
 * The ledger answers "what is running"; a reader still had to hold six rows of
 * `file:src/payments/charge.ts` in their head to see that two of them were the
 * same piece of ground. This draws that relation instead: runs on the left,
 * the scope they hold on the right, one line per claim. Two write lines landing
 * on one box is the collision, and it is red before anybody reads a word.
 *
 * Inline SVG in the `Diagram.tsx` idiom — literal geometry, colours from the
 * design-system variables, no asset pipeline and no extra request. It is a
 * second rendering of the data the ledger already has, never a second source:
 * contested comes from the same `detectClaimConflicts` result the ledger badge
 * and the inspector use, so the picture cannot disagree with the words.
 *
 * Selection is a link (`?run=` / `?scope=`), like everything else on this page,
 * so it survives a refresh and can be pasted to a teammate. What is dimmed is
 * computed here from that selection rather than by script: with a run selected
 * the graph shows that run and its ground, and with a scope selected it shows
 * every run holding it.
 *
 * It also remembers a little (2026-09-19). Presence alone made the map forget: a
 * run that reported its work complete lost its lines, and an agent whose session
 * closed left the picture. Ground a run let go of is drawn as a faint dotted
 * line to a faded box, and an agent with no live run keeps a faded glyph for a
 * day. Faded never means contested and never counts as a holder.
 */

export type GraphHold = { scope: string; access: 'read' | 'write' };

export interface GraphRun {
  id: string;
  task: string;
  who: string;
  initials: string;
  /** Heartbeat inside the freshness window: a live ring, not a grey one. */
  fresh: boolean;
  /** null when nobody reported one. An estimate is never drawn as a solid arc. */
  quotaPct: number | null;
  quotaMeasured: boolean;
  /** `unknown` is silence, not compliance — the same distinction the receipts make. */
  policy: 'ok' | 'drift' | 'unknown';
  contested: boolean;
  attemptGroup: string | null;
  holds: GraphHold[];
  /** Ground this run held and let go of: completed work, or everything an ended run had. */
  held?: GraphHold[];
  /** No longer live: the newest run of an agent that is not working right now. */
  ended?: boolean;
}

export interface GraphScope {
  id: string;
  kind: string;
  label: string;
  contested: boolean;
  holders: number;
  /** Nobody holds it now; somebody on the graph did. */
  past?: boolean;
}

export type GraphSelection = { type: 'run' | 'scope'; id: string } | null;

/**
 * Column geometry. The left column is right-aligned text ending at LX-38 and a
 * glyph centred on LX; the right column is a 180-wide box starting at RX. The
 * gap between them belongs to the links and nothing else.
 */
const GAP_Y = 70;
const TOP = 82;
const LX = 210;
const RX = 480;
const W = 660;
const BOX_W = 180;
const R = 18;
const ARC = R + 6;
const CIRC = 2 * Math.PI * ARC;

/** Bounded like every other list here: a busy workspace must not render forever. */
const MAX_RUNS = 8;
const MAX_SCOPES = 9;

const runY = (i: number) => TOP + i * GAP_Y;
const scopeY = (j: number) => TOP + 6 + j * GAP_Y;

const ellipsis = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Which run and scope glyphs stay lit for the current selection. */
function related(selection: GraphSelection, runs: GraphRun[]) {
  if (!selection) return null;
  if (selection.type === 'run') {
    const run = runs.find((r) => r.id === selection.id);
    if (!run) return null;
    return { runs: new Set([run.id]), scopes: new Set([...run.holds, ...(run.held ?? [])].map((h) => h.scope)) };
  }
  const holders = runs.filter((r) => [...r.holds, ...(r.held ?? [])].some((h) => h.scope === selection.id));
  return { runs: new Set(holders.map((r) => r.id)), scopes: new Set([selection.id]) };
}

/**
 * Attempt siblings are drawn inside one dashed frame, so the runs have to sit
 * next to each other. Ordering by where a group first appears keeps the ledger's
 * order everywhere else and only pulls siblings together.
 */
function clustered(runs: GraphRun[]) {
  const first = new Map<string, number>();
  const groupOf = (run: GraphRun) => run.attemptGroup ?? `~${run.id}`;
  runs.forEach((run, i) => {
    const key = groupOf(run);
    if (!first.has(key)) first.set(key, i);
  });
  return [...runs].sort((a, b) => (first.get(groupOf(a)) ?? 0) - (first.get(groupOf(b)) ?? 0));
}

const quotaClass = (pct: number) => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok');

const POLICY: Record<GraphRun['policy'], { cls: string; mark: string }> = {
  ok: { cls: 'ok', mark: '✓' },
  drift: { cls: 'bad', mark: '×' },
  unknown: { cls: 'warn', mark: '?' },
};

const Glyph = ({ run, y, selected, dim }: { run: GraphRun; y: number; selected: boolean; dim: boolean }) => {
  const policy = POLICY[run.policy];
  const pct = run.quotaPct == null ? 0 : Math.max(0, Math.min(100, run.quotaPct)) / 100;
  return (
    <g class={`sg-node${dim ? ' off' : ''}${run.ended ? ' ended' : ''}`} transform={`translate(${LX} ${y})`}>
      {run.fresh && !run.ended ? <circle class="sg-pulse" r={R} /> : null}
      <circle class="sg-ring" r={ARC} />
      {run.quotaPct == null ? null : (
        <circle
          class={`sg-quota ${quotaClass(run.quotaPct)}`}
          r={ARC}
          stroke-linecap="round"
          stroke-dasharray={run.quotaMeasured ? `${CIRC * pct} ${CIRC}` : '4 4'}
          transform="rotate(-90)"
        />
      )}
      <circle class={`sg-face${run.fresh && !run.ended ? ' live' : ''}`} r={R} />
      <text class="sg-init" y={1} text-anchor="middle" dominant-baseline="middle">
        {run.initials}
      </text>
      <g transform={`translate(${R * 0.72} ${R * 0.72})`}>
        <circle class={`sg-badge ${policy.cls}`} r={7} />
        <text class="sg-badge-t" y={1} text-anchor="middle" dominant-baseline="middle">
          {policy.mark}
        </text>
      </g>
      {run.contested ? (
        <g transform={`translate(${-R * 0.72} ${-R * 0.72})`}>
          <circle class="sg-badge bad" r={7} />
          <text class="sg-badge-t" y={1} text-anchor="middle" dominant-baseline="middle">
            !
          </text>
        </g>
      ) : null}
      {selected ? <circle class="sg-sel-ring" r={ARC + 5} /> : null}
    </g>
  );
};

export const ScopeGraph = ({
  runs,
  scopes,
  selection,
  runHref,
  scopeHref,
}: {
  runs: GraphRun[];
  scopes: GraphScope[];
  selection: GraphSelection;
  runHref: (id: string) => string;
  scopeHref: (id: string) => string;
}) => {
  const shownRuns = clustered(runs).slice(0, MAX_RUNS);
  const drawn = new Set(shownRuns.map((r) => r.id));
  // Only scope somebody on the graph actually holds: a box with no line into it
  // says nothing, and the right column is the scarcer space.
  const shownScopes = scopes
    .filter((s) => shownRuns.some((r) => [...r.holds, ...(r.held ?? [])].some((h) => h.scope === s.id)))
    .slice(0, MAX_SCOPES);
  const scopeIndex = new Map(shownScopes.map((s, j) => [s.id, j]));
  const rel = related(selection, shownRuns);
  const height = TOP + Math.max(shownRuns.length, shownScopes.length) * GAP_Y - 10;

  const groups = new Map<string, number[]>();
  shownRuns.forEach((run, i) => {
    if (!run.attemptGroup) return;
    groups.set(run.attemptGroup, [...(groups.get(run.attemptGroup) ?? []), i]);
  });

  return (
    <svg class="sg" viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Runs and the scope each one holds">
      {[...groups.entries()]
        .filter(([, idx]) => idx.length > 1)
        .map(([name, idx]) => (
          <>
            <rect
              class="sg-group"
              x={LX - 178}
              y={runY(idx[0]!) - 34}
              width={250}
              height={runY(idx[idx.length - 1]!) - runY(idx[0]!) + 68}
              rx={10}
            />
            <text class="sg-group-t" x={LX - 170} y={runY(idx[0]!) - 40}>
              {`ATTEMPT GROUP · ${ellipsis(name.toUpperCase(), 22)} · ${idx.length} ATTEMPTS`}
            </text>
          </>
        ))}

      {shownRuns.map((run, i) =>
        run.holds
          .filter((hold) => scopeIndex.has(hold.scope))
          .map((hold) => {
            const j = scopeIndex.get(hold.scope)!;
            const hot = hold.access === 'write' && (scopes.find((s) => s.id === hold.scope)?.contested ?? false);
            const lit = !rel || (rel.runs.has(run.id) && rel.scopes.has(hold.scope));
            const x1 = LX + 32;
            const y1 = runY(i);
            const x2 = RX - 12;
            const y2 = scopeY(j);
            const mx = (x1 + x2) / 2;
            return (
              <path
                class={`sg-link${hold.access === 'write' ? '' : ' read'}${hot ? ' hot' : ''}${lit ? '' : ' off'}`}
                d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}
              />
            );
          }),
      )}

      {shownRuns.map((run, i) =>
        (run.held ?? [])
          .filter((hold) => scopeIndex.has(hold.scope) && !run.holds.some((live) => live.scope === hold.scope))
          .map((hold) => {
            const lit = !rel || (rel.runs.has(run.id) && rel.scopes.has(hold.scope));
            const x1 = LX + 32;
            const y1 = runY(i);
            const x2 = RX - 12;
            const y2 = scopeY(scopeIndex.get(hold.scope)!);
            const mx = (x1 + x2) / 2;
            return <path class={`sg-link past${lit ? '' : ' off'}`} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} />;
          }),
      )}

      {shownRuns.map((run, i) => (
        <a href={runHref(run.id)}>
          <Glyph
            run={run}
            y={runY(i)}
            selected={selection?.type === 'run' && selection.id === run.id}
            dim={Boolean(rel && !rel.runs.has(run.id))}
          />
          <text class="sg-task" x={LX - 38} y={runY(i) - 5} text-anchor="end" opacity={rel && !rel.runs.has(run.id) ? 0.3 : run.ended ? 0.55 : 1}>
            {ellipsis(run.task, 22)}
          </text>
          <text class="sg-who" x={LX - 38} y={runY(i) + 10} text-anchor="end" opacity={rel && !rel.runs.has(run.id) ? 0.3 : run.ended ? 0.55 : 1}>
            {ellipsis(run.who, 30)}
          </text>
        </a>
      ))}

      {shownScopes.map((scope, j) => {
        const dim = Boolean(rel && !rel.scopes.has(scope.id));
        const chosen = selection?.type === 'scope' && selection.id === scope.id;
        return (
          <a href={scopeHref(scope.id)}>
            <g class={`sg-node${dim ? ' off' : ''}${scope.past ? ' past' : ''}`} transform={`translate(${RX} ${scopeY(j)})`}>
              <rect
                class={`sg-box${scope.contested ? ' hot' : ''}${chosen ? ' sel' : ''}`}
                x={-12}
                y={-17}
                width={BOX_W}
                height={34}
                rx={6}
              />
              {scope.contested ? (
                <>
                  <circle class="sg-badge bad" cx={-12} cy={-17} r={7} />
                  <text class="sg-badge-t" x={-12} y={-16} text-anchor="middle" dominant-baseline="middle">
                    {scope.holders}
                  </text>
                </>
              ) : null}
              <text class={`sg-kind${scope.contested ? ' hot' : ''}`} x={0} y={-2}>
                {scope.past ? `${scope.kind.toUpperCase()} · EARLIER` : scope.kind.toUpperCase()}
              </text>
              <text class={`sg-label${scope.contested ? ' hot' : ''}`} x={0} y={10}>
                {ellipsis(scope.label, 24)}
              </text>
            </g>
          </a>
        );
      })}

      <text class="sg-col" x={LX - 60} y={12} text-anchor="middle">
        RUNS
      </text>
      <text class="sg-col" x={RX + 78} y={12} text-anchor="middle">
        SCOPE HELD
      </text>
    </svg>
  );
};

/** What the graph left out, said in words rather than silently dropped. */
export const graphOverflow = (runs: number, scopes: number) => {
  const parts: string[] = [];
  if (runs > MAX_RUNS) parts.push(`${runs - MAX_RUNS} more run${runs - MAX_RUNS === 1 ? '' : 's'}`);
  if (scopes > MAX_SCOPES) parts.push(`${scopes - MAX_SCOPES} more scope${scopes - MAX_SCOPES === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' and ')} in the ledger below, not drawn` : null;
};
