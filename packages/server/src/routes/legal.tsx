import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../types';
import { SitePage, siteInfo, type SiteInfo } from '../ui/Site';
import { Mail } from '../ui/Mail';

/**
 * The Terms of Service and the Privacy Policy of the hosted service at stma.ai.
 * Public and unauthenticated, linked from every signed-out footer.
 *
 * These are the published texts, not a draft. Every sentence that says what the
 * Service does was checked against the code on the day it was written — the
 * cookie names and lifetimes (`auth/session.ts`, `auth/codes.ts`,
 * `routes/auth.tsx`, `routes/dashboard.tsx`), the retention defaults (`env.ts`,
 * `lib/cleanup.ts`, `lib/entitlements.ts`), what the logs carry (`app.tsx`,
 * `lib/log.ts`, `lib/mailer.ts`), what account deletion erases
 * (`routes/dashboard.tsx`) and who else touches the data. A change to any of
 * those is a change to these pages, in the same commit.
 *
 * The addresses are Matte AI's and are written here rather than read from
 * `SUPPORT_EMAIL` / `PRIVACY_EMAIL`: on an instance somebody else runs, those
 * name that operator, while these documents stay ours whichever server renders
 * them. That server says so above both documents instead.
 */
export const legalRoutes = new Hono<AppEnv>();

/**
 * The day each document's current version took effect. A new revision of one
 * changes its own date and leaves the other's alone: the Privacy Policy gained
 * emailed invitations on 24 September 2026 and the Terms did not change.
 */
const TERMS_EFFECTIVE = '23 September 2026';
const PRIVACY_EFFECTIVE = '24 September 2026';
const SUPPORT = 'support@matteai.com';
const PRIVACY = 'gdpr@matteai.com';
/**
 * One technical mailbox, not two. `security@stma.ai` was written into these
 * documents before anybody checked whether it existed, and it does not: a
 * reported vulnerability would have bounced, which is worse than having no
 * address at all. Everything technical, a vulnerability report included, goes
 * to the address a person actually reads (owner's decision, 2026-09-23). Only
 * data-protection requests are separate, because the law names that route.
 */
const SECURITY = SUPPORT;
const COMPANY = 'Matte AI LLC';
const ADDRESS = '30 N Gould St, # 47622, Sheridan, WY 82801, USA';

type Section = { id: string; head: string; body: Child };

// The address stays legible: ui/Mail.tsx says why the comment pair is there.

/** A paragraph with a bold run-in heading. */
const P = ({ head, children }: { head?: string; children: Child }) => (
  <p class="m0">
    {head ? <b>{head} </b> : null}
    {children}
  </p>
);

const List = ({ children }: { children: Child }) => <ul class="doc-list">{children}</ul>;

const Table = ({ head, rows }: { head: string[]; rows: Child[][] }) => (
  <div class="card scroll-x">
    <table class="tbl">
      <tr>
        {head.map((h) => (
          <th>{h}</th>
        ))}
      </tr>
      {rows.map((row) => (
        <tr>
          {row.map((cell) => (
            <td>{cell}</td>
          ))}
        </tr>
      ))}
    </table>
  </div>
);

/**
 * Shown only where this is not the hosted service. The documents below are
 * Matte AI's; on somebody else's instance they describe a different service,
 * and the person reading them needs to know whose rules apply here.
 */
const SelfHostNote = () => (
  <div class="banner banner-info" role="note">
    <span class="ic">i</span>
    <span>
      This server is not the hosted STMA service. The documents below describe the service {COMPANY}{' '}
      runs at stma.ai. On an instance run by someone else, that operator's own terms and privacy
      notice apply, and that operator, not {COMPANY}, is the controller of the personal data it
      holds.
    </span>
  </div>
);

const LegalDocument = ({
  site,
  title,
  description,
  effective,
  intro,
  sections,
}: {
  site: SiteInfo;
  title: string;
  description: string;
  effective: string;
  intro: Child;
  sections: Section[];
}) => (
  <SitePage site={site} title={title} description={description} active="legal">
    <main class="container page legal" style="max-width:808px">
      <div>
        <h1 class="title" style="font-size:30px">
          {title}
        </h1>
        <p class="sub">
          Effective {effective} · Last updated {effective}
        </p>
      </div>
      {site.hosted ? null : <SelfHostNote />}
      {intro}
      <nav aria-label="Contents">
        <ol class="legal-toc">
          {sections.map((section) => (
            <li>
              <a href={`#${section.id}`}>{section.head}</a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section, index) => (
        <section class="doc-section" id={section.id}>
          <h2 style="font-size:18px">
            {index + 1}. {section.head}
          </h2>
          {section.body}
        </section>
      ))}
      <p class="m0 small muted" style="margin-top:12px">
        {COMPANY} · {ADDRESS}
      </p>
    </main>
  </SitePage>
);

// ------------------------------------------------------------------- terms

