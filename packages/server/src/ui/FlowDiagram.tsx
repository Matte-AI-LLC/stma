import type { DeliveryFlow } from '@bridge/shared';

/**
 * The delivery flow as a picture: one horizontal chain from "work starts" to
 * the last environment. Same idiom as ui/Diagram — inline SVG, literal
 * geometry, colours from the design-system classes — because the whole point
 * of a flow the team designed is that a person can glance at it.
 *
 * Width grows with the flow and the container scrolls (`scroll-x`); wrapping
 * the chain would draw a route, and this is a straight road on purpose.
 */

const NODE = { w: 148, h: 64, gap: 46, y: 26 };
const H = 128;

interface Node {
  title: string;
  sub: string;
  kind: 'step' | 'env' | 'gate';
  badge?: string;
}

const TRIGGER_SHORT: Record<string, string> = {
  merge: 'auto on merge',
  tag: 'on version tag',
  manual: 'manual deploy',
};

function nodesFor(flow: DeliveryFlow): Node[] {
  const nodes: Node[] = [];
  if (flow.ticket.system !== 'none') {
    nodes.push({
      title: 'Ticket',
      sub: flow.ticket.keyPattern || flow.ticket.system,
      kind: 'step',
      badge: flow.ticket.required ? 'required' : undefined,
    });
  }
  nodes.push({ title: 'Branch', sub: flow.branch.pattern, kind: 'step' });
  nodes.push({
    title: 'Pull request',
    sub: `${flow.checks.length} check${flow.checks.length === 1 ? '' : 's'} · ${flow.review.approvals} approval${flow.review.approvals === 1 ? '' : 's'}`,
    kind: 'gate',
  });
  nodes.push({ title: `Merge (${flow.mergeStrategy})`, sub: `into ${flow.branch.from}`, kind: 'step' });
  for (const env of flow.environments) {
    nodes.push({
      title: env.name,
      sub: TRIGGER_SHORT[env.deployOn] ?? env.deployOn,
      kind: 'env',
      badge: env.approval ? 'sign-off' : undefined,
    });
  }
  return nodes;
}

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const FlowDiagram = ({ flow }: { flow: DeliveryFlow }) => {
  const nodes = nodesFor(flow);
  const width = nodes.length * NODE.w + (nodes.length - 1) * NODE.gap + 8;
  return (
    <div class="scroll-x">
      <svg
        class="flowdg"
        viewBox={`0 0 ${width} ${H}`}
        style={`min-width:${Math.min(width, 980)}px`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={`Delivery flow: ${nodes.map((n) => n.title).join(', then ')}`}
      >
        {nodes.map((node, i) => {
          const x = 4 + i * (NODE.w + NODE.gap);
          return (
            <>
              {i > 0 ? (
                <>
                  <line
                    class="fd-arrow"
                    x1={x - NODE.gap + 4}
                    y1={NODE.y + NODE.h / 2}
                    x2={x - 10}
                    y2={NODE.y + NODE.h / 2}
                  />
                  <path
                    class="fd-arrowhead"
                    d={`M ${x - 10} ${NODE.y + NODE.h / 2 - 4} L ${x - 3} ${NODE.y + NODE.h / 2} L ${x - 10} ${NODE.y + NODE.h / 2 + 4} Z`}
                  />
                </>
              ) : null}
              <rect class={`fd-node fd-${node.kind}`} x={x} y={NODE.y} width={NODE.w} height={NODE.h} rx={7} />
              <text class="fd-title" x={x + NODE.w / 2} y={NODE.y + 27} text-anchor="middle">
                {clip(node.title, 20)}
              </text>
              <text class="fd-sub" x={x + NODE.w / 2} y={NODE.y + 45} text-anchor="middle">
                {clip(node.sub, 24)}
              </text>
              {node.badge ? (
                <>
                  <rect
                    class="fd-badge"
                    x={x + NODE.w / 2 - 32}
                    y={NODE.y + NODE.h - 9}
                    width={64}
                    height={18}
                    rx={9}
                  />
                  <text
                    class="fd-badge-t"
                    x={x + NODE.w / 2}
                    y={NODE.y + NODE.h + 4}
                    text-anchor="middle"
                  >
                    {node.badge}
                  </text>
                </>
              ) : null}
            </>
          );
        })}
      </svg>
    </div>
  );
};
