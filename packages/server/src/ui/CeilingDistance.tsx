import {
  CEILING_MARK,
  ceilingRatio,
  ceilingText,
  type BetaWorkspace,
  type CeilingUse,
  type FeatureLoss,
} from '../domain/betaCohorts';

/**
 * How far each beta workspace is from the ceilings of the plan it lands on, as
 * one picture — free for everybody nobody gave a plan to, and the operator's
 * grant for the ones somebody did (`landsOn` in `domain/betaCohorts`).
 *
 * The table below it can say `2 / 1` in five columns, and a reader still has to
 * hold five fractions in their head per row to see which workspace breaks
 * first. This draws the one thing they are actually comparing: a single
 * vertical rule is the free plan, and every mark is a workspace's distance from
 * it. Left of the rule is room; on it is a workspace one person or one project
 * away; right of it is already past, before the flag has even been unset.
 *
 * A count of signups over time would have been the easy chart and answers
 * nothing — `/admin/usage` already draws arrival. The question this page exists
 * for is what the flip costs, and that is a distance, not a rate.
 *
 * A track per ceiling rather than every mark on one line, which is what the
 * first draft did: at the right-hand edge three ceilings all pin to the same x
 * and their labels landed on top of each other, exactly where a reader most
 * needs to know which one. A track per ceiling costs height and can never
 * collide, and the letter sits in a fixed gutter instead of chasing its mark.
 * The row height follows the number of tracks, so a ceiling added to the
 * ledger cannot push a track across the next workspace's separator.
 *
 * Same house rules as `Diagram.tsx` and `ScopeGraph.tsx`: inline SVG, literal
 * geometry, colours from the design-system variables, no asset pipeline and no
 * second request. And the same rule about inputs — every mark here is read from
 * the `BetaWorkspace` rows the table renders, never recomputed, so the picture
 * cannot disagree with the words under it.
 */

const W = 740;
/** Right edge of the workspace name. */
const NAME_R = 172;
/** Right edge of the one-letter track labels. */
const LANE_R = 192;
/** Nothing used. */
const X0 = 200;
/**
 * The ceiling of the plan each workspace lands on. Literal, not derived: it is
 * the whole point of the drawing. Every mark is a ratio to its own workspace's
 * row, so one rule serves a free workspace and a gifted Team one alike.
 */
const XC = 380;
/** Twice the ceiling — the right end of the axis. */
const XMAX = 560;
const FEATURE_X = [600, 630, 660, 690];
/** One track per ceiling the ledger reports. */
const LANES = Object.keys(CEILING_MARK).length;
/** Vertical distance between two of a workspace's tracks. */
const LANE = 10;
/** From a workspace's middle to its outermost track. */
const SPREAD = ((LANES - 1) / 2) * LANE;
/** The line the column headings sit above. */
const AXIS = 48;
/** Middle of the first workspace: its top track sits 6px under the axis. */
const TOP = AXIS + 6 + SPREAD;
/** One workspace, with 8px between its outer tracks and each separator. */
const ROW = 2 * SPREAD + 16;

/** Bounded like every other operator list; `chartOverflow` says what was left out. */
export const MAX_CHART_ROWS = 10;

const rowMid = (i: number) => TOP + i * ROW;
const laneY = (i: number, k: number) => rowMid(i) + k * LANE - SPREAD;

/**
 * Ratio to x. Anything at or past twice the ceiling pins to the right edge and
 * is drawn as a chevron rather than a dot, because a workspace forty times over
 * a ceiling would otherwise need an axis nobody can read the rest of.
 */
const ratioX = (ratio: number) => X0 + (Math.min(ratio, 2) / 2) * (XMAX - X0);

const ellipsis = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const FEATURE_MARK: Record<FeatureLoss['key'], string> = {
  fleet: 'F',
  governance: 'G',
  evidence: 'E',
  savings: 'S',
};

