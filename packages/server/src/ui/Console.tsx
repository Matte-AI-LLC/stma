import type { Child } from 'hono/jsx';
import { initials } from '../lib/format';
import { EMPTY_RAIL, type RailCounts } from '../lib/rail';
import type { User } from '../types';

/**
 * The signed-in shell, from the "STMA Command console" design.
 *
 * Four ideas, and every screen uses all of them: a rail that says where you
 * are, a status strip that says what is true right now, a ledger that is the
 * record, and an inspector that carries the authority to change something.
 *
 * It replaced a top nav. The top nav was fine for five pages of forms; it could
 * not carry a console where the point is that numbers on screen are claims the
 * product is making about live machines, and you need to see all of them at
 * once — which is what the strip is for.
 *
 * Every slot is optional. A page that passes none still gets the rail and the
 * chrome, so the twenty-odd pages that were not part of the redesign did not
 * have to be rewritten to stop looking broken.
 */

export type RailKey =
  | 'agents'
  | 'projects'
  | 'savings'
  | 'governance'
  | 'delivery'
  | 'environments'
  | 'activity'
  | 'teams'
  | 'sessions'
  | 'notifications'
  | 'tokens'
  | 'account'
  | 'docs'
  | 'admin';

export interface KeyHint {
  k: string;
  label: string;
}

/**
 * The STMA mark, from the 2026-08-30 logo sheet: five agent-nodes on a pentagon
 * around a ringed hub — the space between machines, which is the product.
 *
 * Inline SVG in `currentColor`, so one geometry serves the dark rail (white)
 * and the light marketing pages (ink) via the `.logo` CSS color alone. The
 * spokes start at the hub ring's edge rather than the centre, which is what
 * lets the hub stay unfilled — the sheet's variants knock the spokes out with a
 * background-coloured fill, and this component cannot know its background.
 * Node opacities are the sheet's: presence, not decoration.
 */
