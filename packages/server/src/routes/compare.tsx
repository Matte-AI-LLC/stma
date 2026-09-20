import { membershipUser } from '../lib/securityHooks';
import {
  compareSnapshots,
  snapshotSchema,
  type CompareResult,
  type DiffEntry,
} from '@bridge/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { Db } from '../db';
import { memberships, projects, snapshots, teams, users } from '../db/schema';
import { loginRedirect } from '../auth/session';
import { projectForTeam } from '../domain/access';
import { activeBaselines } from '../domain/environments';
import { devicesByMember, type DeviceSummary } from '../lib/devices';
import { timeAgo } from '../lib/format';
import { snapshotProjectLabel, snapshotsShareProject } from '../lib/projects';
import { projectInPath, scopedProjectParam, sectionHref } from '../lib/scope';
import type { AppEnv } from '../types';
import { PageHead, ProjectScope, scopedTrail } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

export const compareRoutes = new Hono<AppEnv>();

const DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_DAYS = 7;

const SECTION_LABELS: Record<string, string> = {
  os: 'Operating system',
  runtimes: 'Runtime versions',
  packageManagers: 'Package managers',
  lockfiles: 'Lockfiles',
  envVarNames: 'Environment variable names',
  git: 'Git state',
  system: 'System',
};

async function teamForMember(db: Db, slug: string, userId: string) {
  const rows = await db
    .select({ team: teams, role: memberships.role })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(and(eq(teams.slug, slug), membershipUser(userId)))
    .limit(1);
  return rows[0];
}

async function latestSnapshot(
  db: Db,
  teamId: string,
  userId: string,
  device: string | null,
  projectId?: string,
) {
  const conds = [eq(snapshots.teamId, teamId), eq(snapshots.userId, userId)];
  if (device) conds.push(eq(snapshots.deviceLabel, device));
  // Scoped to a project, "latest" means the latest snapshot *of that project* —
  // a machine that pushed two repos would otherwise diff whichever came last.
  if (projectId) conds.push(eq(snapshots.projectId, projectId));
  const rows = await db
    .select()
    .from(snapshots)
    .where(and(...conds))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);
  return rows[0];
}

/** One pickable side: a member, optionally pinned to one of their machines. */
interface Side {
  username: string;
  device: string | null;
}

/** "alice@macbook" → alice on that machine; "alice" → her most recent snapshot. */
function parseSide(raw: string | undefined): Side | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf('@');
  return at === -1
    ? { username: raw, device: null }
    : { username: raw.slice(0, at), device: raw.slice(at + 1) || null };
}

const sideValue = (s: Side): string => (s.device ? `${s.username}@${s.device}` : s.username);
const sideLabel = (s: Side): string => (s.device ? `${s.username} · ${s.device}` : s.username);
const sameSide = (a: Side, b: Side): boolean =>
  a.username === b.username && a.device === b.device;

function cellValue(section: string, e: DiffEntry, side: 'a' | 'b'): string {
  const value = side === 'a' ? e.a : e.b;
  if (value) return value;
  const presentHere = (side === 'a' && e.kind === 'only_a') || (side === 'b' && e.kind === 'only_b');
  if (section === 'envVarNames') return presentHere ? 'set' : 'not set';
  return presentHere ? 'present' : '—';
}

const isHot = (e: DiffEntry, side: 'a' | 'b'): boolean =>
  e.kind === 'mismatch' ? side === 'b' : e.kind === 'only_a' ? side === 'b' : side === 'a';

/**
 * One page, two addresses: the workspace's environments and one project's.
 *
 * `/app/teams/:slug/projects/:project/environments` is what the rail links to —
 * the page has been called Environments since it stopped being one diff of two
 * machines. `/compare?project=…` is the address it replaces and still answers.
 */