const Track = ({ use, y, plan }: { use: CeilingUse; y: number; plan: string }) => {
  const ratio = ceilingRatio(use);
  const x = ratioX(ratio);
  const cls = use.over ? ' over' : ratio >= 1 ? ' onit' : '';
  const title = `${use.label}: ${ceilingText(use)} ${use.per} on ${plan}`;
  return (
    <>
      <text class={`cd-lane${cls}`} x={LANE_R} y={y + 3} text-anchor="end">
        {CEILING_MARK[use.key]}
      </text>
      <line class="cd-track" x1={X0} y1={y} x2={XMAX} y2={y} />
      {use.over ? <circle class="cd-pulse" cx={x} cy={y} r={5} /> : null}
      {ratio >= 2 ? (
        <path class="cd-pin" d={`M${x - 4} ${y - 3.2}L${x + 4} ${y}L${x - 4} ${y + 3.2}Z`}>
          <title>{title}</title>
        </path>
      ) : (
        <circle class={`cd-dot${cls}`} cx={x} cy={y} r={3.6}>
          <title>{title}</title>
        </circle>
      )}
    </>
  );
};

const FeatureBox = ({ loss, x, y }: { loss: FeatureLoss; x: number; y: number }) => (
  <>
    <rect class={`cd-feat ${loss.state}`} x={x - 7} y={y - 7} width={14} height={14} rx={3}>
      <title>{`${loss.label}: ${loss.evidence}`}</title>
    </rect>
    <text class={`cd-feat-t ${loss.state}`} x={x} y={y + 3} text-anchor="middle">
      {loss.state === 'unrecorded' ? '?' : FEATURE_MARK[loss.key]}
    </text>
  </>
);

export const CeilingDistance = ({
  workspaces,
  href,
  cohortLabel,
}: {
  workspaces: BetaWorkspace[];
  href: (workspace: BetaWorkspace) => string;
  /** The console's one spelling of a cohort, passed in rather than repeated here. */
  cohortLabel: (cohort: string | null) => string;
}) => {
  const rows = workspaces.slice(0, MAX_CHART_ROWS);
  const height = TOP + Math.max(0, rows.length - 1) * ROW + SPREAD + 14;
  return (
    <svg
      class="cd"
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      role="img"
      aria-label="Each workspace's distance from the ceilings of the plan it lands on"
    >
      <line class="cd-axis" x1={X0} y1={AXIS} x2={XMAX} y2={AXIS} />
      <line class="cd-ceiling" x1={XC} y1={AXIS - 8} x2={XC} y2={height - 16} />
      <text class="cd-col" x={NAME_R} y={AXIS - 20} text-anchor="end">
        WORKSPACE
      </text>
      <text class="cd-ceiling-t" x={XC} y={AXIS - 14} text-anchor="middle">
        ITS CEILING
      </text>
      <text class="cd-tick" x={X0} y={AXIS - 8} text-anchor="middle">
        none used
      </text>
      <text class="cd-tick" x={XMAX} y={AXIS - 8} text-anchor="middle">
        2× and past
      </text>
      <text class="cd-col" x={645} y={AXIS - 20} text-anchor="middle">
        WOULD STOP
      </text>

      {rows.map((workspace, i) => {
        const y = rowMid(i);
        return (
          <a href={href(workspace)}>
            {i > 0 ? <line class="cd-sep" x1={20} y1={y - ROW / 2} x2={710} y2={y - ROW / 2} /> : null}
            <text class="cd-name" x={NAME_R} y={y - 3} text-anchor="end">
              {ellipsis(workspace.name, 20)}
            </text>
            <text class="cd-cohort" x={NAME_R} y={y + 10} text-anchor="end">
              {ellipsis(cohortLabel(workspace.cohort), 24)}
            </text>
            {workspace.ceilings.map((use, k) => (
              <Track use={use} y={laneY(i, k)} plan={workspace.landsOn} />
            ))}
            {workspace.features.map((loss, k) => (
              <FeatureBox loss={loss} x={FEATURE_X[k] ?? FEATURE_X[3]!} y={y} />
            ))}
          </a>
        );
      })}
    </svg>
  );
};

/** What the drawing left out, said in words rather than silently dropped. */
export const chartOverflow = (total: number): string | null => {
  const hidden = total - MAX_CHART_ROWS;
  return hidden > 0
    ? `${hidden} more workspace${hidden === 1 ? '' : 's'} in the table below, not drawn`
    : null;
};
