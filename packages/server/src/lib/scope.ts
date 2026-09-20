import type { Context } from 'hono';
import type { AppEnv } from '../types';

/**
 * The address of a console section, in both of its forms.
 *
 * A project's sections used to open as a filter on a workspace page
 * (`/app/teams/acme/governance?project=payments-api`). The console draws three
 * scopes and a scope bar; the address said two, and the one it left out was the
 * one a person had just clicked into. `/app/teams/acme/projects/payments-api/
 * governance` is what normal navigation produces now — rule 5 of the plan's
 * navigation contract, "the address carries the hierarchy".
 *
 * The filter form is not retired: it is in browser tabs, in messages, and in a
 * few hundred tests, and it answers exactly as it did. So every section has two
 * spellings, and this table is the one place that knows both — the rail, the
 * trails and each page's own links read it rather than writing paths by hand,
 * which is how the two halves stay in step when a section moves.
 *
 * Two workspace forms deliberately live outside `/app/teams/`: the work ledger
 * and the sessions list answer for the account as well, where there is no
 * workspace in the address to hang them under.
 *
 * One rule follows from HTML rather than from taste, and every page states it
 * where it applies: a GET form that *picks* a project submits to the workspace
 * form. A form can only write a query string, and these pickers carry project
 * ids because two projects may share a display name — so `?project=<id>` is the
 * only spelling they can produce. Links carry the path form; forms cannot.
 */
export type SectionKey =
  | 'agents'
  | 'work'
  | 'sessions'
  | 'activity'
  | 'knowledge'
  | 'governance'
  | 'delivery'
  | 'environments';

const WORKSPACE_FORM: Record<SectionKey, (team: string) => string> = {
  // "People and agents" across the workspace; inside a project, that project's roster.
  agents: (team) => `/app/teams/${team}/agents`,
  work: (team) => `/app/handoffs?team=${encodeURIComponent(team)}`,
  sessions: (team) => `/app/sessions?team=${encodeURIComponent(team)}`,
  activity: (team) => `/app/teams/${team}/activity`,
  knowledge: (team) => `/app/teams/${team}/knowledge`,
  governance: (team) => `/app/teams/${team}/governance`,
  delivery: (team) => `/app/teams/${team}/delivery`,
  // Everywhere a person reads it the page is called Environments; its workspace
  // address has been /compare since it was one diff of two machines, and moving
  // it would break every link that already points there.
  environments: (team) => `/app/teams/${team}/compare`,
};

/** Where a section lives: under the project when there is one, else in the workspace. */
export const sectionHref = (
  team: string,
  project: string | null | undefined,
  key: SectionKey,
): string =>
  project
    ? `/app/teams/${team}/projects/${encodeURIComponent(project)}/${key}`
    : WORKSPACE_FORM[key](team);

/**
 * The project this page is scoped to, spelled as the address spells it.
 *
 * The path wins. Inside `/projects/<project>/…` the project is part of the
 * page's identity, and a `?project=` on top of that would be a filter arguing
 * with an address — the alternative, letting the query override, would make the
 * path a claim the page does not honour.
 */
export const scopedProjectParam = (c: Context<AppEnv>): string =>
  c.req.param('project') ?? (c.req.query('project') ?? '').trim();

/**
 * True when the project is part of the address rather than a filter on it.
 *
 * A page needs this to keep its own links where the reader is: filters, paging
 * and tabs of a page opened under the project belong under the project.
 */
export const projectInPath = (c: Context<AppEnv>): boolean =>
  c.req.param('project') !== undefined;

/** The workspace this page is scoped to: named in its path, or carried as a filter. */
export const scopedTeamParam = (c: Context<AppEnv>): string =>
  c.req.param('slug') ?? (c.req.query('team') ?? '').trim();

/**
 * The person a list is narrowed to.
 *
 * A filter, never an address: account, workspace and project are the three
 * scopes the console draws, and a person is somebody who worked inside one of
 * them. So it stays a query parameter on the section's own address rather than
 * becoming a ninth `SectionKey` — `/app/teams/acme/people/dana` is the page
 * about Dana, and this is the sessions list with Dana's name written on it.
 *
 * It only means anything inside a workspace, because the name it carries is a
 * membership; the page that reads it says so by answering 404 without one.
 */
export const scopedPersonParam = (c: Context<AppEnv>): string =>
  (c.req.query('person') ?? '').trim();

/**
 * The sessions list narrowed to one person, in whichever scope the reader is in.
 *
 * Here rather than written out at each call site for the same reason
 * `sectionHref` exists: the link on a person's page and the page that answers
 * it must agree about the spelling, and the workspace form already carries a
 * query string of its own, which is the detail a hand-written `?person=` gets
 * wrong exactly once.
 */
export const personSessionsHref = (
  team: string,
  project: string | null | undefined,
  username: string,
): string => {
  const base = sectionHref(team, project, 'sessions');
  return `${base}${base.includes('?') ? '&' : '?'}person=${encodeURIComponent(username)}`;
};
