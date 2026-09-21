import type { Child } from 'hono/jsx';
import { initials } from '../lib/format';
import { EMPTY_RAIL, type RailCounts } from '../lib/rail';
import { sectionHref } from '../lib/scope';
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
  | 'people'
  | 'work'
  | 'members'
  | 'integrations'
  | 'setup'
  | 'team'
  | 'agents'
  | 'projects'
  | 'knowledge'
  | 'savings'
  | 'governance'
  | 'delivery'
  | 'attention'
  | 'repositories'
  | 'receipts'
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
      <circle
        cx="16"
        cy="16"
        r="3.7"
        fill="none"
        stroke="currentColor"
        stroke-width="0.75"
        opacity="0.9"
      />
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
 * The scope bar: which workspace the page is in, which project inside it, and the
 * way to another. Two scopes below the account and no third — the cloud consoles'
 * shape, asked for by the owner on 2026-09-20 because the rail mixed scope with
 * function and nobody could tell a workspace page from a project page.
 *
 * Pickers are `details` elements, not scripted menus: the console must work with
 * no script at all. With nowhere to switch to, a picker is a plain link — a
 * control that cannot do anything is worse than no control.
 */
export const ScopeBar = ({ user }: { user: User }) => {
  const rail = user.rail ?? EMPTY_RAIL;
  const current = rail.list.find((t) => t.slug === rail.team);
  const workspace = current?.name ?? rail.team;
  const inWorkspace = rail.scope !== 'account' && Boolean(rail.team);
  return (
    <div class="scopebar">
      <nav class="scope-path" aria-label="Scope">
        {inWorkspace ? (
          <>
            {rail.list.length < 2 && !user.organizationSecurity ? (
              <a class="scope-at" href={`/app/teams/${rail.team}`} title="This workspace">
                {workspace}
              </a>
            ) : (
              <details class="scope-pick">
                <summary class="scope-at" title="Switch workspace">
                  {workspace}
                  <span class="caret">▾</span>
                </summary>
                <div class="scope-menu">
                  <span class="scope-cap">Workspaces</span>
                  {rail.list.map((t) => (
                    <a class={t.slug === rail.team ? 'on' : undefined} href={`/app/teams/${t.slug}`}>
                      <span class="grow">{t.name}</span>
                      <span class="r">{t.role}</span>
                    </a>
                  ))}
                  <span class="sep"></span>
                  <a href="/app">All workspaces</a>
                  {user.organizationSecurity ? <a href="/app/organizations">Organizations</a> : null}
                </div>
              </details>
            )}
            <span class="scope-sep">/</span>
            <details class="scope-pick">
              <summary class={`scope-at${rail.project ? ' in' : ' all'}`} title="Switch project">
                {rail.project?.name ?? 'All projects'}
                <span class="caret">▾</span>
              </summary>
              <div class="scope-menu">
                <span class="scope-cap">Projects in {workspace}</span>
                <a class={rail.project ? undefined : 'on'} href={`/app/teams/${rail.team}`}>
                  All projects
                </a>
                {rail.projectList.map((p) => (
                  <a
                    class={p.slug === rail.project?.slug ? 'on' : undefined}
                    href={`/app/teams/${rail.team}/projects/${encodeURIComponent(p.slug)}`}
                  >
                    <span class="grow">{p.name}</span>
                  </a>
                ))}
                <span class="sep"></span>
                <a href={`/app/teams/${rail.team}/projects`}>
                  Every project{rail.projects > rail.projectList.length ? ` (${rail.projects})` : ''}
                </a>
              </div>
            </details>
          </>
        ) : rail.list.length === 0 && !user.organizationSecurity ? (
          <a class="scope-at all" href="/app">
            All workspaces
          </a>
        ) : (
          <details class="scope-pick">
            <summary class="scope-at all" title="Open a workspace">
              All workspaces
              <span class="caret">▾</span>
            </summary>
            <div class="scope-menu">
              <span class="scope-cap">Workspaces</span>
              {rail.list.map((t) => (
                <a href={`/app/teams/${t.slug}`}>
                  <span class="grow">{t.name}</span>
                  <span class="r">{t.role}</span>
                </a>
              ))}
              <span class="sep"></span>
              <a class="on" href="/app">
                All workspaces
              </a>
              {user.organizationSecurity ? <a href="/app/organizations">Organizations</a> : null}
            </div>
          </details>
        )}
      </nav>
      {/* The account is a scope too, the outermost one, and it is not a place the
          fleet lives: its pages sit behind the name, not in the rail. */}
      <details class="scope-pick scope-me">
        <summary class="scope-at" title="Your account">
          <span class="avatar light">{initials(user.username)}</span>
          {user.username}
          <span class="caret">▾</span>
        </summary>
        <div class="scope-menu right">
          <a href="/app/account">Account</a>
          <a href="/app/notifications">Notifications</a>
          <a href="/app/tokens">My agent connections</a>
          <a href="/docs">Docs</a>
          {/* Beside Docs rather than in the rail: the rail lists the current
              scope's sections, and "what went wrong" belongs to no scope. */}
          <a href="/help">Help</a>
          <span class="sep"></span>
          <form method="post" action="/logout" class="m0">
            <button class="scope-out" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </details>
    </div>
  );
};

