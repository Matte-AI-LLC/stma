import type { Env } from '../env';
import type { Db } from '../db';
import { getClickupTask, listClickupTasks, parseClickupTaskRef } from '../lib/clickup';
import { getIssue, listOpenIssues, parseIssueRef } from '../lib/github';
import { getJiraIssue } from '../lib/jira';
import { clickupForTeam, githubForTeam, jiraForTeam } from './integrations';

export const TRACKERS = ['jira', 'github', 'clickup'] as const;
export type Tracker = (typeof TRACKERS)[number];

export interface NamedTicket {
  tracker: Tracker;
  /** The tracker's own identifier — what a person says out loud about this work. */
  key: string;
  /**
   * The durable form the task key takes, so the tracker can be found again from
   * a run months later.
   *
   * For GitHub and Jira it is the key itself. For ClickUp it is
   * `clickup:<native id>`, which is what `start_run {"clickup_task": …}` has
   * always written, and the difference is not cosmetic: `commentOnRunTracker`
   * routes to ClickUp on that prefix and on nothing else, because
   * `parseClickupTaskRef` would otherwise accept any word at all. Without it an
   * assignment made from a picked ClickUp ticket produced a run whose finish
   * commented nowhere — the one path where the lead had *proved* which tracker
   * they meant was the one that forgot.
   */
  reference: string;
  summary: string;
  status: string;
  url: string;
}

export const TRACKER_NAMES: Record<Tracker, string> = {
  jira: 'Jira',
  github: 'GitHub',
  clickup: 'ClickUp',
};

/**
 * The connections a ticket can be read through here.
 *
 * The project's own binding first, the workspace's single connection second.
 * A repository bound to another project is not this project's, but a workspace
 * with exactly one GitHub connection and no bindings at all is unambiguous, and
 * refusing `#42` there would be pedantry: `integrationFor` already answers
 * nothing when two connections could both be meant, so the fallback can never
 * pick somebody else's repository out of several. Jira is a site rather than a
 * repository and has no project binding to prefer.
 *
 * One reader, so the form cannot offer a tracker the handler will not use.
 */
async function trackerConnections(db: Db, teamId: string, projectId: string | null) {
  const [jira, github, githubTeamWide, clickup, clickupTeamWide] = await Promise.all([
    jiraForTeam(db, teamId),
    githubForTeam(db, teamId, projectId),
    githubForTeam(db, teamId),
    clickupForTeam(db, teamId, projectId),
    clickupForTeam(db, teamId),
  ]);
  return { jira, github: github ?? githubTeamWide, clickup: clickup ?? clickupTeamWide };
}

/**
 * Which trackers this project can read a ticket from right now.
 *
 * Asked so a form can offer what exists rather than a field that will refuse
 * whatever is typed into it, and so its help text names the shapes that will
 * actually work here.
 */
export async function trackersFor(
  db: Db,
  teamId: string,
  projectId: string | null,
): Promise<Tracker[]> {
  const found = await trackerConnections(db, teamId, projectId);
  return TRACKERS.filter((tracker) => found[tracker]);
}

/**
 * Which tracker a person meant, decided by what they typed.
 *
 * Shape first, connection second, so the refusal can say *this is a Jira key
 * and no Jira site is connected* rather than the useless *that is not a
 * ticket*. GitHub is recognised first because its forms carry a `#` or a
 * github.com URL and cannot be read as anything else; a Jira key is the next
 * unmistakable shape. ClickUp comes last and normally wants its URL or a
 * `clickup:` prefix, because `parseClickupTaskRef` would otherwise accept any
 * word at all — including a Jira key. A bare id is read as ClickUp only when
 * nothing else claimed it and ClickUp is the tracker connected here.
 */
export function guessTracker(typed: string, connected: readonly Tracker[]): Tracker | null {
  const value = typed.trim();
  if (!value) return null;
  if (parseIssueRef(value, 'owner/repo')) return 'github';
  if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(value)) return 'jira';
  if (/app\.clickup\.com\/t\//i.test(value) || /^clickup:/i.test(value)) return 'clickup';
  if (connected.includes('clickup') && parseClickupTaskRef(value)) return 'clickup';
  return null;
}

/** What a person may type here, in the trackers this project actually has. */
export function ticketExamples(connected: readonly Tracker[]): string {
  const shapes: string[] = [];
  if (connected.includes('jira')) shapes.push('PROJ-42');
  if (connected.includes('github')) shapes.push('#42 or owner/repo#42');
  if (connected.includes('clickup')) shapes.push('a ClickUp task link');
  return shapes.join(', ');
}

/** One example in the field itself, so the shape is visible before typing. */
export function ticketPlaceholder(connected: readonly Tracker[]): string {
  if (connected.includes('jira')) return 'PROJ-42';
  if (connected.includes('github')) return '#42';
  return 'https://app.clickup.com/t/…';
}

