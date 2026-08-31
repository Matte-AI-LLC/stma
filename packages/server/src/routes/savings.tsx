import { Hono } from 'hono';
import { loginRedirect } from '../auth/session';
import { teamForUser } from '../domain/access';
import {
  SAVING_KINDS,
  confirmSaving,
  savingEvents,
  savingsLedger,
  type SavingEvent,
  type SavingKind,
  type SavingsLedger,
} from '../domain/savings';
import { teams } from '../db/schema';
import { eq } from 'drizzle-orm';
import { planLimits } from '../lib/entitlements';
import { timeAgo } from '../lib/format';
import { track } from '../lib/track';
import type { AppEnv } from '../types';
import { Band, Field, Inspector, Lead, PageHead, Vr } from '../ui/Console';
import { AppLayout } from '../ui/Layout';

/**
 * What the product prevented, and how much of that anybody has confirmed.
 *
 * The page exists to keep those two numbers apart. Everything above the fold is
 * "a person signed for this"; the observed count sits next to it, clearly
 * labelled as moments worth asking about rather than money. The temptation is
 * always to print the big number — and the big number is exactly the one a buyer
 * checks first and stops trusting first.
 */
export const savingsRoutes = new Hono<AppEnv>();

const back = (slug: string, msg: string, ok = false, show?: string): string =>
  `/app/teams/${slug}/savings?${show === 'answered' ? 'show=answered&' : ''}${ok ? 'ok' : 'error'}=${encodeURIComponent(msg)}`;

const KIND_LABEL: Record<SavingKind, string> = {
  conflict: 'collision warned',
  duplicate: 'duplicate work',
  preflight: 'machine stopped',
  handoff: 'work handed over',
};

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const hours = (minutes: number): string =>
  minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;

/** Same shape as the operator console's tiles — one stat idiom, not two. */
const statGrid = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px';

const Stat = ({ label, value, note }: { label: string; value: string | number; note?: string }) => (
  <div class="card card-pad" style="display:flex;flex-direction:column;gap:8px">
    <span class="overline">{label}</span>
    <span style="font:600 26px/1 var(--mono)" data-metric={label}>
      {value}
    </span>
    {note ? <span class="muted small">{note}</span> : null}
  </div>
);

const Totals = ({ ledger }: { ledger: SavingsLedger }) => (
  <>
    <div>
      <div class="card-title">Confirmed by a person</div>
      <div class="card-note">
        Last {ledger.days} days. Only answers that said it helped <b>and</b> changed what happened
        are counted — a warning somebody found interesting and then ignored cost the same as no
        warning.
      </div>
    </div>
    <div style={statGrid}>
      <Stat label="Confirmed savings" value={ledger.confirmed} />
      <Stat label="Rework avoided" value={hours(ledger.minutesSaved)} />
      <Stat
        label="Value"
        value={ledger.valueCents === null ? '—' : money(ledger.valueCents)}
        note={ledger.valueCents === null ? 'no hourly rate set' : 'at your hourly rate'}
      />
      <Stat label="Agent spend stopped" value={ledger.spendStopped} />
    </div>
    <p class="m0 small muted">
      <b>{ledger.observedTotal}</b> moments observed in the same window (
      {SAVING_KINDS.filter((k) => ledger.observed[k] > 0)
        .map((k) => `${ledger.observed[k]} ${KIND_LABEL[k]}`)
        .join(' · ') || 'none yet'}
      ). That is what STMA saw, not what it saved
      {ledger.rejected > 0 ? `, and ${ledger.rejected} of the answers said it did not help` : ''}.
    </p>
    {/* The other side of the ROI sentence — but only from figures agents READ.
        No reports means unmeasured, and unmeasured never renders as free. */}
    {ledger.measuredSpendCents !== null ? (
      <p class="m0 small muted">
        Agents reported spending <b>{money(ledger.measuredSpendCents)}</b> across{' '}
        {ledger.measuredSpendRuns} run{ledger.measuredSpendRuns === 1 ? '' : 's'} in the same
        window — measured figures only; estimates are recorded on the run and never summed.
      </p>
    ) : null}
  </>
);