/** `?team=…&project=…` for the list pages that live outside a workspace path. */
const scopeQuery = (team: string, project?: string | null): string =>
  `?team=${encodeURIComponent(team)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;

/**
 * The rail lists the sections of the scope the page is in, and nothing else.
 *
 * It used to list three groups — "Current workspace", "Manage workspace",
 * "Across workspaces" — that mixed where you are with what you can do: the agent
 * map and the sessions list sat outside every workspace and poured all of them
 * into one ledger, agent connections hid under personal settings, and a project
 * had no sections at all, so everything about it was reached by leaving it.
 * Inside a project the rail is that project's; the way out is its first line.
 */
export const Rail = ({ user, active }: { user: User; active?: RailKey }) => {
  const rail = user.rail ?? EMPTY_RAIL;
  const ws = rail.scope === 'account' ? null : rail.team;
  const project = rail.project;
  const owner = rail.role === 'owner';
  return (
    <nav class="rail">
      <a class="rail-brand" href="/app">
        <Logo inv />
        <span class="name">STMA</span>
      </a>
      <button
        class="rail-nav-toggle"
        type="button"
        aria-expanded="true"
        aria-controls="rail-destinations"
      >
        Menu
      </button>
      <div class="rail-nav" id="rail-destinations">
        {ws && project ? (
          <>
            <a class="rail-link rail-up" href={teamHref(ws, '/projects')}>
              ← {rail.list.find((t) => t.slug === ws)?.name ?? ws}
            </a>
            <span class="rail-group">{project.name}</span>
            <RailLink
              href={teamHref(ws, `/projects/${encodeURIComponent(project.slug)}`)}
              label="Overview"
              active={active === 'projects'}
            />
            {/* Every one of these is the project's own address: the person who
                clicked into a project ends up with the hierarchy in the URL bar,
                not with a filter on a workspace page. `sectionHref` owns both
                spellings, so the rail cannot drift from the routes. */}
            <RailLink
              href={sectionHref(ws, project.slug, 'agents')}
              label="Agents"
              active={active === 'agents' || active === 'tokens'}
              badge={rail.runs}
            />
            <RailLink href={sectionHref(ws, project.slug, 'work')} label="Work" active={active === 'work'} />
            <RailLink
              href={sectionHref(ws, project.slug, 'sessions')}
              label="Sessions"
              active={active === 'sessions'}
              badge={rail.sessions}
            />
            <RailLink
              href={sectionHref(ws, project.slug, 'activity')}
              label="Activity"
              active={active === 'activity'}
            />
            {/* A baseline is an observation of a machine, not a rule somebody
                published: `activeBaselines` joins `projects` on a NOT NULL
                column, so there is no workspace-wide baseline and nothing
                inherits. It belongs with what is happening, not with the three
                documents a project can add to or replace. */}
            <RailLink
              href={sectionHref(ws, project.slug, 'environments')}
              label="Environments"
              active={active === 'environments'}
            />
            <span class="rail-group later">Rules in effect here</span>
            <RailLink
              href={sectionHref(ws, project.slug, 'knowledge')}
              label="Knowledge"
              active={active === 'knowledge'}
            />
            <RailLink
              href={sectionHref(ws, project.slug, 'governance')}
              label="Governance"
              active={active === 'governance'}
            />
            <RailLink
              href={sectionHref(ws, project.slug, 'delivery')}
              label="Delivery"
              active={active === 'delivery'}
            />
          </>
        ) : ws ? (
          <>
            {/* Two groups, not one list of nine: a place and what is
                happening in it. The project rail has the same split and reads
                because it is shorter, which is a reason to name the split
                rather than to rely on the length. */}
            <span class="rail-group">Workspace</span>
            <RailLink href={teamHref(ws, '')} label="Overview" active={active === 'team'} />
            <RailLink
              href={teamHref(ws, '/projects')}
              label="Projects"
              active={active === 'projects'}
              badge={rail.projects}
            />
            <RailLink href={sectionHref(ws, null, 'agents')} label="People and agents" active={active === 'people'} />
            <span class="rail-group later">What is happening</span>
            <RailLink
              href={`/app/agents${scopeQuery(ws)}`}
              label="Agent map"
              active={active === 'agents'}
              badge={rail.runs}
            />
            <RailLink href={sectionHref(ws, null, 'work')} label="Work" active={active === 'work'} />
            <RailLink
              href={sectionHref(ws, null, 'sessions')}
              label="Sessions"
              active={active === 'sessions'}
              badge={rail.sessions}
            />
            <RailLink href={sectionHref(ws, null, 'activity')} label="Activity" active={active === 'activity'} />
            <RailLink
              href={sectionHref(ws, null, 'environments')}
              label="Environments"
              active={active === 'environments'}
            />
            <RailLink
              href={teamHref(ws, '/attention')}
              label="Needs attention"
              active={active === 'attention'}
            />
            {/* Set here, in effect there. All three are scoped: a project adds
                to Governance, addresses Knowledge to itself, and can replace the
                Delivery flow outright. "for every project" said the opposite of
                what the console does, which is the one thing a rail label must
                not do. */}
            <span class="rail-group later">Rules set here</span>
            <RailLink href={sectionHref(ws, null, 'knowledge')} label="Knowledge" active={active === 'knowledge'} />
            <RailLink
              href={sectionHref(ws, null, 'governance')}
              label="Governance"
              active={active === 'governance'}
              badge={rail.drift}
            />
            <RailLink
              href={sectionHref(ws, null, 'delivery')}
              label="Delivery"
              active={active === 'delivery' || active === 'receipts'}
            />
            <span class="rail-group later">Workspace settings</span>
            <RailLink href={teamHref(ws, '?tab=people')} label="Members" active={active === 'members'} />
            {owner ? (
              <RailLink
                href={teamHref(ws, '?tab=integrations')}
                label="Integrations"
                active={active === 'integrations'}
              />
            ) : null}
            <RailLink
              href={teamHref(ws, '/repositories')}
              label="Repositories"
              active={active === 'repositories'}
            />
            <RailLink
              href={`/app/tokens${scopeQuery(ws)}`}
              label="Agent connections"
              active={active === 'tokens'}
            />
            <RailLink href={teamHref(ws, '/setup')} label="Connect & test" active={active === 'setup'} />
          </>
        ) : (
          <>
            <span class="rail-group">Workspaces</span>
            <RailLink
              href="/app"
              label="All workspaces"
              // The unscoped map, work and sessions lists left the rail (phase 4) but still
              // answer their addresses. They are the account-level view of everything, and a
              // page that lights nothing in the rail reads as a page that is lost.
              active={active === 'teams' || active === 'agents' || active === 'work' || active === 'sessions'}
              badge={rail.teams > 1 ? rail.teams : undefined}
            />
            {rail.list.map((t) => (
              <RailLink href={`/app/teams/${t.slug}`} label={t.name} active={false} />
            ))}
            <span class="rail-group later">Account</span>
            <RailLink href="/app/account" label="Account" active={active === 'account'} />
            <RailLink
              href="/app/notifications"
              label="Notifications"
              active={active === 'notifications'}
            />
            <RailLink href="/app/tokens" label="My agent connections" active={active === 'tokens'} />
          </>
        )}
        <span class="rail-group later">Help</span>
        <RailLink href="/docs" label="Docs" active={active === 'docs'} />
        {user.isAdmin ? (
          <>
            <span class="rail-group later">Operator</span>
            <RailLink href="/admin" label="Admin" active={active === 'admin'} />
          </>
        ) : null}
      </div>
      <div class="rail-foot">
        {/* Your own name is the way to your own settings: an account is not a
            place the fleet lives. The role under it is where you check your own
            authority in the workspace on screen. */}
        <a class="railme" href="/app/account" title="Account">
          <span class="avatar">{initials(user.username)}</span>
          <div class="rail-who">
            <div class="n">{user.username}</div>
            <div class="r">
              {rail.scope === 'account'
                ? rail.teams > 0
                  ? `${rail.teams} workspace${rail.teams === 1 ? '' : 's'}`
                  : 'no workspace yet'
                : `${rail.role ? `${rail.role} · ` : ''}${rail.team ?? 'no workspace yet'}`}
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
  projects: { id: string; name: string; slug: string; repositoryIdentity?: string | null }[];
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
        <option value={p.id} selected={p.id === current}>
          {p.name}
          {projects.some((other) => other.id !== p.id && other.name === p.name)
            ? ` — ${p.repositoryIdentity ? 'repository-bound' : p.slug}`
            : ''}
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

/** One step of the way to a page. The last one is the page itself and carries no link. */
export type Crumb = { label: string; href?: string };

/** The way to a workspace page, for the common case: workspace, then the steps below it. */
export const teamTrail = (team: { slug: string; name?: string | null }, ...rest: Crumb[]): Crumb[] => [
  { label: team.name ?? team.slug, href: `/app/teams/${team.slug}` },
  ...rest,
];

/** The linked steps on their own, for a page that draws its own title block. */
export const Trail = ({ steps }: { steps: Crumb[] }) => (
  <nav class="crumb" aria-label="Breadcrumb">
    {steps.map((step, index) => (
      <>
        {index > 0 ? <span class="crumb-sep"> / </span> : null}
        {step.href && index < steps.length - 1 ? (
          <a href={step.href}>{step.label}</a>
        ) : (
          <span aria-current={index === steps.length - 1 ? 'page' : undefined}>{step.label}</span>
        )}
      </>
    ))}
  </nav>
);

/** The trail of a list page that takes `?team=` and `?project=`: the scope first, then the page. */
export const scopedTrail = (
  scope: { team?: { slug: string; name?: string | null }; project?: { slug: string; name: string } | null },
  page: string,
  all: Crumb = { label: 'All workspaces', href: '/app' },
): Crumb[] =>
  scope.team && scope.project
    ? teamTrail(
        scope.team,
        { label: 'Projects', href: `/app/teams/${scope.team.slug}/projects` },
        { label: scope.project.name, href: `/app/teams/${scope.team.slug}/projects/${encodeURIComponent(scope.project.slug)}` },
        { label: page },
      )
    : scope.team
      ? teamTrail(scope.team, { label: page })
      : [all, { label: page }];

/**
 * Page header. The trail says where this page sits and every step of it is a way
 * back: it used to be a line of text ("/ across workspaces / agent map") that
 * named the places and led to none of them. `crumb` stays for a page that has
 * no place in the hierarchy to link to.
 */
export const PageHead = ({
  crumb,
  trail,
  title,
  sub,
  actions,
}: {
  crumb?: string;
  trail?: Crumb[];
  title: string;
  sub?: string;
  actions?: Child;
}) => (
  <div class="pagehead">
    <div style="min-width:0">
      {trail && trail.length > 0 ? (
        <Trail steps={trail} />
      ) : crumb ? (
        <span class="crumb">{crumb}</span>
      ) : null}
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
      <ScopeBar user={user} />
      {/*
       * Above the page's own band, because it is about the account rather than
       * about this page, and because the page below it may be a redirect target
       * whose band is already spoken for. It is not dismissible: the state it
       * names ends when somebody enters a code, and a notice you can wave away
       * is one that stops being read the day it starts mattering.
       */}
      {user.addressUnconfirmed ? (
        <Band
          kind="warn"
          tag="Email"
          actions={
            <a class="btn btn-sm" href="/app/account">
              Confirm it
            </a>
          }
        >
          <b>{user.email}</b> has not been confirmed. Sign-in codes and password resets go there and
          nowhere else, so if it is wrong, nobody can get this account back.
        </Band>
      ) : null}
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