/**
 * How many tickets the picker draws.
 *
 * A picker, not a mirror: a workspace with two thousand open issues must not
 * render two thousand rows into a dialog, and the list says in words that it is
 * the newest N rather than everything. Stated here rather than left to the two
 * transports' own internal caps, so one number answers for both trackers.
 */
export const TICKET_PICKER_LIMIT = 20;

/**
 * The trackers a lead can *browse* here, which is not every tracker they can
 * paste a reference from.
 *
 * **Jira is deliberately absent.** Atlassian moved issue search to
 * `/rest/api/3/search/jql`, nothing in this codebase has exercised that
 * endpoint against a real site, and `getJiraIssue` is the one Jira door that
 * has been measured — against both of Jira's, the site door and
 * `api.atlassian.com/ex/jira/{cloudId}`. A guessed search call would sit on a
 * lead's critical path and fail there, which is strictly worse than a paste
 * field that works; so a Jira-connected project keeps the field and the page
 * says why the button is missing rather than leaving somebody to wonder.
 */
export const PICKABLE_TRACKERS: readonly Tracker[] = ['github', 'clickup'];

/**
 * Said on the page, so a missing button is an answer rather than a gap.
 *
 * Short on purpose: it sits beside the Browse buttons, and the reason above is
 * for whoever comes to add the button, not for the lead who wants their ticket.
 */
export const JIRA_PICK_NOTE =
  'Picking is not available for Jira yet — paste the key; STMA reads it the same way.';

/** What this project can be browsed from, in the trackers it actually has. */
export function pickableTrackers(connected: readonly Tracker[]): Tracker[] {
  return PICKABLE_TRACKERS.filter((tracker) => connected.includes(tracker));
}

export interface TicketOption {
  /**
   * Exactly what the Ticket field takes. Picking one therefore ends in the same
   * place as pasting it: `guessTracker` reads the shape and `readNamedTicket`
   * fetches it again when the form is submitted, so there is one path from a
   * reference to a task and a brief rather than a second one behind a list.
   */
  ref: string;
  /** The key a person says out loud. What the run records is `NamedTicket.reference`. */
  key: string;
  summary: string;
  status: string;
  updatedAt: Date | null;
}

type TicketListResult = { ok: true; value: TicketOption[] } | { ok: false; error: string };

/**
 * One tracker's open tickets, most recently updated first.
 *
 * Called only when somebody asked for the list — never while drawing the
 * project page, which reads the connections and fetches nothing, because a
 * tracker being slow must not make the page slow. A tracker that refuses is
 * named here the way `readNamedTicket` names one, rather than answering an
 * empty list: "nothing open" and "the token died" must never look alike.
 */
export async function listTicketsFor(
  db: Db,
  env: Env,
  teamId: string,
  projectId: string | null,
  tracker: Tracker,
): Promise<TicketListResult> {
  // Not reachable from the UI, which offers only `pickableTrackers`; here so a
  // future caller gets the reason rather than an empty list.
  if (tracker === 'jira') return { ok: false, error: JIRA_PICK_NOTE };

  const found = await trackerConnections(db, teamId, projectId);
  if (tracker === 'github') {
    const github = found.github;
    if (!github) {
      return { ok: false, error: 'No GitHub connection reaches this project any more.' };
    }
    const issues = await listOpenIssues(env, github, TICKET_PICKER_LIMIT);
    if (!issues.ok) {
      return {
        ok: false,
        error: `Could not read open issues from ${github.repo} (${issues.error}). Check that the connected token can still see that repository, or paste the reference instead.`,
      };
    }
    return {
      ok: true,
      value: issues.value.map((issue) => ({
        // `owner/repo#42` rather than `#42`, the same key `readNamedTicket`
        // builds: a number on its own says nothing on a ledger line read next
        // to another project's work.
        ref: `${github.repo}#${issue.number}`,
        key: `${github.repo}#${issue.number}`,
        summary: issue.title,
        // GitHub's REST issue carries `state`, which this reader does not map,
        // and every row here is open by construction; labels are what a person
        // actually sorts by. Same choice `readNamedTicket` makes.
        status: issue.labels.length ? issue.labels.join(', ') : 'issue',
        updatedAt: issue.updatedAt ? new Date(issue.updatedAt) : null,
      })),
    };
  }

  const clickup = found.clickup;
  if (!clickup) {
    return { ok: false, error: 'No ClickUp List is mapped to this project any more.' };
  }
  const tasks = await listClickupTasks(env, clickup, TICKET_PICKER_LIMIT);
  if (!tasks.ok) {
    return {
      ok: false,
      error: `Could not read ${clickup.listName} from ClickUp (${tasks.error}). Check that the connection can still see that list, or paste the task link instead.`,
    };
  }
  return {
    ok: true,
    value: tasks.value.map((task) => ({
      // The native id, not the workspace's custom one — and now a decision
      // rather than a limitation. `getClickupTask` reads either id space
      // (`isClickupCustomTaskId` picks the query), so `clickup:PD-207` would
      // resolve here too; what makes the native id the one to *store* is that
      // ClickUp guarantees it, while a custom id's prefix is a per-space
      // setting an admin can change or switch off. A task key is written once
      // and read back at merge time, so the durable half must be the stable
      // half. The custom id is what the row below is labelled with, because
      // that is what the people in that workspace say out loud.
      ref: `clickup:${task.id}`,
      key: task.customId ?? task.id,
      summary: task.name,
      status: task.status,
      updatedAt: task.updatedAt ? new Date(task.updatedAt) : null,
    })),
  };
}