/** Which of the three answers this is, so the form can open on it again. */
const verdictOf = (c: SavingEvent['confirmation']): 'changed' | 'helpful' | 'no' | '' =>
  !c ? '' : !c.helpful ? 'no' : c.changedBehaviour ? 'changed' : 'helpful';

/**
 * One line saying what the answer was and what it did to the total.
 *
 * A rejected answer names the minutes that were typed into it. They are stored
 * either way, and leaving them invisible made the only two outcomes look
 * identical from the outside: a number that was deliberately not counted, and a
 * number that never arrived. The first question somebody asks after entering 90
 * minutes and seeing the total stay at 45 is whether it saved at all.
 */
const verdictLine = (c: NonNullable<SavingEvent['confirmation']>): string => {
  if (c.helpful && c.changedBehaviour) {
    return `Counted — ${c.minutesSaved === null ? 'no estimate given' : hours(c.minutesSaved)} of rework avoided${c.spendStopped ? ', agent spend stopped' : ''}`;
  }
  const kept = c.minutesSaved === null ? '' : ` (${hours(c.minutesSaved)} recorded, not added)`;
  return c.helpful
    ? `Useful, but it did not change what happened — not counted${kept}`
    : `Did not help — not counted${kept}`;
};

const AnswerForm = ({ slug, event }: { slug: string; event: SavingEvent }) => {
  const id = `${event.kind}-${event.refId.slice(0, 8)}`;
  const done = event.confirmation;
  // Opened on the existing answer, not on a blank form. "Update" that makes you
  // retype everything is not an update, and a card that shows `Choose…` above a
  // line saying it was counted invites exactly one question: is my answer still
  // there?
  const chosen = verdictOf(done);
  return (
    <form
      method="post"
      action={`/app/teams/${slug}/savings/confirm`}
      class="row"
      style="gap:10px;flex-wrap:wrap;align-items:flex-end"
    >
      <input type="hidden" name="kind" value={event.kind} />
      <input type="hidden" name="ref" value={event.refId} />
      <input type="hidden" name="run" value={event.runId ?? ''} />
      {/* Updating an answer should leave you where you were reading it. */}
      {done ? <input type="hidden" name="show" value="answered" /> : null}
      <Field id={`${id}-verdict`} label="Did it help?" required>
        <select class="in" id={`${id}-verdict`} name="verdict" style="height:34px">
          <option value="" selected={chosen === ''} disabled={chosen === ''}>
            Choose…
          </option>
          <option value="changed" selected={chosen === 'changed'}>
            Yes — and I did something differently
          </option>
          <option value="helpful" selected={chosen === 'helpful'}>
            Useful, but I would have done the same
          </option>
          <option value="no" selected={chosen === 'no'}>
            No
          </option>
        </select>
      </Field>
      <Field id={`${id}-minutes`} label="Rework avoided" help="Minutes. Leave blank rather than guess.">
        <input
          class="in"
          id={`${id}-minutes`}
          name="minutes"
          type="number"
          min="0"
          max="1440"
          inputmode="numeric"
          style="width:120px;height:34px"
          value={done?.minutesSaved === null || done === null ? '' : String(done.minutesSaved)}
          aria-describedby={`${id}-minutes-help`}
        />
      </Field>
      <Field id={`${id}-spend`} label="Agent spend stopped">
        <select class="in" id={`${id}-spend`} name="spend" style="height:34px">
          <option value="0" selected={!done?.spendStopped}>
            No
          </option>
          <option value="1" selected={done?.spendStopped === true}>
            Yes
          </option>
        </select>
      </Field>
      <button class="btn btn-sm btn-primary" type="submit" style="height:34px">
        {done ? 'Update' : 'Record'}
      </button>
    </form>
  );
};

const WaitingRow = ({ slug, event }: { slug: string; event: SavingEvent }) => (
  <div class="card card-pad" style="gap:10px">
    <div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
      <span class="pill pill-member">{KIND_LABEL[event.kind]}</span>
      {event.where ? <span class="mono small">{event.where}</span> : null}
      <span class="muted small">{timeAgo(event.at)}</span>
    </div>
    <div class="small">{event.what}</div>
    <AnswerForm slug={slug} event={event} />
  </div>
);

