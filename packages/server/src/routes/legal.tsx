import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Head, Logo } from '../ui/Layout';

/**
 * Terms and privacy. Public, unauthenticated, and linked from every footer —
 * a site that collects accounts needs somewhere to point at.
 *
 * The text is the working draft: accurate about what the product actually does,
 * not yet reviewed by a lawyer. The banner says so rather than implying review
 * that has not happened.
 */
export const legalRoutes = new Hono<AppEnv>();

const UPDATED = '22 August 2026';

const Shell = ({
  title,
  children,
}: {
  title: string;
  children: unknown;
}) => (
  <html lang="en">
    <Head title={title} />
    <body>
      <header class="site-head">
        <div class="container site-head-inner">
          <a class="brand" href="/">
            <Logo />
            Speak to my Agent
          </a>
          <nav class="site-nav">
            <a class="plain" href="/docs">
              Docs
            </a>
            <a class="btn btn-sm" href="/login">
              Sign in
            </a>
          </nav>
        </div>
      </header>

      <main class="container page" style="max-width:760px">
        <div>
          <h1 class="title" style="font-size:30px">
            {title}
          </h1>
          <p class="sub">Last updated {UPDATED}</p>
        </div>

        <div class="banner banner-warn" style="margin-bottom:22px">
          <span class="ic">!</span>
          <span>
            Private beta draft — accurate about how the service behaves today, but not yet
            reviewed by counsel. Questions: <b>legal@stma.ai</b>.
          </span>
        </div>

        {children}

        <p class="m0 small muted" style="margin-top:28px">
          Matte AI LLC · 30 N Gould St, # 47622, Sheridan, WY 82801, USA
        </p>
      </main>

      <footer class="site-foot">
        <div class="container site-foot-inner">
          <span>© 2026 STMA · Speak to my Agent — private beta</span>
          <span>
            <a class="plain" href="/terms" style="color:var(--mut)">
              Terms
            </a>{' '}
            ·{' '}
            <a class="plain" href="/privacy" style="color:var(--mut)">
              Privacy
            </a>
          </span>
        </div>
      </footer>
    </body>
  </html>
);

const Clause = ({ n, head, children }: { n: number; head: string; children: unknown }) => (
  <section class="doc-section" style="margin-top:26px">
    <h2 style="font-size:18px">
      {n}. {head}
    </h2>
    {children}
  </section>
);

legalRoutes.get('/terms', (c) =>
  c.html(
    <Shell title="Terms of Service">
      <p class="m0">
        These terms cover STMA ("the Service"), operated by Matte AI LLC ("we"). Using the
        Service means accepting them.
      </p>

      <Clause n={1} head="What the Service is">
        <p class="m0">
          A collaboration control plane for AI coding agents: environment snapshots, environment
          comparison, debug sessions, announcements, and an agent fleet layer covering runs, work
          claims, policies and environment preflight. It is in private beta.
        </p>
      </Clause>

      <Clause n={2} head="Accounts, teams and tokens">
        <p class="m0">
          You are responsible for your credentials and for personal access tokens you issue. A
          token acts as you. Team owners control membership, invites, inbound hook URLs and
          webhooks. Tell us promptly if you believe a token has leaked; you can revoke one
          yourself at any time.
        </p>
      </Clause>

      <Clause n={3} head="Acceptable use">
        <p class="m0">
          Do not attempt to reach another team's data, exceed the documented rate limits with
          automated traffic, or resell the Service. Agent traffic must remain attributable to a
          human who owns it. The Elastic License 2.0 governs the source code, including the
          restriction on offering STMA to third parties as a competing hosted service.
        </p>
      </Clause>

      <Clause n={4} head="Your content">
        <p class="m0">
          You keep all rights to what your team submits — snapshots, messages, policies, sessions.
          You grant us only what running the Service requires: storing it, showing it to your
          team, and keeping backups. We do not use your content to train models.
        </p>
      </Clause>

      <Clause n={5} head="Privacy by design">
        <p class="m0">
          The Service is built so that environment variable <i>values</i> and source code are not
          collected — snapshots carry names, versions, hashes and git metadata only. See the{' '}
          <a href="/privacy">privacy policy</a>.
        </p>
      </Clause>

      <Clause n={6} head="Availability">
        <p class="m0">
          Beta, provided as is, with no service level commitment. We may change or withdraw
          features; anything that would break how you work gets reasonable notice. Deployments
          currently involve a brief restart.
        </p>
      </Clause>

      <Clause n={7} head="Ending it">
        <p class="m0">
          Delete your team or your account whenever you like, from the app. We may suspend an
          account that breaks these terms. On deletion, team-scoped data is removed immediately;
          content you authored stays attributed to a scrubbed account so your teammates' threads
          remain readable.
        </p>
      </Clause>

      <Clause n={8} head="Liability">
        <p class="m0">
          To the maximum extent the law allows, our total liability is limited to what you paid us
          in the preceding twelve months, and we are not liable for indirect or consequential
          loss. Work claims are advisory signals, not locks — they warn about collisions and do
          not prevent them.
        </p>
      </Clause>

      <Clause n={9} head="Governing law">
        <p class="m0">
          Wyoming, USA. Rights you hold under mandatory local law, including data protection
          rights, are unaffected.
        </p>
      </Clause>

      <Clause n={10} head="Changes">
        <p class="m0">
          Material changes are announced to account addresses at least 14 days ahead. The date at
          the top always reflects the current version.
        </p>
      </Clause>
    </Shell>,
  ),
);

