import { policyDocumentSchema, type PolicyDocument } from '@bridge/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { agentRuns, policyBundles, projects } from '../db/schema';
import { projectForTeam, teamForUser } from '../domain/access';
import { effectivePolicy } from '../domain/policies';
import { planLimits } from '../lib/entitlements';
import { listToLines, runtimesToLines } from '../lib/policyForm';
import type { AppEnv } from '../types';
import { PageHead } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

/**
 * The rulebook as a document, not a dialog.
 *
 * Policy was published from a modal on the governance page, which was the right
 * first move — it put the team's rules in the browser instead of behind a JSON
 * file on the one laptop with the CLI installed. But a modal is a shape for a
 * decision you can hold in your head, and this is not one: eight lists, a scope,
 * a change budget, and a consequence — every agent's next run reads whatever
 * comes out of it.
 *
 * So it gets a page, and the page shows the answer next to the question: what
 * `get_policy` will actually serve, rendered from the same merge the tool uses,
 * and what publishing does to the runs already in flight. Nothing here is a
 * second implementation — the form posts to the handler governance always used.
 */
export const policyEditorRoutes = new Hono<AppEnv>();

const PROJECT_LIMIT = 50;

/** What an agent receives, in the order the brief presents it. */
function servedText(doc: PolicyDocument, team: string, version: number | null): string {
  const out: string[] = [];
  out.push(`Team rules for ${team}${version ? ` (v${version}, pending)` : ''}`);
  for (const line of doc.guidance) out.push(`- ${line}`);
  if (doc.permissions.deny.length > 0) out.push(`Denied: ${doc.permissions.deny.join(' · ')}`);
  if (doc.permissions.requireApproval.length > 0) {
    out.push(`Requires approval: ${doc.permissions.requireApproval.join(' · ')}`);
  }
  if (doc.requiredChecks.length > 0) out.push(`Checks: ${doc.requiredChecks.join(' · ')}`);
  if (doc.protectedPaths.length > 0) out.push(`Protected: ${doc.protectedPaths.join(' · ')}`);
  if (doc.environment.requiredEnvVarNames.length > 0) {
    out.push(`Required env: ${doc.environment.requiredEnvVarNames.join(', ')}`);
  }
  const runtimes = Object.entries(doc.environment.runtimes);
  if (runtimes.length > 0) {
    out.push(`Runtimes: ${runtimes.map(([n, v]) => (v ? `${n} ${v}` : n)).join(', ')}`);
  }
  if (doc.autonomy.requireApprovalFor.length > 0) {
    out.push(`A person must approve: ${doc.autonomy.requireApprovalFor.join(' · ')}`);
  }
  const budget: string[] = [];
  if (doc.changeBudget.maxScopeItems > 0) budget.push(`${doc.changeBudget.maxScopeItems} claims`);
  if (doc.changeBudget.maxPaths > 0) budget.push(`${doc.changeBudget.maxPaths} paths`);
  if (budget.length > 0) out.push(`Budget: ${budget.join(', ')}`);
  if (out.length === 1) out.push('- (nothing published yet)');
  return out.join('\n');
}