/**
 * An answer already given — the record, not another question.
 *
 * Its own section rather than a grey line inside the queue: somebody who has
 * just confirmed something needs to be able to see *which* thing they
 * confirmed, and a card still filed under "moments worth asking about" answers
 * the opposite question. The form is still reachable, folded away, because
 * changing your mind is rarer than wanting to check.
 */
const AnsweredRow = ({ slug, event }: { slug: string; event: SavingEvent }) => {
  const done = event.confirmation!;
  const counted = done.helpful && done.changedBehaviour;
  return (
    <div class="card card-pad" style="gap:8px">
      <div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
        <span class={`pill ${counted ? 'pill-active' : 'pill-muted'}`}>
          {counted ? 'counted' : 'not counted'}
        </span>
        <span class="pill pill-member">{KIND_LABEL[event.kind]}</span>
        {event.where ? <span class="mono small">{event.where}</span> : null}
        <span class="muted small">{timeAgo(event.at)}</span>
      </div>
      <div class="small">{event.what}</div>
      <div class="small muted">
        {verdictLine(done)}
        {done.by ? ` · ${done.by}` : ''} · answered {timeAgo(done.at)}
      </div>
      <details class="answerfold">
        <summary>Change this answer</summary>
        <AnswerForm slug={slug} event={event} />
      </details>
    </div>
  );
};