const environmentsPage = async (c: Context<AppEnv>) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForMember(db, c.req.param('slug') ?? '', user.id);
  if (!found) {
    return c.html(
      <AppLayout user={user} active="environments" title="Not found">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">×</span>
          <h2 class="title m0">Team not found</h2>
          <p class="m0 sub">Either it does not exist or you are not a member.</p>
          <a class="btn" href="/app" style="align-self:flex-start">
            Back to teams
          </a>
        </div>
      </AppLayout>,
      404,
    );
  }
  const { team } = found;
  // Named in the path the project is the page's identity, so a spelling that
  // matches nothing is a wrong address; as `?project=` it stays a filter.
  const projectQuery = scopedProjectParam(c);
  const inPath = projectInPath(c);
  const scopeProject = projectQuery
    ? await projectForTeam(db, team.id, projectQuery)
    : undefined;
  if (inPath && !scopeProject) return c.notFound();
  /** This page's own address: swapping sides and picking machines stay where the reader is. */
  const here = sectionHref(team.slug, inPath ? scopeProject!.slug : null, 'environments');
  const teamProjects = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, repositoryIdentity: projects.repositoryIdentity })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(50);
  const members = await db
    .select({ member: users })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.teamId, team.id))
    .orderBy(users.username);
  const devicesByUser = await devicesByMember(db, team.id);
  // Where the baseline on this page comes from.
  //
  // Policy, Knowledge and Delivery each say whether a rule is the workspace's or
  // the project's; a baseline never inherits at all — `activeBaselines` joins
  // `projects` on a NOT NULL column, so there is no workspace-wide row to fall
  // back to — and this page said nothing, which reads as the same silence a page
  // with an inherited rule would produce. It is the one scope question a reader
  // here actually has: preflight can only report what a baseline claims, so a
  // project without one tells its agents nothing about their machines.
  const baselines = await activeBaselines(db, team.id, scopeProject ? 1 : 25, scopeProject?.id);
  const projectsWithBaseline = new Set(baselines.map((row) => row.baseline.projectId));

  // One option per member *machine*, so a solo developer can diff their own two.
  const options: Array<Side & { label: string }> = [];
  for (const m of members) {
    const devices: DeviceSummary[] = devicesByUser.get(m.member.id) ?? [];
    if (devices.length === 0) {
      options.push({
        username: m.member.username,
        device: null,
        label: `${m.member.username} · no snapshot`,
      });
      continue;
    }
    for (const d of devices) {
      options.push({
        username: m.member.username,
        device: d.device,
        label: `${m.member.username} · ${d.device} · ${timeAgo(d.lastSnapshotAt) ?? 'no snapshot'}`,
      });
    }
  }

  const aSide: Side = parseSide(c.req.query('a')) ??
    options.find((o) => o.username === user.username) ?? { username: user.username, device: null };
  const bFallback =
    options.find((o) => o.username !== aSide.username && o.device) ??
    options.find((o) => o.username === aSide.username && o.device !== aSide.device) ??
    options.find((o) => o.username !== aSide.username);
  const bSide: Side | undefined =
    parseSide(c.req.query('b')) ??
    (bFallback ? { username: bFallback.username, device: bFallback.device } : undefined);

  const aMember = members.find((m) => m.member.username === aSide.username)?.member;
  const bMember = bSide
    ? members.find((m) => m.member.username === bSide.username)?.member
    : undefined;

  const problems: string[] = [];
  const staleWarnings: string[] = [];
  let result: CompareResult | undefined;

  if (!aMember || !bMember || !bSide) {
    problems.push('Pick two machines to compare — two teammates, or two of your own.');
  } else if (sameSide(aSide, bSide)) {
    problems.push('Pick two different machines.');
  } else {
    const aSnap = await latestSnapshot(db, team.id, aMember.id, aSide.device, scopeProject?.id);
    const bSnap = await latestSnapshot(db, team.id, bMember.id, bSide.device, scopeProject?.id);
    for (const [side, snap] of [
      [aSide, aSnap],
      [bSide, bSnap],
    ] as const) {
      if (!snap) {
        problems.push(
          scopeProject
            ? `${sideLabel(side)} has no ${scopeProject.name} snapshot yet — that machine's agent should push one from that checkout, or clear the project filter.`
            : `${sideLabel(side)} has no snapshot yet — that machine's agent should run get_snapshot_checklist, then push_snapshot.`,
        );
      } else {
        const ageDays = Math.floor((Date.now() - snap.createdAt.getTime()) / DAY);
        if (ageDays >= STALE_AFTER_DAYS) {
          staleWarnings.push(
            `${sideLabel(side)}'s snapshot is ${ageDays} days old. Ask that agent to push a fresh one before trusting this comparison.`,
          );
        }
      }
    }
    if (aSnap && bSnap && !scopeProject && !snapshotsShareProject(aSnap, bSnap)) {
      problems.push(
        `These machines' newest snapshots belong to different projects (${snapshotProjectLabel(aSnap)} and ${snapshotProjectLabel(bSnap)}). Pick one project above before comparing them.`,
      );
    } else if (aSnap && bSnap) {
      const aParsed = snapshotSchema.safeParse(aSnap.data);
      const bParsed = snapshotSchema.safeParse(bSnap.data);
      if (!aParsed.success || !bParsed.success) {
        problems.push('A stored snapshot no longer matches the current schema — push fresh ones.');
      } else {
        result = compareSnapshots(aParsed.data, bParsed.data, {
          a: sideValue({ username: aMember.username, device: aSnap.deviceLabel }),
          b: sideValue({ username: bMember.username, device: bSnap.deviceLabel }),
        });
      }
    }
  }

  const aValue = sideValue(aSide);
  const bValue = bSide ? sideValue(bSide) : '';

  return c.html(
    <AppLayout
      user={user}
      active="environments"
      title="Compare environments"
      scope={
        <>
          <span class="chip">
            team <b>{team.slug}</b>
          </span>
          {/* Posts to the workspace address: its options carry project ids, and a
              GET form can only write a query string. Links carry the path form. */}
          <ProjectScope
            path={sectionHref(team.slug, null, 'environments')}
            projects={teamProjects}
            current={scopeProject?.id ?? null}
            allLabel="Any project — newest snapshot"
            extra={{ a: aValue, b: bValue }}
          />
        </>
      }
      head={
        <PageHead
          trail={scopedTrail({ team, project: scopeProject }, 'Environments')}
          title="Compare environments"
          sub={
            scopeProject
              ? `Two machines, one mechanical diff — comparing each side's newest ${scopeProject.name} snapshot.`
              : 'Two machines, one mechanical diff — their newest snapshots must belong to the same project.'
          }
          actions={
            <>
              {/* Reading a diff the wrong way round is the most common thing
                  anybody does here, and re-picking both sides to fix it is three
                  clicks. It is a link because the sides are already in the URL. */}
              {bSide ? (
                <a
                  class="btn btn-sm"
                  href={`${here}?a=${encodeURIComponent(
                    sideValue(bSide),
                  )}&b=${encodeURIComponent(sideValue(aSide))}${
                    scopeProject && !inPath ? `&project=${encodeURIComponent(scopeProject.name)}` : ''
                  }`}
                >
                  ⇄ Swap sides
                </a>
              ) : null}
              {/* Back to where this page was opened from: a project's environments
                  belong to the project, and its trail is the only other way there. */}
              {scopeProject ? (
                <a
                  class="btn btn-sm"
                  href={`/app/teams/${team.slug}/projects/${encodeURIComponent(scopeProject.slug)}`}
                >
                  Back to {scopeProject.name}
                </a>
              ) : (
                <a class="btn btn-sm" href={`/app/teams/${team.slug}`}>
                  Back to {team.slug}
                </a>
              )}
            </>
          }
        />
      }
    >

      <form class="card card-pad compare-pick" method="get" action={here}>
        {scopeProject && !inPath ? <input type="hidden" name="project" value={scopeProject.name} /> : null}
        <div class="field">
          <label>Side A</label>
          <select class="in" name="a">
            {options.map((o) => (
              <option value={sideValue(o)} selected={sideValue(o) === aValue}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>Side B</label>
          <select class="in" name="b">
            {options.map((o) => (
              <option value={sideValue(o)} selected={sideValue(o) === bValue}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button class="btn btn-primary" type="submit">
          Compare
        </button>
        <p class="card-note m0" style="flex:1 0 100%">
          Each machine keeps its own snapshot — pick two teammates, or your own laptop and desktop.
          Agents name a machine with the <span class="mono">device</span> parameter of{' '}
          <span class="mono">push_snapshot</span>.
        </p>
      </form>

      <div class="card card-pad" style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
        <div class="row" style="justify-content:space-between;gap:12px;align-items:flex-start">
          <div>
            <div class="card-title">{scopeProject ? `Baseline for ${scopeProject.name}` : 'Baselines'}</div>
            <div class="card-note">
              A baseline belongs to one project. There is no workspace-wide one to fall back on, so
              a project without its own is a project whose agents are told nothing about their
              machines.
            </div>
          </div>
          <a class="btn btn-sm" href={sectionHref(team.slug, scopeProject?.slug, 'governance')}>
            {scopeProject && baselines.length === 0 ? 'Record one' : 'Update baseline'}
          </a>
        </div>
        {baselines.length === 0 ? (
          <p class="m0 small muted">
            {scopeProject
              ? `No baseline recorded for ${scopeProject.name}. Promote one from a snapshot this team already pushed — from the machine that works, not the one being debugged.`
              : 'No project in this workspace has a baseline yet.'}
          </p>
        ) : (
          <>
            {baselines.map((row) => (
              <div class="factrow">
                <span class="n">·</span>
                <span style="flex:1">
                  <b>{row.projectName}</b> only · recorded by {row.author ?? 'a deleted account'}{' '}
                  {timeAgo(row.baseline.createdAt)}
                </span>
              </div>
            ))}
            {!scopeProject && teamProjects.length > projectsWithBaseline.size ? (
              <p class="m0 small muted">
                {teamProjects.length - projectsWithBaseline.size} other project
                {teamProjects.length - projectsWithBaseline.size === 1 ? ' has' : 's have'} none.
              </p>
            ) : null}
          </>
        )}
      </div>

      {problems.map((p) => (
        <div class="banner banner-warn">
          <span class="ic">!</span>
          <span>{p}</span>
        </div>
      ))}
      {staleWarnings.map((w) => (
        <div class="banner banner-warn">
          <span class="ic">!</span>
          <span>{w}</span>
        </div>
      ))}

      {result && result.identical ? (
        <div class="card" style="padding:36px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px">
          <span class="tile tile-44 tile-green" style="border-radius:99px">
            ✓
          </span>
          <h2 class="title m0" style="font-size:20px">
            No differences found
          </h2>
          <p class="m0 sub" style="max-width:46ch">
            All {result.comparedKeys} compared keys match across both machines. If the bug still
            only happens on one side, the cause is outside the captured environment — open a debug
            session.
          </p>
          <a class="btn" href="/app/sessions">
            Start a debug session
          </a>
        </div>
      ) : null}

      {result && !result.identical ? (
        <>
          <div class="sumbar">
            <div class="sumbar-left">
              <span class="n">{result.totalDifferences}</span>
              <span class="t">
                {result.totalDifferences === 1 ? 'difference' : 'differences'} across{' '}
                {result.sections.length} {result.sections.length === 1 ? 'category' : 'categories'}{' '}
                · {result.identicalKeys} keys identical
              </span>
            </div>
            <div class="legend">
              <span>
                <span class="sw" style="background:#b45309"></span> differs
              </span>
              <span>
                <span class="sw" style="background:#37536d"></span> only one side
              </span>
            </div>
          </div>

          <div class="card scroll-x">
            <table class="tbl">
              <tr>
                <th>Key</th>
                <th>{sideLabel(aSide)}</th>
                <th>{bSide ? sideLabel(bSide) : ''}</th>
                <th>Result</th>
              </tr>
              {result.sections.map((sec) => (
                <>
                  <tr class="section">
                    <td colspan={4}>
                      {SECTION_LABELS[sec.section] ?? sec.section}
                      {sec.section === 'envVarNames' ? (
                        <span class="soft"> — names only, values are never collected</span>
                      ) : null}
                    </td>
                  </tr>
                  {sec.entries.map((e) => (
                    <tr class={e.kind === 'mismatch' ? 'warm' : 'cool'}>
                      <td class="mono" style="color:#4b5055">
                        {e.key}
                      </td>
                      <td class={`val${isHot(e, 'a') ? ' hot' : ''}`}>{cellValue(sec.section, e, 'a')}</td>
                      <td class={`val${isHot(e, 'b') ? ' hot' : ''}`}>{cellValue(sec.section, e, 'b')}</td>
                      <td>
                        {e.kind === 'mismatch' ? (
                          <span class="pill pill-warn">differs</span>
                        ) : e.kind === 'only_a' ? (
                          <span class="pill pill-info">only A</span>
                        ) : (
                          <span class="pill pill-info">only B</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
            </table>
          </div>
        </>
      ) : null}
    </AppLayout>,
  );
};

compareRoutes.get('/app/teams/:slug/compare', environmentsPage);
compareRoutes.get('/app/teams/:slug/projects/:project/environments', environmentsPage);