policyEditorRoutes.get('/app/teams/:slug/policy', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const found = await teamForUser(db, user.id, c.req.param('slug'));
  if (!found) return c.notFound();
  const { team, role } = found;
  // The same door as the governance page and the publish handler: a gate on one
  // of the three is not a gate.
  if (!planLimits(team.plan, c.get('env').hosted).governance) return c.notFound();
  if (role !== 'owner') {
    return c.html(
      <AppLayout user={user} active="governance" title="Policy">
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">·</span>
          <h2 class="title m0">Owners publish policy</h2>
          <p class="m0 sub">
            You can read every rule in force on the governance page — publishing a new version is
            an owner action, because it changes what every agent on the team is told.
          </p>
          <a class="btn" href={`/app/teams/${team.slug}/governance`} style="align-self:flex-start">
            Back to governance
          </a>
        </div>
      </AppLayout>,
      403,
    );
  }

  const projectQuery = (c.req.query('project') ?? '').trim();
  const scopeProject = projectQuery ? await projectForTeam(db, team.id, projectQuery) : undefined;
  const teamProjects = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(projects.name)
    .limit(PROJECT_LIMIT);

  // Open on the live document at this scope. Scoped to a project it is that
  // project's *own additions* — opening the merged document there would
  // republish every team rule as a project rule.
  const scopeKey = scopeProject ? `project:${scopeProject.id}` : 'team';
  const bundles = await db
    .select()
    .from(policyBundles)
    .where(and(eq(policyBundles.teamId, team.id), eq(policyBundles.scopeKey, scopeKey)))
    .orderBy(desc(policyBundles.version))
    .limit(1);
  const live = bundles[0];
  const draft = live ? policyDocumentSchema.parse(live.document) : null;
  const nextVersion = (live?.version ?? 0) + 1;

  // What the tool would serve at this scope right now — merged, because that is
  // what an agent gets, and hashed the same way.
  const served = await effectivePolicy(db, user.id, {
    team: team.slug,
    project: scopeProject?.name,
  });
  const servedDoc = 'error' in served ? null : served.document;

  // Runs in flight: publishing moves the hash under them, and they will read as
  // unconfirmed until they answer with the new one.
  const liveRuns = await db
    .select({ n: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.teamId, team.id), inArray(agentRuns.status, ['active', 'waiting', 'blocked'])));

  const error = c.req.query('error');
  const scopeLabel = scopeProject ? `project: ${scopeProject.name}` : 'team-wide';

  return c.html(
    <AppLayout
      user={user}
      active="governance"
      title={`Edit policy — ${team.name}`}
      head={
        <PageHead
          crumb={`/ ${team.slug} / governance / policy`}
          title={`Edit policy — ${scopeLabel}`}
          sub="A document, not a dialog: write on the left, read what every agent will receive on the right."
          actions={
            <>
              <a class="btn btn-sm" href={`/app/teams/${team.slug}/governance`}>
                Discard
              </a>
              <button class="btn btn-sm btn-primary" type="submit" form="policy-form">
                Publish v{nextVersion}
              </button>
            </>
          }
        />
      }
      keys={[{ k: 'Esc', label: 'back to governance' }]}
      keysNote="publishing writes a new version — the old one is archived, never deleted"
    >
      {error ? <div class="banner banner-error">{error}</div> : null}

      <div class="edgrid">
        <form
          id="policy-form"
          class="card card-pad"
          method="post"
          action={`/app/teams/${team.slug}/policy`}
          style="display:flex;flex-direction:column;gap:14px"
        >
          <div class="field">
            <label for="pf-scope">Scope</label>
            <select class="in" id="pf-scope" name="scope">
              <option value="team" selected={!scopeProject}>
                Team-wide — applies to every run
              </option>
              {teamProjects.map((p) => (
                <option value={p.name} selected={p.name === scopeProject?.name}>
                  Project: {p.name} — merged on top of team policy
                </option>
              ))}
            </select>
            <span class="help">
              Project policy adds to team policy; it never replaces it. Switching scope here
              changes what you are editing — reopen the page to load that scope's document.
            </span>
          </div>

          <div class="field">
            <label for="pf-guidance">Guidance</label>
            <textarea
              class="in"
              id="pf-guidance"
              name="guidance"
              rows={3}
              placeholder="Keep migrations backwards compatible.&#10;Never touch another agent's branch — open a debug session instead."
            >
              {draft ? listToLines(draft.guidance) : ''}
            </textarea>
            <span class="help">Plain sentences the agent reads before it plans.</span>
          </div>

          <div class="field">
            <label for="pf-deny">Denied</label>
            <textarea
              class="in"
              id="pf-deny"
              name="deny"
              rows={3}
              placeholder="read secret values&#10;push to main"
            >
              {draft ? listToLines(draft.permissions.deny) : ''}
            </textarea>
          </div>

          <div class="field">
            <label for="pf-approval">Requires approval</label>
            <textarea
              class="in"
              id="pf-approval"
              name="requireApproval"
              rows={2}
              placeholder="production changes&#10;schema migrations"
            >
              {draft ? listToLines(draft.permissions.requireApproval) : ''}
            </textarea>
            <span class="help">The agent must ask its human before doing these.</span>
          </div>

          <div class="field">
            <label for="pf-checks">Required checks</label>
            <textarea
              class="in"
              id="pf-checks"
              name="requiredChecks"
              rows={2}
              placeholder="npm test&#10;npm run typecheck"
            >
              {draft ? listToLines(draft.requiredChecks) : ''}
            </textarea>
          </div>

          <div class="field">
            <label for="pf-paths">Protected paths</label>
            <textarea
              class="in"
              id="pf-paths"
              name="protectedPaths"
              rows={2}
              placeholder="db/migrations/**&#10;.github/workflows/**"
            >
              {draft ? listToLines(draft.protectedPaths) : ''}
            </textarea>
          </div>

          <div class="field">
            <label for="pf-env">Required environment variables</label>
            <textarea
              class="in"
              id="pf-env"
              name="requiredEnvVarNames"
              rows={2}
              placeholder="DATABASE_URL&#10;PAYMENTS_WEBHOOK_SECRET"
            >
              {draft ? listToLines(draft.environment.requiredEnvVarNames) : ''}
            </textarea>
            <span class="help">Names only — STMA never carries a value.</span>
          </div>

          <div class="field">
            <label for="pf-runtimes">Expected runtimes</label>
            <textarea
              class="in"
              id="pf-runtimes"
              name="runtimes"
              rows={2}
              placeholder="node=22.14.0&#10;python=3.12.4"
            >
              {draft ? runtimesToLines(draft.environment.runtimes) : ''}
            </textarea>
            <span class="help">
              One <code>name=version</code> per line. Preflight calls a mismatch critical.
            </span>
          </div>

          <div class="field">
            <label for="pf-autonomy">A person must approve</label>
            <textarea
              class="in"
              id="pf-autonomy"
              name="requireApprovalFor"
              rows={2}
              placeholder="migration&#10;contract"
            >
              {draft ? listToLines(draft.autonomy.requireApprovalFor) : ''}
            </textarea>
            <span class="help">
              Claim types that need a human before a run takes write access to them.
            </span>
          </div>

          <div class="row" style="gap:12px;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:150px">
              <label for="pf-claims">Max claims per run</label>
              <input
                class="in"
                id="pf-claims"
                type="number"
                name="maxScopeItems"
                min={0}
                value={draft?.changeBudget.maxScopeItems || ''}
                placeholder="0 = unset"
              />
            </div>
            <div class="field" style="flex:1;min-width:150px">
              <label for="pf-paths-budget">Max paths per run</label>
              <input
                class="in"
                id="pf-paths-budget"
                type="number"
                name="maxPaths"
                min={0}
                value={draft?.changeBudget.maxPaths || ''}
                placeholder="0 = unset"
              />
            </div>
          </div>
        </form>

        <div class="col">
          <div class="darkcard">
            <span class="overline">What get_policy will serve</span>
            <div class="cmd inner">
              <code style="white-space:pre-wrap">
                {servedDoc ? servedText(servedDoc, team.slug, null) : '(nothing published yet)'}
              </code>
            </div>
            <p class="m0 small" style="color:var(--dark-mut)">
              The merged document, exactly as an agent receives it — team rules with this scope's
              additions on top. It updates when you publish, not while you type.
            </p>
          </div>

          <div class="card card-pad" style="display:flex;flex-direction:column;gap:12px">
            <span class="card-title">On publish</span>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                v{live?.version ?? 0} is archived, not deleted — the record of what was in force
                stays.
              </span>
            </div>
            <div class="factrow">
              <span class="y">✓</span>
              <span>
                The new hash reaches every agent on its next <code>get_policy</code>.
              </span>
            </div>
            <div class="factrow">
              <span class={liveRuns.length > 0 ? 'n' : 'y'}>
                {liveRuns.length > 0 ? '!' : '✓'}
              </span>
              <span>
                {liveRuns.length > 0
                  ? `${liveRuns.length} live ${liveRuns.length === 1 ? 'run is' : 'runs are'} on the old version — they read as unconfirmed until they answer with the new hash.`
                  : 'No run is in flight, so nothing is holding the old version.'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>,
  );
});