savingsRoutes.get('/app/teams/:slug/savings', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const found = await teamForUser(db, user.id, c.req.param('slug'));
  if (!found) return c.notFound();
  const { team, role } = found;
  const limits = planLimits(team.plan, env.hosted);

  // Not entitled is a page, not a 404. The reason to upgrade has to be visible
  // from inside the product, the same argument as the read-only agent map.
  if (!limits.savings) {
    // The count, not the claim. "We are already recording this for you" is an
    // assertion the reader has no way to check; the same sentence with their own
    // number in it is the argument, and it costs three bounded aggregates.
    const seen = await savingsLedger(db, team.id, 30);
    const breakdown = SAVING_KINDS.filter((k) => seen.observed[k] > 0)
      .map((k) => `${seen.observed[k]} ${KIND_LABEL[k]}`)
      .join(' · ');
    return c.html(
      <AppLayout user={user} active="savings" title={`Savings — ${team.name}`}>
        <div class="card card-pad joincard">
          <span class="tile tile-44 tile-gray">$</span>
          <h2 class="title m0">Verified savings</h2>
          {seen.observedTotal > 0 ? (
            <p class="m0 sub">
              STMA has recorded <b>{seen.observedTotal}</b> moments worth counting for {team.name}
              {' '}
              in the last 30 days — {breakdown}. The ledger that turns those into a number you can
              defend, by asking a person whether each one changed what they did, is on the Solo
              plan and up.
            </p>
          ) : (
            <p class="m0 sub">
              Nothing to count yet for {team.name}. These appear on their own as agents work:
              collisions STMA warns about, duplicate work it catches, machines it stops before
              they start, and limits work survives. The ledger that turns them into a number you
              can defend is on the Solo plan and up.
            </p>
          )}
          <p class="m0 small muted">
            Nothing is lost while you wait: the events are stored either way, so turning this on
            later still has a history to read.
          </p>
        </div>
      </AppLayout>,
      402,
    );
  }

  const [ledger, events] = await Promise.all([
    savingsLedger(db, team.id, 30),
    savingEvents(db, team.id),
  ]);
  const waiting = events.filter((e) => e.confirmation === null);
  const answered = events.filter((e) => e.confirmation !== null);
  const show = c.req.query('show') === 'answered' ? 'answered' : 'waiting';

  const strip = (
    <>
      <Lead text={ledger.confirmed > 0 ? 'Counted' : 'Nothing counted yet'} live={ledger.confirmed > 0} />
      <Vr />
      <span>{ledger.observedTotal} observed</span>
      <span class="dim">·</span>
      <span>{ledger.answered} answered</span>
      <Vr />
      <span>{waiting.length} waiting on you</span>
    </>
  );

  const band =
    ledger.hourlyCostCents === null && ledger.minutesSaved > 0 ? (
      <Band kind="info" tag="No rate">
        {hours(ledger.minutesSaved)} of rework is confirmed but there is no hourly cost on this
        team, so the ledger reports minutes. Set one below and the same minutes become a figure
        you can put in front of somebody.
      </Band>
    ) : waiting.length > 0 ? (
      <Band kind="info" tag="Unanswered">
        {waiting.length} {waiting.length === 1 ? 'moment is' : 'moments are'} waiting for an
        answer. Nothing is counted until a person says it changed what they did.
      </Band>
    ) : null;

  return c.html(
    <AppLayout
      user={user}
      active="savings"
      title={`Savings — ${team.name}`}
      strip={strip}
      band={band}
      head={
        <PageHead
          crumb={`/ ${team.slug} / savings`}
          title="Verified savings"
          sub="What STMA prevented, separated from what somebody confirmed it prevented."
        />
      }
      inspector={
        <Inspector>
          <div class="ins-sec">
            <span class="ins-label">How the number is made</span>
            <p class="m0 small muted">
              confirmed minutes × hourly cost ÷ 60. Only answers marked "and I did something
              differently" are in it. Observed moments are never converted into money, and an
              estimate nobody gave is never invented.
            </p>
          </div>
          {role === 'owner' ? (
            <div class="ins-sec">
              <span class="ins-label">Hourly cost</span>
              <form method="post" action={`/app/teams/${team.slug}/savings/rate`}>
                <Field
                  id="rate"
                  label="Fully loaded hourly cost"
                  help="Whole currency units, e.g. 90. Blank clears it and the ledger goes back to minutes."
                >
                  <input
                    class="in"
                    id="rate"
                    name="rate"
                    type="number"
                    min="0"
                    max="10000"
                    inputmode="numeric"
                    value={
                      ledger.hourlyCostCents === null
                        ? ''
                        : String(Math.round(ledger.hourlyCostCents / 100))
                    }
                    aria-describedby="rate-help"
                  />
                </Field>
                <button class="btn btn-sm" type="submit">
                  Save rate
                </button>
              </form>
            </div>
          ) : null}
        </Inspector>
      }
    >
      {c.req.query('ok') ? (
        <div class="banner banner-success">
          <span class="ic">✓</span>
          <span>{c.req.query('ok')}</span>
        </div>
      ) : null}
      {c.req.query('error') ? (
        <div class="banner banner-error">
          <span class="ic">!</span>
          <span>{c.req.query('error')}</span>
        </div>
      ) : null}

      <Totals ledger={ledger} />

      {/* Two lists, one at a time, and the switch is a link rather than script —
          the same choice the agent map's inspector makes. It survives a refresh,
          it can be pasted to somebody, and it works with no JavaScript at all. */}
      <div class="tabs" style="margin-top:8px">
        <a class={`tab${show === 'waiting' ? ' active' : ''}`} href={`/app/teams/${team.slug}/savings`}>
          Waiting for an answer{waiting.length > 0 ? ` (${waiting.length})` : ''}
        </a>
        <a
          class={`tab${show === 'answered' ? ' active' : ''}`}
          href={`/app/teams/${team.slug}/savings?show=answered`}
        >
          Answered{answered.length > 0 ? ` (${answered.length})` : ''}
        </a>
      </div>

      {show === 'answered' ? (
        <>
          <p class="m0 small muted" style="margin:12px 0 4px">
            The record behind the numbers above — including the ones somebody said did not help,
            because a ledger that hides its rejections is marketing.
          </p>
          {answered.length === 0 ? (
            <div class="card card-pad">
              <p class="m0 sub">Nothing answered yet.</p>
            </div>
          ) : (
            <div class="stack">
              {answered.map((event) => (
                <AnsweredRow slug={team.slug} event={event} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p class="m0 small muted" style="margin:12px 0 4px">
            Newest first. Answering one takes a few seconds and is the only thing that moves the
            number above.
          </p>
          {events.length === 0 ? (
            <div class="card card-pad">
              <p class="m0 sub">
                Nothing yet. These appear on their own as agents work: a run warned about an
                overlap, a second agent told somebody was already on the task, a machine stopped
                before it started, or work handed over before a limit.
              </p>
            </div>
          ) : waiting.length === 0 ? (
            <div class="card card-pad">
              <p class="m0 sub">
                Everything here has been answered. The record is under{' '}
                <a href={`/app/teams/${team.slug}/savings?show=answered`}>Answered</a>.
              </p>
            </div>
          ) : (
            <div class="stack">
              {waiting.map((event) => (
                <WaitingRow slug={team.slug} event={event} />
              ))}
            </div>
          )}
        </>
      )}
    </AppLayout>,
  );
});

savingsRoutes.post('/app/teams/:slug/savings/confirm', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const env = c.get('env');
  const slug = c.req.param('slug');
  const found = await teamForUser(db, user.id, slug);
  if (!found) return c.notFound();
  if (!planLimits(found.team.plan, env.hosted).savings) return c.notFound();

  const form = await c.req.parseBody();
  const kind = String(form.kind ?? '') as SavingKind;
  const refId = String(form.ref ?? '').trim();
  const verdict = String(form.verdict ?? '');
  // Which list the answer came from, so a correction lands back where it was read.
  const from = String(form.show ?? '') === 'answered' ? 'answered' : undefined;
  if (!SAVING_KINDS.includes(kind) || !refId) {
    return c.redirect(back(slug, 'That answer did not name an event.', false, from), 302);
  }
  if (!['changed', 'helpful', 'no'].includes(verdict)) {
    return c.redirect(back(slug, 'Choose whether it helped before recording it.', false, from), 302);
  }
  const rawMinutes = String(form.minutes ?? '').trim();
  const result = await confirmSaving(db, user.id, found.team.id, {
    kind,
    refId,
    runId: String(form.run ?? '').trim() || null,
    helpful: verdict !== 'no',
    changedBehaviour: verdict === 'changed',
    minutesSaved: rawMinutes === '' ? null : Number(rawMinutes),
    spendStopped: String(form.spend ?? '0') === '1',
  });
  if ('error' in result) return c.redirect(back(slug, result.error, false, from), 302);
  void track(db, {
    teamId: found.team.id,
    userId: user.id,
    action: 'saving_confirmed',
    detail: `${kind} · ${verdict}${rawMinutes ? ` · ${rawMinutes}m` : ''}`,
  });
  return c.redirect(
    back(
      slug,
      verdict === 'changed'
        ? 'Counted. That is the number anyone can defend.'
        : 'Recorded. A "no" is worth keeping — it is what stops the ledger drifting.',
      true,
      from,
    ),
    302,
  );
});

savingsRoutes.post('/app/teams/:slug/savings/rate', async (c) => {
  const user = c.get('user');
  if (!user) return loginRedirect(c);
  const db = c.get('db');
  const slug = c.req.param('slug');
  const found = await teamForUser(db, user.id, slug);
  if (!found) return c.notFound();
  if (found.role !== 'owner') {
    return c.redirect(back(slug, 'Only an owner can set what an hour is worth.'), 302);
  }
  const raw = String((await c.req.parseBody()).rate ?? '').trim();
  if (raw === '') {
    await db.update(teams).set({ hourlyCostCents: null }).where(eq(teams.id, found.team.id));
    return c.redirect(back(slug, 'Rate cleared. The ledger reports minutes again.', true), 302);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    return c.redirect(back(slug, 'Enter an hourly cost between 0 and 10000, or leave it blank.'), 302);
  }
  await db
    .update(teams)
    .set({ hourlyCostCents: Math.round(value * 100) })
    .where(eq(teams.id, found.team.id));
  return c.redirect(back(slug, `An hour is now worth ${money(Math.round(value * 100))}.`, true), 302);
});