const termsSections = (): Section[] => [
  {
    id: 'service',
    head: 'The Service',
    body: (
      <>
        <P head="What STMA is.">
          STMA is an operations layer for teams that build software with coding agents such as
          Claude Code, Codex, Cursor or any other client that speaks the Model Context Protocol
          (MCP). It shows every agent run on a live map; warns agents before two of them reach for
          the same files and says which run keeps the right of way; delivers the rules a team
          publishes to every run and records whether each run confirmed them; lets a person or an
          agent assign work to a named agent, and lets an agent hand its work over with a verified
          git checkpoint; records and compares the environments of different machines; and keeps
          evidence of what each run did. It also includes Knowledge, delivery flows, integrations
          with GitHub, Azure DevOps, Jira and ClickUp, and email and webhook notifications.
        </P>
        <P>In these Terms:</P>
        <List>
          <li>
            <b>Service</b> means the hosted service at stma.ai: its website, web console, MCP
            endpoint and APIs, the email it sends and its documentation.
          </li>
          <li>
            <b>Workspace</b> means a space in the Service that its members share. Parts of the
            product call it a team. Each workspace has one or more <b>owners</b>; everyone else in
            it is a <b>member</b>.
          </li>
          <li>
            <b>Agent</b> means a coding agent or other software that you connect to the Service with
            a credential issued for it.
          </li>
          <li>
            <b>Credential</b> means anything the Service issues that lets software act for an
            account: OAuth tokens, personal access tokens and one-time connection codes.
          </li>
          <li>
            <b>Customer Content</b> means everything submitted to a workspace by its members or
            their agents: messages and their attachments, assignments and handoff briefs,
            environment snapshots, run records, policies, Knowledge records and anything imported
            into them.
          </li>
          <li>
            <b>Client Software</b> means software we make available for you to run on your own
            machines, such as the <code>stma</code> command-line tool and the hooks it installs.
          </li>
          <li>
            <b>You</b> means the person using the Service and, where that person accepts these Terms
            for an organization, that organization.
          </li>
        </List>
      </>
    ),
  },
  {
    id: 'eligibility',
    head: 'Eligibility and authority',
    body: (
      <>
        <P>
          You must be at least 16 years old and legally able to accept these Terms. The Service is
          built for software development work.
        </P>
        <P>
          If you accept these Terms for a company or another organization, you confirm that you have
          the authority to bind it. The organization is then responsible for how the people it lets
          into its workspaces use the Service.
        </P>
        <P>
          You may not use the Service if the sanctions or export control laws that apply to us
          prohibit us from providing it to you.
        </P>
      </>
    ),
  },
  {
    id: 'accounts',
    head: 'Accounts and credentials',
    body: (
      <>
        <P head="Your account.">
          Use an email address you control and keep it current: sign-in codes, password resets and
          notices about your account are sent there. Keep your password secret. Each account is for
          one person; do not share it.
        </P>
        <P head="Credentials for agents.">
          A credential lets software act with the authority of the account that created it, within
          the reach chosen when it was issued: one project, one workspace or, only if you choose it,
          every workspace you belong to. Treat credentials as secrets. Do not paste them into chats,
          prompts, messages, issues or repositories. You can see and revoke your agent connections
          at any time from the Agent connections page.
        </P>
        <P head="Responsibility.">
          You are responsible for what is done through your account and your credentials, unless it
          results from our breach of these Terms. If you believe your account or a credential has
          been compromised, revoke the credential and tell us at <Mail to={SUPPORT} />. Report a
          vulnerability in the Service to <Mail to={SECURITY} />.
        </P>
        <P head="Workspace owners.">
          The owners of a workspace decide who belongs to it and in which role, which integrations
          and webhooks it uses, which rules it publishes and whether it is deleted. Removing a
          member ends that person's access to the workspace, including through the credentials they
          issued.
        </P>
      </>
    ),
  },
  {
    id: 'agents',
    head: 'Agents act on your behalf',
    body: (
      <>
        <P head="You are responsible for your agents.">
          You decide which agents to connect and what to ask of them. What an agent does with a
          credential issued from your account is done on your behalf, and you are responsible for
          it as if you had done it yourself: the messages it posts, the work it claims, assigns or
          hands over, and every change it makes to your code, repositories and other systems.
        </P>
        <P head="The Service runs nothing on your machines.">
          It cannot read your files by itself. It receives only what your agents, the Client
          Software and the integrations you connect send to it. Client Software you choose to
          install runs on your machine, under your control and with the permissions you give it.
        </P>
        <P head="Signals, not locks.">
          Work claims, collision warnings, right of way, approval rules, change budgets, readiness
          and preflight results and policy receipts help people and agents coordinate. They are not
          locks, and they do not guarantee that two agents will not change the same thing, that a
          rule was followed or that an environment is correct. Where you install the hooks, a write
          guard can stop an edit made through the file-editing tools of supported clients; it does
          not stop shell commands, other tools or changes made outside those clients.
        </P>
        <P head="Information, not instructions.">
          A message, brief, assignment, handoff or Knowledge record written by another person or by
          their agent is information, not an instruction from us. Checkpoints, receipts and
          evidence packs record what clients reported and what connected providers returned; they
          do not certify that code is correct, secure, reviewed or compliant.
        </P>
        <P head="Third-party agents.">
          Your agents, the models behind them and the clients you run them in are provided by third
          parties under your own agreements with them. We are not responsible for what they do or
          produce, or for their usage limits and costs.
        </P>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    head: 'Acceptable use',
    body: (
      <>
        <P>You must not, and must not let an agent or anyone else:</P>
        <List>
          <li>access, or try to access, a workspace, account or data you have not been given;</li>
          <li>
            get around authentication, access scopes, plan limits or rate limits, or send more
            automated traffic than the documented limits allow;
          </li>
          <li>
            run automated vulnerability scanners against the Service, or test it in a way that
            reaches data belonging to anyone else;
          </li>
          <li>
            interfere with the Service or the infrastructure it runs on, or use it to distribute
            malware or send unsolicited messages;
          </li>
          <li>
            submit content that is unlawful, that infringes the rights of others, or that you have
            no right to share;
          </li>
          <li>
            connect an agent that is not tied to the account of a person who is responsible for it,
            or share one account between several people;
          </li>
          <li>
            resell, sublicense or provide the Service to third parties, or use it to build a
            competing product;
          </li>
          <li>use the Service in breach of any law, including export control and sanctions laws.</li>
        </List>
        <P>
          Your use of STMA's source code, as opposed to the hosted Service, is governed by the
          licence described in <a href="#ip">Intellectual property and licences</a>.
        </P>
      </>
    ),
  },
  {
    id: 'content',
    head: 'Your content',
    body: (
      <>
        <P head="You keep your rights.">
          You, or the organization you act for, keep all rights in Customer Content. We claim no
          ownership of it.
        </P>
        <P head="The licence you give us.">
          You give {COMPANY} a worldwide, non-exclusive, royalty-free licence to host, store, copy,
          transmit, display and otherwise process Customer Content only as needed to provide,
          secure and support the Service, to carry out what you ask the Service to do (for example,
          posting a comment to a tracker you connected) and to comply with the law. The licence ends
          when the content is deleted from the Service, except for copies that remain in backups
          until those expire.
        </P>
        <P head="Who sees it.">
          Customer Content in a workspace is visible to the workspace's members and to agents whose
          credentials reach it.
        </P>
        <P head="Your responsibilities.">
          You are responsible for Customer Content and for having the rights, and any notices or
          permissions the law requires, to submit it, including personal data about other people.
          Environment snapshots carry the names of environment variables and never their values,
          but messages, attachments, briefs and Knowledge records hold whatever is typed into them.
          Do not put secrets or passwords in them. The Service redacts common credential formats
          before it stores messages, but redaction cannot catch everything. If a secret reaches us
          anyway, write to <Mail to={SECURITY} /> and we will remove it.
        </P>
        <P head="What we do not do with it.">
          We do not sell Customer Content, use it for advertising, send it to any AI model provider
          or use it to train AI models.
        </P>
        <P head="Removal.">
          We may remove content, or suspend access to it, if we reasonably believe it breaks these
          Terms or the law, or if a court or an authority requires it. Where we can, we tell the
          workspace's owners first.
        </P>
      </>
    ),
  },
  {
    id: 'data-protection',
    head: 'Personal data and our role',
    body: (
      <>
        <P>
          Our <a href="/privacy">Privacy Policy</a> explains what personal data we process, why, for
          how long, and the rights you have.
        </P>
        <P head="As controller.">
          {COMPANY} is the controller of the personal data it processes to run the Service for you:
          accounts and sign-in, security, billing, support, correspondence and operational records.
        </P>
        <P head="As processor.">
          For personal data contained in Customer Content, {COMPANY} processes the data on behalf of
          the owner of the workspace, or the organization it acts for, which decides what goes into
          the workspace and why. We process it only to provide the Service as these Terms and the
          Service's features describe and as the owner otherwise instructs us in writing; keep it
          confidential; protect it with the measures described in the Privacy Policy; use only the
          service providers listed there, updating that list before a new one starts processing
          Customer Content; help the owner respond to requests from the people the data is about;
          tell the owner without undue delay about a personal data breach affecting the workspace;
          and delete it when the workspace is deleted, subject to backups.
        </P>
        <P head="Data processing agreements.">
          If you need a data processing agreement under Article 28 of the GDPR, the UK GDPR or the
          KVKK, write to <Mail to={PRIVACY} /> and we will put one in place with you.
        </P>
      </>
    ),
  },
  {
    id: 'beta',
    head: 'Beta and free use',
    body: (
      <>
        {/* Written so it holds whichever door is open. How an account is
            created is a product detail that changes — it changed on
            2026-09-23, when the beta went from invitation-only to public —
            and a clause that has to be revised every time that happens is a
            clause that will one day be wrong. */}
        <P head="The beta.">
          The Service is in beta. While the beta runs we charge nothing for the Service, and no plan
          limit applies except how long activity history is kept, which follows the plan the
          workspace is on, normally the free plan (see the{' '}
          <a href="/privacy#retention">Privacy Policy</a>). How accounts are created, and whether an
          invitation or a code is needed, can change while the beta runs.
        </P>
        <P head="As it is.">
          Beta and free use are provided as they are. Features, limits and availability can change,
          and parts of the Service may be marked as a preview.
        </P>
        <P head="When the beta ends.">
          We will email account holders at least 14 days before the beta ends. After that,
          each workspace continues on its own plan, which is the free plan unless the workspace has
          bought or been given another, with that plan's limits.
        </P>
      </>
    ),
  },
  {
    id: 'payment',
    head: 'Paid plans and payment',
    body: (
      <>
        <P head="Plans.">
          Paid plans and their prices are published at{' '}
          <a href="https://stma.ai/pricing">stma.ai/pricing</a> once they are on sale. A plan is bought for a workspace by one of its owners. Enterprise plans
          are sold under a separate written order; where an order and these Terms conflict, the
          order prevails.
        </P>
        <P head="Payment through Stripe.">
          Payments are processed by Stripe on a checkout page that Stripe hosts. Card and billing
          details are entered with Stripe and never reach our servers; we receive identifiers and
          the status of your subscription. Stripe may act as the seller of your subscription
          (merchant of record). Where it does, the checkout says so, Stripe charges you and handles
          the taxes, receipts and payment disputes for that purchase under the terms it shows you,
          and we remain responsible for providing the Service under these Terms.
        </P>
        <P head="Billing, renewal and cancellation.">
          Subscriptions are billed in U.S. dollars, in advance, monthly or yearly, and renew
          automatically for the same period until cancelled. An owner can cancel at any time from
          the workspace's Plan &amp; billing page. Cancellation takes effect at the end of the
          current billing period: the workspace keeps the paid plan until then and afterwards
          returns to the free plan.
        </P>
        <P head="Changes during a subscription.">
          A change of plan or billing period made from Plan &amp; billing is prorated, and a change
          that needs a payment takes effect once that payment succeeds. On the Team plan, members beyond
          those the plan includes are charged per person: adding one is invoiced for the rest of the
          billing period, and removing one is credited against later invoices. Agents, devices and
          runs are never charged as members.
        </P>
        <P head="Failed payments.">
          If a payment fails, the paid plan stays in place while Stripe retries it. If it still
          fails, the subscription ends and the workspace returns to the free plan.
        </P>
        <P head="Taxes.">
          Prices do not include taxes unless the checkout says they do. You are responsible for the
          taxes that apply to your purchase, other than taxes on our income. Where the seller must
          collect tax on your purchase, it is charged in addition to the price.
        </P>
        <P head="Price changes.">
          We may change our prices. A new price applies to an existing subscription only from the
          first renewal at least 30 days after we have emailed the workspace's owners about it, and
          you can cancel before it applies.
        </P>
        <P head="Refunds.">
          Fees already paid are not refundable, and we do not give refunds or credits for part of a
          billing period, unused time or a move to a lower plan, except where these Terms say
          otherwise or the law requires it. If you buy as a consumer, the law where you live may give
          you rights that these Terms cannot limit, such as a right to withdraw from the purchase
          within a set period; nothing here takes them away. Refund requests go to{' '}
          <Mail to={SUPPORT} />.
        </P>
        <P head="Complimentary plans.">
          We may give a workspace a plan free of charge, with or without an end date. When it ends,
          the workspace returns to its own plan and that plan's limits.
        </P>
        <P head="Moving to a plan that keeps less history.">
          When a workspace moves to a plan with a shorter history limit, for example when a paid or
          complimentary plan ends, activity and agent-event history older than the new limit is
          deleted at the next cleanup, which runs every six hours. Export what you need first.
        </P>
      </>
    ),
  },
  {
    id: 'availability',
    head: 'Availability, support and changes to the Service',
    body: (
      <>
        <P>
          We work to keep the Service available and secure, but we do not promise that it will be
          uninterrupted or free of errors, and unless a signed order says otherwise there is no
          service level commitment. Updates can briefly interrupt the Service.
        </P>
        <P>
          We may change the Service, add features and remove or replace them. If we remove something
          a paid plan depends on in a way that materially reduces what you paid for, we will tell the
          workspace's owners at least 30 days in advance, unless the change is needed sooner for
          security or legal reasons.
        </P>
        <P>
          Support is by email at <Mail to={SUPPORT} />. We answer as soon as we reasonably can.
        </P>
        <P>
          We may stop providing the Service altogether with at least 30 days' notice by email. If we
          do, we will refund any fees paid in advance for the time after it ends.
        </P>
      </>
    ),
  },
  {
    id: 'termination',
    head: 'Suspension and termination',
    body: (
      <>
        <P>
          You can stop using the Service at any time. You can delete your account from the Account
          page, and an owner can delete a workspace from its settings.
        </P>
        <P>
          We may suspend or end your access, a credential or a workspace if you seriously or
          repeatedly break these Terms, if the law requires it, or if it is needed to protect the
          Service, other customers or third parties from harm or a security threat. Unless the law
          or the urgency of the situation prevents it, we tell you first and give you a reasonable
          chance to put things right.
        </P>
        <P>
          A workspace with a paid subscription that has not yet ended can be deleted only after the
          subscription has been cancelled and its paid period is over.
        </P>
        <P>
          The sections that by their nature should continue after these Terms end, including those
          on content, confidentiality, disclaimers, limitation of liability, indemnity and governing
          law, continue.
        </P>
      </>
    ),
  },
  {
    id: 'deletion',
    head: 'Deletion and your data',
    body: (
      <>
        <P head="Deleting a workspace">
          removes everything in it from our live database at once and permanently: debug sessions
          and messages, snapshots, agent runs and their records, policies, baselines, delivery
          flows, Knowledge, integrations and their stored credentials, activity and invitations.
          Credentials scoped to that workspace are deleted with it. Copies remain in database
          backups until those expire, within 30 days.
        </P>
        <P head="Deleting your account">
          signs you out everywhere, revokes your credentials, removes your agent connections
          together with their run records, and ends your workspace memberships. Your email address,
          password hash, username, name, avatar and GitHub link are erased from the account record,
          which is kept without them so that what you contributed stays attributed to a deleted
          account. Content you contributed to workspaces, such as messages, the sessions you opened,
          snapshots and Knowledge records, stays with those workspaces as part of their shared
          record; snapshots are deleted when they reach their 90-day limit, and activity entries
          when they reach the workspace's history limit. Before you can delete your account you
          must hand over or delete every workspace of which you are the only owner, and finish your
          active agent runs.
        </P>
        <P head="Copies.">
          An owner can export a workspace's activity log as a CSV file before deleting it. If you
          need a copy of other data, write to <Mail to={SUPPORT} /> before you delete anything.
        </P>
      </>
    ),
  },
  {
    id: 'confidentiality',
    head: 'Confidentiality',
    body: (
      <>
        <P>
          We treat Customer Content as confidential. Our people and the providers who help us run
          the Service may access it only when that is needed to provide, secure or support the
          Service, when you ask us to, or when the law requires it, and they are bound to keep it
          confidential. If the law requires us to disclose Customer Content, we tell the
          workspace's owners first where we are allowed to.
        </P>
        <P>
          You will keep confidential any non-public information about the Service that we share
          with you, such as security details or non-public pricing, and use it only to use the
          Service.
        </P>
        <P>
          None of this applies to information that is or becomes public through no fault of the
          party receiving it, that it already knew lawfully, that it develops independently, or
          that it lawfully receives from someone else.
        </P>
      </>
    ),
  },
  {
    id: 'ip',
    head: 'Intellectual property and licences',
    body: (
      <>
        <P head="The Service.">
          The Service, the Client Software and the STMA name and logos belong to {COMPANY} or its
          licensors. These Terms give you a limited, non-exclusive, non-transferable and revocable
          right to access and use the hosted Service in line with these Terms. The hosted Service is
          licensed for use, not sold, and no other rights are granted.
        </P>
        <P head="Source code.">
          STMA's source code is published under the Elastic License 2.0. That licence, not these
          Terms, governs your use of the source code and of software built from it, including
          running your own instance, and it does not allow providing STMA to others as a hosted or
          managed service. Parts of the hosted Service that are not published under that licence
          are licensed to you only as part of the Service.
        </P>
        <P head="Client Software">is distributed under the licence that comes with it.</P>
        <P head="Names and logos.">
          You may use the name STMA to say accurately that you use the Service. Any other use of our
          names and logos needs our written permission.
        </P>
      </>
    ),
  },
  {
    id: 'feedback',
    head: 'Feedback',
    body: (
      <P>
        If you send us suggestions or other feedback, we may use them without any obligation to
        you. Leave out anything confidential that you do not want us to use.
      </P>
    ),
  },
  {
    id: 'third-party',
    head: 'Third-party services',
    body: (
      <>
        <P>
          The Service works with services we do not control: the coding agents and clients you
          connect, integrations such as GitHub, Azure DevOps, Jira and ClickUp, and Slack or Discord
          webhooks. Connecting one authorizes us to exchange data with it on your behalf as the
          integration describes, for example reading issues and tasks, posting a comment when a run
          that names one finishes, committing a pipeline file and registering the pipeline when an
          owner asks for it, receiving pull request and build results, and delivering
          notifications.
        </P>
        <P>
          Your use of those services is governed by their own terms and privacy policies. We are
          not responsible for them or for what they do with the data they receive. Disconnecting an
          integration stops the exchange and deletes the credential we stored; it does not delete
          anything already in the other service.
        </P>
      </>
    ),
  },
  {
    id: 'disclaimers',
    head: 'Disclaimers',
    body: (
      <>
        <P>
          Except as these Terms expressly state, and to the extent the law allows, the Service and
          the Client Software are provided "as is" and "as available", without warranties of any
          kind, whether express or implied, including warranties of merchantability, fitness for a
          particular purpose, title and non-infringement.
        </P>
        <P>
          In particular, we do not warrant that the Service will detect every collision or
          environment difference, that agents will follow the rules, warnings or instructions it
          delivers, or that what it reports is complete or accurate. You remain responsible for
          reviewing, testing and backing up your code, repositories and systems.
        </P>
        <P>
          Nothing in this section limits warranties or rights that cannot be excluded under the law
          that applies to you.
        </P>
      </>
    ),
  },
  {
    id: 'liability',
    head: 'Limitation of liability',
    body: (
      <>
        <P>
          To the extent the law allows, neither party is liable for indirect, incidental, special,
          consequential or punitive damages, or for lost profits, revenue, goodwill or data, arising
          out of or relating to these Terms or the Service, even if it was told they were possible.
        </P>
        <P>
          To the extent the law allows, our total liability for all claims arising out of or
          relating to these Terms or the Service is limited to the greater of (a) the fees paid for
          the Service for the affected workspace or account in the 12 months before the event that
          gave rise to the liability, including fees paid to a seller of record, and (b) USD 100.
        </P>
        <P>
          Nothing in these Terms limits liability for death or personal injury caused by
          negligence, for fraud or wilful misconduct, for your obligation to pay fees or your
          indemnity obligations, or any other liability that the law does not allow to be limited
          or excluded.
        </P>
      </>
    ),
  },
  {
    id: 'indemnity',
    head: 'Indemnity',
    body: (
      <P>
        You will defend {COMPANY}, its members, employees and contractors against any third-party
        claim arising from Customer Content, from what your agents did with your credentials, or
        from your use of the Service in breach of these Terms or the law, and pay the damages, costs
        and reasonable legal fees finally awarded or agreed in a settlement. We will tell you
        promptly about the claim, let you control its defence and settlement, and cooperate
        reasonably at your expense; you may not settle in a way that admits fault on our behalf or
        binds us without our consent. If you are a consumer, this section applies only to the
        extent the law of your country allows.
      </P>
    ),
  },
  {
    id: 'law',
    head: 'Governing law and disputes',
    body: (
      <>
        <P>
          These Terms, and any dispute arising out of or relating to them or the Service, are
          governed by the laws of the State of Wyoming, USA, without regard to its conflict-of-laws
          rules. The United Nations Convention on Contracts for the International Sale of Goods does
          not apply. The state and federal courts located in Wyoming have exclusive jurisdiction,
          and both parties submit to it. Before going to court, write to <Mail to={SUPPORT} /> so
          that we can try to resolve the matter informally within 30 days.
        </P>
        <P>
          If you use the Service as a consumer, you keep the protection of the mandatory laws of the
          country where you live and may bring proceedings in its courts. Nothing in these Terms
          limits your rights under data protection law, including the GDPR and the KVKK, or your
          right to complain to a supervisory authority.
        </P>
      </>
    ),
  },
  {
    id: 'changes',
    head: 'Changes to these Terms',
    body: (
      <P>
        We may update these Terms. If a change is material, we will email account holders at least
        14 days before it takes effect; other changes, such as clarifications or changes the law
        requires, take effect when they are published here. The date at the top shows the current
        version. If you keep using the Service after a change takes effect, the updated Terms apply
        to you; if you do not agree with them, stop using the Service and, if you pay for a plan,
        cancel it.
      </P>
    ),
  },
  {
    id: 'notices',
    head: 'Notices',
    body: (
      <P>
        We send notices to the email address on your account, and notices about a workspace to its
        owners. Send notices to us by email to <Mail to={SUPPORT} />; formal legal notices should
        also be sent by post to {COMPANY}, {ADDRESS}. Data protection requests go to{' '}
        <Mail to={PRIVACY} />; everything else, a security report included, goes to the support
        address above.
      </P>
    ),
  },
  {
    id: 'general',
    head: 'General',
    body: (
      <List>
        <li>
          <b>Assignment.</b> You may not transfer these Terms without our written consent. We may
          transfer them, with notice to you, to an affiliate or to a successor in a merger,
          acquisition or sale of all or most of the business or assets connected with the Service.
        </li>
        <li>
          <b>Entire agreement.</b> These Terms, together with any order form or data processing
          agreement you sign with us, are the entire agreement about the Service and replace any
          earlier version of them. A signed order form prevails over these Terms where they
          conflict.
        </li>
        <li>
          <b>Severability and waiver.</b> If a court finds part of these Terms unenforceable, the
          rest stays in effect. Not enforcing a provision is not a waiver of it.
        </li>
        <li>
          <b>Events beyond control.</b> Neither party is liable for a delay or failure caused by
          events beyond its reasonable control, except for obligations to pay.
        </li>
        <li>
          <b>Relationship.</b> The parties are independent contractors. These Terms create no rights
          for anyone else.
        </li>
        <li>
          <b>Language.</b> These Terms are written in English. If we provide a translation, the
          English version prevails to the extent the law allows.
        </li>
      </List>
    ),
  },
  {
    id: 'contact',
    head: 'Contact',
    body: (
      <>
        <P>
          {COMPANY}, {ADDRESS}.
        </P>
        <List>
          <li>
            Questions, support, billing, security reports and legal notices: <Mail to={SUPPORT} />
          </li>
          <li>
            Data protection requests (GDPR, KVKK): <Mail to={PRIVACY} />
          </li>
        </List>
      </>
    ),
  },
];

// ----------------------------------------------------------------- privacy

const privacySections = (): Section[] => [
  {
    id: 'controller',
    head: 'Who we are',
    body: (
      <P>
        The controller of your personal data is {COMPANY}, {ADDRESS}. For anything about personal
        data, including requests to exercise your rights, write to <Mail to={PRIVACY} />.
        Everything else, a security report included, goes to <Mail to={SUPPORT} />.
      </P>
    ),
  },
  {
    id: 'scope',
    head: 'What this policy covers',
    body: (
      <>
        <P>
          It covers visitors to stma.ai, people with an account, members of workspaces, people whose
          details appear in workspace content, and people we correspond with, including
          prospective customers. It does not cover:
        </P>
        <List>
          <li>
            instances of STMA that someone else runs, including self-hosted installations: their
            operator is responsible for them;
          </li>
          <li>
            the services you connect to STMA, such as your coding agents and their clients, GitHub,
            Azure DevOps, Jira, ClickUp, Slack or Discord, which have their own privacy policies.
          </li>
        </List>
      </>
    ),
  },
  {
    id: 'roles',
    head: 'Our role',
    body: (
      <>
        <P>
          We are the controller for data about your account and its security, billing, support,
          correspondence and the operation of the Service.
        </P>
        <P>
          For personal data in workspace content (messages, snapshots, run records, Knowledge and
          the rest) we act as a processor for the owner of the workspace, or the organization it
          acts for, which decides what goes into the workspace. If your personal data is in a
          workspace that someone else owns, you can ask that owner or us; we pass requests on to the
          owner and help them respond.
        </P>
      </>
    ),
  },
  {
    id: 'data',
    head: 'The personal data we process',
    body: (
      <>
        <P>
          We collect personal data electronically: from you through the website, the console and
          email; from your agents and the <code>stma</code> command-line tool through the MCP
          endpoint and the APIs; from the other members of your workspaces; from the services you
          connect; and from Stripe when you pay.
        </P>
        <List>
          <li>
            <b>Account data:</b> your email address; your password, stored only as a scrypt hash; a
            username taken from your email address, which the members of your workspaces see; a
            display name and avatar if you sign in with GitHub; when you confirmed your email address;
            which beta wave you signed up through where a code was used, never the access code
            itself; and when the account was created.
          </li>
          <li>
            <b>Sign-in with GitHub</b>, only where it is offered: your GitHub user ID, login, name,
            avatar address and primary verified email address. We ask GitHub for no access to your
            repositories.
          </li>
          <li>
            <b>Sign-in and security data:</b> your browser sessions, each with the description your
            browser sends (its user-agent string), the IP address it last came from and when, which
            we show you on your Account page; one-time sign-in and reset codes, stored as hashes;
            and counts of failed sign-in attempts, kept against a hash of the email address rather
            than the address.
          </li>
          <li>
            <b>Workspace data:</b> workspace names, memberships and roles, invitations (with the
            email address an owner sent one to, where it was sent by email) and who
            created them, the plan and its changes, and a record of who joined a workspace, changed
            role or lost access.
          </li>
          <li>
            <b>Agent connections:</b> the agent's name, the device label you choose, the client type
            and version, a device identifier generated on your machine (never its hostname or your
            user name), when it was last seen, and its credentials, stored only as hashes.
          </li>
          <li>
            <b>Workspace content</b>, which we process for the workspace's owner: debug sessions and
            messages with their text attachments; announcements; assignments and handoff briefs;
            policies and environment baselines; Knowledge records, including text imported into
            them; delivery flows; answers in the savings ledger; and the workspace activity log.
          </li>
          <li>
            <b>Agent run data:</b> for each run, its task and intent, repository, branch and commit,
            the location of the checkout on disk as the agent reports it (which can include a user
            name), the files and areas it claims or changes, heartbeats, the usage and cost figures
            it reports, checkpoints and test results, policy receipts, content-rule findings (the
            rule, the file path and the outcome; the matched text never leaves your machine), and
            pull request and build results from connected providers.
          </li>
          <li>
            <b>Environment snapshots:</b> operating system and version, shell, runtime and package
            manager versions, lockfile paths and hashes, the names of environment variables (never
            their values), git branch, commit, uncommitted file paths and ahead/behind state,
            locale, time zone and a device label; and the results of preflight checks.
          </li>
          <li>
            <b>Integration data:</b> the credentials a workspace owner connects, encrypted before
            they are stored; the Atlassian account email used for a Jira connection; repository,
            project, list and site identifiers; and the issue and task details we read or post at
            your request.
          </li>
          <li>
            <b>Notification data:</b> your email notification settings, a personal Slack or Discord
            webhook address if you add one, and a record of each notification's delivery.
          </li>
          <li>
            <b>Billing data</b>, for paid plans: Stripe customer and subscription identifiers, the
            plan, billing period, subscription status, renewal date and number of members. We send
            Stripe the workspace name and the owner's email address. Stripe collects your card,
            billing address and tax number directly; we never receive card numbers.
          </li>
          <li>
            <b>Organization identity data</b>, only where an organization has single sign-on or user
            provisioning set up with us under a separate agreement: the identifier, email address,
            name and role its identity provider sends.
          </li>
          <li>
            <b>Technical and log data:</b> for each request, the time, method, path (with secrets
            removed), status and duration, the signed-in username, the agent connection and its
            scope, your IP address and the version of the <code>stma</code> tool; error records,
            with secrets redacted; and records of the emails we send, with the recipient's address
            masked and the kind of message instead of its subject.
          </li>
          <li>
            <b>Correspondence and business contacts:</b> emails you send us and, for prospective
            customers and design partners we talk to, their name, organization, contact details and
            our notes, in an internal contact list.
          </li>
        </List>
      </>
    ),
  },
  {
    id: 'not-collected',
    head: 'What we deliberately do not collect',
    body: (
      <>
        <List>
          <li>
            <b>Environment variable values.</b> The snapshot format has no field for them, and
            committed templates such as <code>.env.example</code> are skipped.
          </li>
          <li>
            <b>Your files.</b> The Service cannot read your machine. It receives only what your
            agents, the <code>stma</code> tool and your integrations send it. Content rules are
            checked on your machine, and only the rule, the file path and the outcome are reported.
          </li>
          <li>
            <b>Advertising and analytics data.</b> Our pages load no third-party scripts, fonts or
            trackers, and our emails contain no tracking images or tracked links.
          </li>
          <li>
            <b>Data for sale or for AI training.</b> We do not sell personal data or share it for
            advertising, and we do not send workspace content to any AI model provider or use it to
            train AI models.
          </li>
        </List>
        <P>
          Messages, attachments, briefs and Knowledge records can still contain anything people
          type, including code, secrets or personal data. We redact common credential formats
          before storing them, but not everything can be caught.
        </P>
      </>
    ),
  },
  {
    id: 'purposes',
    head: 'Why we use it, and our legal bases',
    body: (
      <>
        <P>
          Each use rests on a ground in Article 6(1) of the GDPR and Article 5(2) of the KVKK (Law
          No. 6698 on the Protection of Personal Data):
        </P>
        <Table
          head={['Purpose', 'GDPR', 'KVKK']}
          rows={[
            [
              'Creating and running your account, workspaces and agent connections, and providing the features you use',
              'Contract, Art. 6(1)(b)',
              'Contract, Art. 5(2)(c)',
            ],
            [
              'Processing workspace content on the owner\'s instructions',
              'As processor, for the owner',
              'As processor, for the owner',
            ],
            [
              'Keeping accounts and the Service secure: sign-in codes, throttling, session lists, logs, rate limits and abuse prevention',
              'Legitimate interests, Art. 6(1)(f)',
              'Legal obligation, Art. 5(2)(ç); legitimate interests, Art. 5(2)(f)',
            ],
            [
              'Sending service email: sign-in and reset codes, security notices and the notifications you can switch off',
              'Contract, Art. 6(1)(b)',
              'Contract, Art. 5(2)(c)',
            ],
            [
              "Sending an invitation to an address an owner of a workspace gives us, on that owner's request, and keeping it until it is used, revoked or expires",
              "Legitimate interests: the owner's in inviting the people they work with, Art. 6(1)(f)",
              'Legitimate interests, Art. 5(2)(f)',
            ],
            [
              'Billing, and keeping tax and accounting records',
              'Contract and legal obligation, Art. 6(1)(b) and (c)',
              'Contract and legal obligation, Art. 5(2)(c) and (ç)',
            ],
            [
              'Answering support requests and other correspondence',
              'Contract or legitimate interests, Art. 6(1)(b) and (f)',
              'Contract or legitimate interests, Art. 5(2)(c) and (f)',
            ],
            [
              'Operating and improving the Service: error records, load and usage statistics, records of plan and membership changes',
              'Legitimate interests, Art. 6(1)(f)',
              'Legitimate interests, Art. 5(2)(f)',
            ],
            [
              'Talking to prospective customers and design partners',
              'Legitimate interests, Art. 6(1)(f)',
              'Legitimate interests, Art. 5(2)(f)',
            ],
            [
              'Complying with the law, and establishing, exercising or defending legal claims',
              'Legal obligation and legitimate interests, Art. 6(1)(c) and (f)',
              'Legal obligation and the protection of a right, Art. 5(2)(ç) and (e)',
            ],
          ]}
        />
        <P>
          Where we rely on legitimate interests, our interest is running a secure and reliable
          service for the people who use it, and growing our business; you can object at any time
          (see <a href="#rights">Your rights</a>). We do not rely on consent for any of these uses.
          You need to give us an email address and a password to create an account; without them we
          cannot provide one.
        </P>
      </>
    ),
  },
  {
    id: 'recipients',
    head: 'Who receives it',
    body: (
      <>
        <P>These service providers process personal data for us:</P>
        <Table
          head={['Provider', 'What it does', 'Where']}
          rows={[
            [
              <b>Microsoft (Azure)</b>,
              'Hosts the application, the database and its backups, and the application logs',
              'European Union: the application, database and backups run in the North Europe region (Ireland)',
            ],
            [
              <b>Cloudflare</b>,
              'DNS, TLS and a proxy in front of stma.ai. Every request passes through it, including your IP address and the details of the request',
              'Worldwide, at the location nearest the visitor; Cloudflare, Inc. is based in the United States',
            ],
            [
              <b>Resend</b>,
              "Sends the Service's email: sign-in codes, security notices, invitations and notifications. It delivers through Amazon Simple Email Service",
              'United States',
            ],
            [
              <b>Stripe</b>,
              'Checkout, payments, subscriptions, invoices and tax for paid plans. Stripe processes payment details under its own privacy policy',
              'United States and other countries where Stripe operates',
            ],
            [
              <b>Google (Google Workspace)</b>,
              'Our email at matteai.com, where support and data protection requests and other correspondence are handled',
              'United States and other countries',
            ],
          ]}
        />
        <P>Personal data also reaches:</P>
        <List>
          <li>
            <b>the services you connect</b>, such as GitHub, Azure DevOps, Jira, ClickUp and your
            Slack or Discord webhooks, which receive what is needed for what you ask them to do,
            under your own agreements with them; and GitHub, when you sign in with it where that is
            offered;
          </li>
          <li>
            <b>the members of your workspaces</b> and their agents, who see what is shared there;
          </li>
          <li>
            <b>our own people</b>, who can see account, workspace, membership and connection details
            in an internal console to run and support the Service. We look at workspace content only
            when it is needed to provide support you ask for, to investigate abuse or a security
            incident, or when the law requires it;
          </li>
          <li>
            <b>professional advisers</b>, such as lawyers and accountants, who are bound to
            confidentiality;
          </li>
          <li>
            <b>authorities</b>, where the law requires us to disclose data and after we have checked
            that the request is valid;
          </li>
          <li>
            <b>a successor</b>, if {COMPANY} or the Service is merged or sold. We will tell you before
            your data becomes subject to a different privacy policy.
          </li>
        </List>
        <P>We do not sell personal data.</P>
      </>
    ),
  },
  {
    id: 'transfers',
    head: 'International transfers',
    body: (
      <>
        <P>
          {COMPANY} is based in the United States. The Service's application, database and backups
          are hosted in the European Union, in Ireland. Some of the providers listed above process
          data in the United States or elsewhere, and the people who run the Service may access data
          from outside the European Union and Turkey.
        </P>
        <P head="GDPR and UK GDPR.">
          Where a transfer needs a safeguard, we rely on the European Commission's standard
          contractual clauses, with the UK addendum where it is needed, as included in our
          providers' data processing terms, or on a provider's certification under the EU-U.S. Data
          Privacy Framework and its UK extension where the provider holds one. You can ask for a copy
          of the safeguards that apply at <Mail to={PRIVACY} />.
        </P>
        <P head="KVKK.">
          Transfers of personal data abroad are governed by Article 9 of the KVKK, which allows them
          on the basis of an adequacy decision of the Personal Data Protection Board, of appropriate
          safeguards such as the standard contracts published by the Board, or, for occasional
          transfers, of the exceptions listed in that article. If you use the Service from Turkey,
          your personal data is processed abroad, in the European Union and in the United States.
          You can ask which ground applies to a particular transfer at <Mail to={PRIVACY} />.
        </P>
      </>
    ),
  },
  {
    id: 'retention',
    head: 'How long we keep it',
    body: (
      <>
        <Table
          head={['Data', 'How long']}
          rows={[
            [
              'Account data',
              'Until you delete your account. Your email address, password hash, username, name, avatar and GitHub link are then erased; the rest of the record is kept so that what you contributed stays attributed to a deleted account',
            ],
            [
              'Browser sessions, with the browser description and IP address stored with them',
              'Until you sign out or end them, and at most 30 days after sign-in',
            ],
            ['One-time sign-in and reset codes', 'Valid for 10 minutes; deleted an hour after they expire'],
            ['Invitations and agent connection codes', 'Deleted 30 days after they expire'],
            [
              'Agent connections',
              'Until you delete your account. A connection you revoke stays on record, marked as revoked; a credential record holds its name and never its secret',
            ],
            [
              'Workspace content, including debug sessions and messages',
              'For the life of the workspace, except as listed below',
            ],
            [
              'Environment snapshots',
              '90 days, and never more than the 20 newest per person, device and project',
            ],
            ['Preflight results', '90 days, and never more than 200 per workspace'],
            [
              'Workspace activity log and agent run trail',
              "Set by the workspace's plan: 90 days on the free plan, which during the beta covers every workspace that has not been given another plan; 365 days on Solo; not removed by age on Team and Enterprise. A cap on the number of entries applies to every plan, and when a workspace moves to a plan with a shorter limit, older history is deleted at the next cleanup",
            ],
            ['Announcements', '180 days, and a cap on the number of messages'],
            [
              'Agent run records',
              'For the life of the workspace; your own runs are deleted with your account',
            ],
            [
              'Records of plan changes and of who joined or left a workspace',
              'For the life of the workspace, within a cap on the number of entries',
            ],
            [
              'Notification settings and a personal webhook address',
              'Until you change or remove them',
            ],
            ['Notification delivery records', '1 day'],
            ['Error records', '30 days'],
            ['Application logs', '30 days'],
            ['Database backups', '30 days; deleted data leaves the backups within that time'],
            [
              'Billing data',
              'For the life of the workspace. Stripe keeps its own records under its policy, and we keep what tax and accounting law requires for as long as it requires',
            ],
            [
              'Correspondence and business contacts',
              'As long as the conversation or relationship needs, and deleted on request unless we need it for a legal claim',
            ],
          ]}
        />
        <P>
          What deleting a workspace or an account removes is described in the{' '}
          <a href="/terms#deletion">Terms of Service</a>.
        </P>
      </>
    ),
  },
  {
    id: 'security',
    head: 'How we protect it',
    body: (
      <>
        <List>
          <li>
            Every connection to stma.ai uses TLS, browsers are told to use HTTPS only, and the
            database accepts only encrypted connections.
          </li>
          <li>
            Passwords are stored as scrypt hashes. Credentials are stored only as hashes and shown
            once, when they are created; one-time codes and agent connection codes are stored only
            as hashes too.
          </li>
          <li>
            Credentials for integrations are encrypted with AES-256-GCM before they are stored, and
            the Service refuses to store a new one without encryption.
          </li>
          <li>
            Agent credentials are scoped to a project or a workspace unless you choose otherwise,
            can be revoked at any time, and OAuth access tokens expire after one hour.
          </li>
          <li>
            Sign-in is protected with emailed codes and a throttle on failed attempts that tells the
            account holder, and you can see and end your browser sessions.
          </li>
          <li>
            Common credential formats are redacted from messages, attachments, error records and
            logs.
          </li>
          <li>
            Our pages load no third-party code, and a content security policy limits what they may
            load.
          </li>
          <li>
            Access to production systems and to the operator console is limited to the people who
            run the Service.
          </li>
          <li>The database is backed up automatically, and backups are kept for 30 days.</li>
        </List>
        <P>
          No system is completely secure. If a personal data breach puts your data at risk, we will
          notify you and the authorities as the law requires.
        </P>
      </>
    ),
  },
  {
    id: 'rights',
    head: 'Your rights',
    body: (
      <>
        <P head="Under the GDPR and the UK GDPR">
          (Articles 15 to 22) you have the right to access your personal data and get a copy; to
          have it corrected; to have it erased; to restrict its processing; to have us tell the
          recipients of a correction, erasure or restriction about it; to receive it in a portable
          format; to object to processing, including processing based on legitimate interests; and
          not to be subject to a decision based solely on automated processing that has legal or
          similarly significant effects on you.
        </P>
        <P head="Under Article 11 of the KVKK">
          you have the right to learn whether your personal data is processed and, if so, to
          request information about it; to learn the purpose of the processing and whether the data
          is used for that purpose; to know the third parties in Turkey or abroad to whom it is
          transferred; to request correction if it is incomplete or inaccurate; to request its
          erasure or destruction under the conditions of Article 7; to request that a correction,
          erasure or destruction be notified to the third parties it was transferred to; to object
          to a result against you that arises from analysis exclusively by automated systems; and to
          claim compensation for damage caused by unlawful processing.
        </P>
        <P head="In the Service.">
          On the Account page you can confirm or change your email address and see or end your
          browser sessions; you can change your notification settings, remove agent connections and
          delete your account; and a workspace owner can export the workspace's activity log as a
          CSV file or delete the workspace.
        </P>
        <P head="By email.">
          For anything else, write to <Mail to={PRIVACY} /> from the email address on your account.
          To protect your data we may ask you to confirm your identity, usually by replying from
          that address, before we act. We answer free of charge, without undue delay and within 30
          days. If a request under the GDPR is complex, we may extend that period by up to two
          months and will tell you so within the first 30 days.
        </P>
        <P head="Applications under the KVKK.">
          Under Article 13 of the KVKK and the Communiqué on the Procedures and Principles of
          Application to the Data Controller, you can apply in writing to our postal address or by
          email to <Mail to={PRIVACY} /> from the email address registered with us. Please give your
          name and surname, your Turkish identity number (or, if you are not a Turkish citizen, your
          nationality and passport or identity number), your address, an email address or telephone
          number where we can reach you, and what you are asking for.
        </P>
        <P head="Complaints.">
          You can complain to a data protection supervisory authority: in the European Union, the
          authority where you live or work or where you believe your rights were infringed; in the
          United Kingdom, the Information Commissioner's Office. In Turkey you can complain to the
          Personal Data Protection Board (Kişisel Verileri Koruma Kurulu) after applying to us
          first, within 30 days of our answer or, if we do not answer within 30 days, within 60 days
          of your application, as Article 14 of the KVKK provides. We would welcome the chance to
          address your concern first at <Mail to={PRIVACY} />.
        </P>
      </>
    ),
  },
  {
    id: 'cookies',
    head: 'Cookies and browser storage',
    body: (
      <>
        <P>
          We use only the cookies the Service needs to work. There are no advertising, analytics or
          cross-site tracking cookies, which is why there is no cookie banner.
        </P>
        <Table
          head={['Cookie', 'What it is for', 'How long']}
          rows={[
            [
              <code>sid</code>,
              'Keeps you signed in. HttpOnly, Secure and SameSite=Lax',
              'Until you sign out, and at most 30 days',
            ],
            [<code>pending</code>, 'Remembers which sign-in code you are entering', '25 minutes'],
            [<code>reset</code>, 'Remembers which password reset code you are entering', '25 minutes'],
            [
              <code>oauth</code>,
              'Protects a sign-in with GitHub while it is in progress, where that is offered',
              '10 minutes',
            ],
            [
              <>
                <code>clickup_connect</code>, <code>clickup_pending</code>
              </>,
              "Protect a workspace owner's ClickUp connection while it is being set up",
              '10 minutes',
            ],
            [
              <code>stma_oidc_browser</code>,
              "Protects a sign-in through an organization's identity provider while it is in progress, where one is set up",
              '10 minutes',
            ],
          ]}
        />
        <P>
          Your browser's session storage also keeps one setting, <code>stma-frozen</code>, which
          remembers whether you paused a live page from refreshing; it never leaves your browser.
          Cloudflare, which sits in front of stma.ai, may set a strictly necessary cookie of its own
          to protect the site from abuse.
        </P>
      </>
    ),
  },
  {
    id: 'children',
    head: 'Children',
    body: (
      <P>
        The Service is not directed at people under 16, and we do not knowingly collect personal
        data from them. If you believe a child under 16 has given us personal data, write to{' '}
        <Mail to={PRIVACY} /> and we will delete it.
      </P>
    ),
  },
  {
    id: 'automated',
    head: 'Automated decisions',
    body: (
      <P>
        We do not make decisions based solely on automated processing that produce legal effects
        concerning you or similarly significantly affect you. The Service applies automatic rules,
        such as rate limits, sign-in throttling, plan limits, collision warnings and policy checks,
        to keep it working and to warn agents; none of them is a decision of that kind.
      </P>
    ),
  },
  {
    id: 'changes',
    head: 'Changes to this policy',
    body: (
      <P>
        We may update this policy. If a change is material, we will email account holders at least
        14 days before it takes effect. The date at the top shows the current version.
      </P>
    ),
  },
  {
    id: 'contact',
    head: 'Contact',
    body: (
      <List>
        <li>
          Data protection (GDPR, KVKK): <Mail to={PRIVACY} />
        </li>
        <li>
          Support, security reports and other questions: <Mail to={SUPPORT} />
        </li>
        <li>
          Post: {COMPANY}, {ADDRESS}
        </li>
      </List>
    ),
  },
];

legalRoutes.get('/terms', (c) =>
  c.html(
    <LegalDocument
      site={siteInfo(c)}
      title="Terms of Service"
      description={`The agreement between you and ${COMPANY} for STMA, the hosted service at stma.ai.`}
      effective={TERMS_EFFECTIVE}
      intro={
        <>
          <P>
            These Terms of Service ("Terms") are an agreement between you and {COMPANY}, a Wyoming
            limited liability company ("we", "us"). They govern your use of STMA ("Speak to my
            Agent"), the hosted service at stma.ai (the "Service").
          </P>
          <P>
            By creating an account, accepting an invitation to a workspace, connecting an agent or
            otherwise using the Service, you accept these Terms. If you do not accept them, do not
            use the Service. Our <a href="/privacy">Privacy Policy</a> explains how we handle
            personal data.
          </P>
        </>
      }
      sections={termsSections()}
    />,
  ),
);

legalRoutes.get('/privacy', (c) =>
  c.html(
    <LegalDocument
      site={siteInfo(c)}
      title="Privacy Policy"
      description="What personal data STMA, the hosted service at stma.ai, processes, why and for how long, and how to exercise your GDPR and KVKK rights."
      effective={PRIVACY_EFFECTIVE}
      intro={
        <P>
          This policy explains how {COMPANY} ("we", "us") processes personal data in connection with
          STMA, the hosted service at stma.ai: its website, web console, MCP endpoint and APIs, and
          the email it sends (the "Service"). It is our notice under Articles 13 and 14 of the GDPR
          and the UK GDPR, and under Article 10 of Turkey's Law No. 6698 on the Protection of
          Personal Data (KVKK).
        </P>
      }
      sections={privacySections()}
    />,
  ),
);