type TicketResult = { ok: true; value: NamedTicket } | { ok: false; error: string };

/**
 * Read the ticket a person named.
 *
 * `start_run` lets a tracker failure pass in silence, because a run must never
 * die because Jira blinked and the agent has a task key either way. Here the
 * opposite is right: somebody typed that key into a form and is waiting to see
 * the ticket's own words, so a failure is said out loud rather than quietly
 * producing an assignment that names a ticket nobody read.
 */
export async function readNamedTicket(
  db: Db,
  env: Env,
  teamId: string,
  projectId: string | null,
  typed: string,
): Promise<TicketResult> {
  const value = typed.trim();
  const found = await trackerConnections(db, teamId, projectId);
  const connected = TRACKERS.filter((name) => found[name]);
  const tracker = guessTracker(value, connected);
  if (!tracker) {
    const known = ticketExamples(connected);
    return {
      ok: false,
      error: known
        ? `"${value}" is not a ticket this workspace can read. Try ${known}.`
        : `"${value}" is not a ticket, and no tracker is connected to this workspace.`,
    };
  }
  if (!connected.includes(tracker)) {
    return {
      ok: false,
      error: `"${value}" is a ${TRACKER_NAMES[tracker]} reference, and no ${TRACKER_NAMES[tracker]} connection reaches this project. Connect one under Integrations, or write the task yourself.`,
    };
  }

  if (tracker === 'jira') {
    const jira = found.jira!;
    const issue = await getJiraIssue(env, jira, value.toUpperCase());
    if (!issue.ok) {
      return {
        ok: false,
        error: `Could not read ${value.toUpperCase()} from Jira (${issue.error}). Check the key, or that the connected token can see that project.`,
      };
    }
    return { ok: true, value: { tracker, key: issue.value.key, reference: issue.value.key, summary: issue.value.summary, status: issue.value.status, url: issue.value.url } };
  }

  if (tracker === 'github') {
    const github = found.github!;
    // Re-parsed against the connected repository, so a bare `#42` resolves
    // there rather than against the placeholder used to recognise the shape.
    const ref = parseIssueRef(value, github.repo)!;
    const issue = await getIssue(env, github, ref.number, ref.repo);
    if (!issue.ok) {
      return {
        ok: false,
        error: `Could not read ${ref.repo}#${ref.number} from GitHub (${issue.error}). Check the number, or that the connected token can see that repository.`,
      };
    }
    // `owner/repo#42` rather than `#42`: a task key that names only a number
    // says nothing on a ledger line read next to another project's work.
    return {
      ok: true,
      value: {
        tracker,
        key: `${ref.repo}#${ref.number}`,
        reference: `${ref.repo}#${ref.number}`,
        summary: issue.value.title,
        // GitHub's REST issue carries `state`, which this reader does not map;
        // saying "open" for a closed issue would be worse than saying nothing.
        status: issue.value.labels.length ? issue.value.labels.join(', ') : 'issue',
        url: issue.value.url,
      },
    };
  }

  const clickup = found.clickup!;
  const id = parseClickupTaskRef(value)!;
  const task = await getClickupTask(env, clickup, id);
  if (!task.ok) {
    return {
      ok: false,
      error:
        task.error === 'task_outside_mapped_list'
          ? `That ClickUp task is not in ${clickup.listName}, the list mapped to this project. STMA reads only the mapped list, so a task filed elsewhere has to be moved or the mapping changed.`
          : `Could not read that ClickUp task (${task.error}). Check the link, or that the connection can still see ${clickup.listName}.`,
    };
  }
  return {
    ok: true,
    value: {
      tracker,
      // ClickUp's own custom id when the workspace uses them, because that is
      // what the people there say out loud; its opaque id otherwise.
      key: task.value.customId ?? task.value.id,
      reference: `clickup:${task.value.id}`,
      summary: task.value.name,
      status: task.value.status,
      url: task.value.url,
    },
  };
}

/**
 * The ticket, folded into the brief the receiving agent is given to read.
 *
 * The lead's own first line stays first: it is what becomes the run intent.
 */
export function briefWithTicket(brief: string, ticket: NamedTicket): string {
  const cite = `${ticket.key} · ${ticket.status}\n${ticket.url}`;
  return brief ? `${brief}\n\n${ticket.summary}\n${cite}` : `${ticket.summary}\n\n${cite}`;
}