export const Logo = ({ inv = false, lg = false }: { inv?: boolean; lg?: boolean }) => (
  <span class={`logo${inv ? ' inv' : ''}${lg ? ' lg' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 12.3 L16 4.5 M19.52 14.86 L26.94 12.45 M18.18 18.99 L22.76 25.3 M13.83 18.99 L9.24 25.3 M12.48 14.86 L5.06 12.45"
        fill="none"
        stroke="currentColor"
        stroke-width="0.7"
        opacity="0.45"
      />
      <circle cx="16" cy="16" r="3.7" fill="none" stroke="currentColor" stroke-width="0.75" opacity="0.9" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" />
      <circle cx="16" cy="4.5" r="1.8" fill="currentColor" opacity="0.82" />
      <circle cx="26.94" cy="12.45" r="1.9" fill="currentColor" />
      <circle cx="22.76" cy="25.3" r="1.8" fill="currentColor" opacity="0.92" />
      <circle cx="9.24" cy="25.3" r="1.7" fill="currentColor" opacity="0.65" />
      <circle cx="5.06" cy="12.45" r="1.65" fill="currentColor" opacity="0.55" />
    </svg>
  </span>
);

const NUM = (n: number): string => (n > 99 ? '99+' : String(n));

const RailLink = ({
  href,
  label,
  active,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  badge?: number;
}) => (
  <a class={`rail-link${active ? ' active' : ''}`} href={href}>
    {label}
    {badge && badge > 0 ? <span class="rail-badge">{NUM(badge)}</span> : null}
  </a>
);

/** Team-scoped destinations need a team; without one they go to the picker. */
const teamHref = (team: string | null, suffix: string): string =>
  team ? `/app/teams/${team}${suffix}` : '/app';

/** Two letters for a team tile, the same shorthand the team pages use. */
const teamInitials = (name: string): string =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/**
 * Which team the rail is talking about, and the way to another one.
 *
 * The rail's links are team-scoped, so before this the only way to read which
 * team you were looking at was the line above the sign-out button — and the only
 * way to change it was to go to the team list and come back. It is a `details`
 * element rather than a scripted menu because the console must work with no
 * script at all; the same reason the project scope filter keeps its View button.
 *
 * With one team there is nothing to switch to, so it renders as a plain label:
 * a control that cannot do anything is worse than no control.
 */
const TeamSwitch = ({ rail }: { rail: RailCounts }) => {
  if (!rail.team) return null;
  const current = rail.list.find((t) => t.slug === rail.team);
  const name = current?.name ?? rail.team;
  const face = (
    <>
      <span class="tile tile-28 tile-green" style="width:22px;height:22px;font-size:9px">
        {teamInitials(name)}
      </span>
      <span class="tname">{name}</span>
    </>
  );
  if (rail.list.length < 2) {
    return (
      <a class="teamswitch" href={`/app/teams/${rail.team}`} title="This team">
        {face}
      </a>
    );
  }
  return (
    <details class="teampick">
      <summary class="teamswitch" title="Switch team">
        {face}
        <span class="caret">▾</span>
      </summary>
      <div class="teammenu">
        {rail.list.map((t) => (
          <a class={t.slug === rail.team ? 'on' : undefined} href={`/app/teams/${t.slug}`}>
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {t.name}
            </span>
            <span class="r">{t.role}</span>
          </a>
        ))}
        <span class="sep"></span>
        <a href="/app">All teams</a>
      </div>
    </details>
  );
};

export const Rail = ({ user, active }: { user: User; active?: RailKey }) => {
  const rail = user.rail ?? EMPTY_RAIL;
  return (
    <nav class="rail">
      <a class="rail-brand" href="/app">
        <Logo inv />
        <span class="name">STMA</span>
      </a>
      <TeamSwitch rail={rail} />
      <div class="rail-nav">
        <span class="rail-group">Control</span>
        <RailLink href="/app/agents" label="Agent map" active={active === 'agents'} badge={rail.runs} />
        <RailLink
          href={teamHref(rail.team, '/projects')}
          label="Projects"
          active={active === 'projects'}
          badge={rail.projects}
        />
        <RailLink
          href={teamHref(rail.team, '/governance')}
          label="Governance"
          active={active === 'governance'}
          badge={rail.drift}
        />
        <RailLink
          href={teamHref(rail.team, '/delivery')}
          label="Delivery"
          active={active === 'delivery'}
        />
        <RailLink
          href={teamHref(rail.team, '/savings')}
          label="Savings"
          active={active === 'savings'}
        />
        <RailLink
          href={teamHref(rail.team, '/compare')}
          label="Environments"
          active={active === 'environments'}
        />
        <RailLink
          href={teamHref(rail.team, '/activity')}
          label="Activity"
          active={active === 'activity'}
        />

        <span class="rail-group later">Workspace</span>
        <RailLink href="/app" label="Teams" active={active === 'teams'} badge={rail.teams > 1 ? rail.teams : undefined} />
        <RailLink href="/app/sessions" label="Sessions" active={active === 'sessions'} badge={rail.sessions} />
        <RailLink
          href="/app/notifications"
          label="Notifications"
          active={active === 'notifications'}
        />
        <RailLink href="/app/tokens" label="Tokens" active={active === 'tokens'} />
        <RailLink href="/docs" label="Docs" active={active === 'docs'} />
        {user.isAdmin ? (
          <>
            <span class="rail-group later">Operator</span>
            <RailLink href="/admin" label="Admin" active={active === 'admin'} />
          </>
        ) : null}
      </div>
      <div class="rail-foot">
        {/* Your own name is the way to your own settings: the rail has no Account
            entry because an account is not a place the fleet lives. */}
        <a class="railme" href="/app/account" title="Account">
          <span class="avatar">{initials(user.username)}</span>
          <div class="rail-who">
            <div class="n">{user.username}</div>
            <div class="r">
              {rail.role ? `${rail.role} · ` : ''}
              {rail.team ?? 'no team yet'}
            </div>
          </div>
        </a>
        <form method="post" action="/logout" class="m0">
          <button class="rail-out" type="submit" title="Sign out">
            out
          </button>
        </form>
      </div>
    </nav>
  );
};

/**
 * The strip's project filter: global by default, one project when chosen.
 *
 * A GET form rather than links because a team can hold fifty projects and the
 * strip is one row. It submits on change (client.ts) and keeps a real View
 * button, so the filter works with scripting off; the selection lives in the
 * URL, so — like the agent map's `?run=` — it survives a refresh and can be
 * pasted to a teammate.
 */
export const ProjectScope = ({
  path,
  projects,
  current,
  allLabel = 'All projects',
  extra,
}: {
  path: string;
  projects: { name: string }[];
  current: string | null;
  /** What the empty choice means on this page — "Global — whole team" on governance. */
  allLabel?: string;
  /** Other query params this page is holding (e.g. tabs), carried through the submit. */
  extra?: Record<string, string>;
}) => (
  <form method="get" action={path} class="scopeform" data-autosubmit="t">
    {extra
      ? Object.entries(extra).map(([k, v]) => <input type="hidden" name={k} value={v} />)
      : null}
    <select name="project" aria-label="Project scope">
      <option value="">{allLabel}</option>
      {projects.map((p) => (
        <option value={p.name} selected={p.name === current}>
          {p.name}
        </option>
      ))}
    </select>
    <button class="btn btn-sm" type="submit">
      View
    </button>
  </form>
);

/** Left cluster of the status strip: the headline claim, then the counts. */
export const Lead = ({ text, live = true }: { text: string; live?: boolean }) => (
  <span class="lead" style={live ? undefined : 'color:var(--mut)'}>
    <span class={`dot${live ? '' : ' gray'}`}></span>
    {text}
  </span>
);

export const Vr = () => <span class="vr"></span>;

/**
 * Page header. The crumb is the only place a signed-in page says which team it
 * is about, now that the rail took the horizontal space the old nav used.
 */
export const PageHead = ({
  crumb,
  title,
  sub,
  actions,
}: {
  crumb?: string;
  title: string;
  sub?: string;
  actions?: Child;
}) => (
  <div class="pagehead">
    <div style="min-width:0">
      {crumb ? <span class="crumb">{crumb}</span> : null}
      <h1>{title}</h1>
      {sub ? <p>{sub}</p> : null}
    </div>
    {actions ? <div class="headacts">{actions}</div> : null}
  </div>
);

/** The one thing on this page that is wrong right now, with what to do about it. */
export const Band = ({
  kind,
  tag,
  children,
  actions,
}: {
  kind: 'danger' | 'warn' | 'info';
  tag: string;
  children: Child;
  actions?: Child;
}) => (
  <div class={`band2 band-${kind}`}>
    <span class="tag">{tag}</span>
    <span style="min-width:0">{children}</span>
    {actions ? <div class="acts">{actions}</div> : null}
  </div>
);

/** Right panel: what you can do to the thing selected in the ledger. */
export const Inspector = ({ children }: { children: Child }) => (
  <aside class="inspector">{children}</aside>
);

export const InspectorEmpty = ({ text }: { text: string }) => (
  <aside class="inspector">
    <div class="ins-empty">{text}</div>
  </aside>
);

/**
 * One labelled form field, with whether it is required said out loud.
 *
 * Both states carry a mark rather than only one: "unmarked means optional" is a
 * convention every form believes it has taught the reader and no reader has
 * learned, and the cost of guessing wrong is a rejected submit that throws the
 * typing away. The label is a real `for`/`id` pair, so the accessible name is
 * the label rather than the placeholder.
 */
export const Field = ({
  id,
  label,
  required,
  help,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  children: Child;
}) => (
  <div class="field">
    <label for={id}>
      {/* The space is load-bearing: without it the accessible name computes as
          "Team namerequired", which is what a screen reader then says. */}
      {label}{' '}
      <span class={`fmark ${required ? 'fmark-req' : 'fmark-opt'}`}>
        {required ? 'required' : 'optional'}
      </span>
    </label>
    {children}
    {/* Call sites point their control at this with aria-describedby={`${id}-help`},
        so the guidance is announced rather than only seen. */}
    {help ? (
      <span class="help" id={`${id}-help`}>
        {help}
      </span>
    ) : null}
  </div>
);

const Keys = ({ hints, note }: { hints: KeyHint[]; note?: string }) => (
  <div class="keys">
    {hints.map((hint) => (
      <span>
        <b>{hint.k}</b> {hint.label}
      </span>
    ))}
    {note ? <span class="note">{note}</span> : null}
  </div>
);

export interface ConsoleProps {
  user: User;
  active?: RailKey;
  title?: string;
  /** Left cluster of the status strip — the page's claim about right now. */
  strip?: Child;
  /** Right cluster: scope pickers, search. */
  scope?: Child;
  /** Full-bleed header; omit and render your own content instead. */
  head?: Child;
  band?: Child;
  inspector?: Child;
  keys?: KeyHint[];
  keysNote?: string;
  /**
   * Pages designed for the console lay out their own full-bleed sections; the
   * rest keep the padded column they were written for.
   */
  bleed?: boolean;
  children?: Child;
}

export const ConsoleShell = ({
  user,
  active,
  strip,
  scope,
  head,
  band,
  inspector,
  keys,
  keysNote,
  bleed,
  children,
}: ConsoleProps) => (
  <div class="console">
    <Rail user={user} active={active} />
    <div class="frame">
      {strip || scope ? (
        <div class="strip">
          <div class="strip-l">{strip}</div>
          <div class="strip-r">{scope}</div>
        </div>
      ) : null}
      {head}
      {band}
      <div class="cbody">
        <main class="cmain">{bleed ? children : <div class="cpad">{children}</div>}</main>
        {inspector}
      </div>
      {keys && keys.length > 0 ? <Keys hints={keys} note={keysNote} /> : null}
    </div>
  </div>
);