legalRoutes.get('/privacy', (c) =>
  c.html(
    <Shell title="Privacy Policy">
      <p class="m0">
        Matte AI LLC is the controller for personal data processed by STMA. This describes what
        the Service collects and why — and, just as importantly, what it deliberately does not.
      </p>

      <Clause n={1} head="What we collect">
        <ul class="doc-list">
          <li>
            <b>Account</b>: email address, a scrypt hash of your password (or a GitHub id if you
            sign in that way), display name.
          </li>
          <li>
            <b>Team and project metadata</b>: names, membership, invites, personal access token
            names and hashes.
          </li>
          <li>
            <b>Environment snapshot metadata</b>: tool and runtime versions, lockfile hashes,
            environment variable <b>names</b>, git branch, commit and dirty-file paths, OS and
            timezone.
          </li>
          <li>
            <b>Content your team creates</b>: debug session messages and attachments,
            announcements, policies, work claims and run records.
          </li>
          <li>
            <b>Operational records</b>: request logs (method, path, status, duration, account, IP),
            error records, and delivery records for notification emails.
          </li>
        </ul>
      </Clause>

      <Clause n={2} head="What we deliberately do not collect">
        <p class="m0">
          Environment variable values. Source code and file contents. Secrets of any kind. This is
          a structural property of how snapshots are built, not a promise about handling. Message
          bodies, attachments and error records additionally pass through server-side redaction
          for common credential shapes before storage.
        </p>
      </Clause>

      <Clause n={3} head="Why we process it">
        <p class="m0">
          To provide the Service you signed up for (contract), to keep it secure and working
          (legitimate interests), and to send the notifications you choose (your settings, which
          you can change at any time).
        </p>
      </Clause>

      <Clause n={4} head="Where it lives">
        <p class="m0">
          The European Union — Microsoft Azure, North Europe. Backups stay in the same region.
        </p>
      </Clause>

      <Clause n={5} head="Who else touches it">
        <p class="m0">
          Microsoft Azure (hosting and database) and Resend (notification email). If billing
          launches, Stripe will handle payments and card details will never reach our servers. We
          do not sell data and there are no advertising trackers.
        </p>
      </Clause>

      <Clause n={6} head="How long we keep it">
        <ul class="doc-list">
          <li>Snapshots: 90 days by default, and only the most recent per machine and project.</li>
          <li>Resolved debug sessions: kept as your team's archive until you delete them.</li>
          <li>Operational logs and error records: 30 days.</li>
          <li>Account data: until you delete the account.</li>
        </ul>
      </Clause>

      <Clause n={7} head="Your rights">
        <p class="m0">
          Access, correction, deletion, portability and objection. Deleting your team or account
          from the app satisfies most of these immediately; for anything else, write to{' '}
          <b>privacy@stma.ai</b> and we will answer within 30 days. You may also complain to your
          local data protection authority.
        </p>
      </Clause>

      <Clause n={8} head="Cookies">
        <p class="m0">
          One session cookie, httpOnly and SameSite=Lax, plus a short-lived cookie during sign-in
          verification. Nothing for advertising or cross-site analytics.
        </p>
      </Clause>

      <Clause n={9} head="Contact">
        <p class="m0">
          <b>privacy@stma.ai</b> — Matte AI LLC, 30 N Gould St, # 47622, Sheridan, WY 82801, USA.
          Security reports go to <b>security@stma.ai</b>.
        </p>
      </Clause>
    </Shell>,
  ),
);
