import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { AppLayout } from '../ui/Layout';
import { SitePage, siteInfo } from '../ui/Site';
import { VERSION } from '../version';
import { Mail, NoScan } from '../ui/Mail';

/**
 * `/help` — the page somebody goes to when it went wrong.
 *
 * **Why it is its own page and not a section of `/docs`.** The guide is written
 * for the person who is succeeding, and its troubleshooting table sits at the
 * bottom of the longest page in the product: nobody stuck scrolls a guide. More
 * decisively, the walls that matter most are the ones in front of the login — a
 * refused access code, a six-digit code that never arrived, a lock that refuses
 * the right password — and a person who cannot sign in cannot read anything
 * behind it. So this is public, unauthenticated and short enough to have a URL
 * somebody can be *told*: "go to /help".
 *
 * **Why the README is not the answer either.** It is the first thing a
 * self-hoster reads and the last thing a hosted beta user does; its failures
 * overlap but are not the same set. The README keeps the operator's half (which
 * it now names), this page keeps the person's.
 *
 * **The teaser rule applies, with the same variable `/docs` uses.** Under
 * `SITE_MODE=teaser` a signed-out reader has no account, so they cannot have an
 * enrollment code or a running agent: every section about connecting and
 * running agents is console content and is hidden, index and table of contents
 * included. The sign-in, self-hosting and "working as intended" sections are
 * always there, because those are precisely the walls a signed-out person hits.
 * Signing in reveals the rest on the same instance — this is not a reduced build.
 *
 * **Every entry quotes what the product prints.** A person is searching for the
 * string on their screen, so an entry leads with it, verbatim, then says what it
 * means and what to do. Entries are data (`helpSections`) so the suite can hold
 * the page to that: `test/console-v2.test.ts` reads the file each quote names and
 * fails when the product stops saying what this page says it says. Nothing is
 * invented to round out a list; where the honest answer is "there is no way to do
 * this yet", it says so.
 */
export const helpRoutes = new Hono<AppEnv>();

/**
 * One message as the page quotes it.
 *
 * `from` names the file that prints it, relative to `packages/`, and `find` the
 * part of `text` that appears in that file character for character — the whole
 * text unless the product builds the message from parts, in which case `text`
 * fills in example values and `find` keeps the fixed wording. A message printed
 * by another program (Claude Code, PowerShell, PGlite, a shell) names it in `by`
 * instead. `hostedOnly` marks words from the private hosted layer, whose source
 * is not in the public tree the suite runs in.
 */
export type HelpQuote = {
  text: string;
  find?: string;
  from?: string;
  by?: string;
  hostedOnly?: boolean;
};

export type HelpEntry = {
  /** The messages, verbatim. An entry groups the ones a single fix answers. */
  quotes?: HelpQuote[];
  /** For a situation with no single message: what the person sees, in words. */
  symptom?: unknown;
  /** Where it appears: browser, terminal, the agent's reply, a server boot. */
  where: string;
  means: unknown;
  todo: unknown;
  /** Only where the hosted billing composition draws its plan pages. */
  billing?: boolean;
  /** Only while the private beta is lifting the ceilings on a hosted instance. */
  beta?: boolean;
};

export type HelpSection = {
  id: string;
  title: string;
  /** One line for the index at the top of the page. */
  blurb: string;
  intro?: unknown;
  /**
   * Console content: hidden from a signed-out stranger on a teaser instance,
   * with its index and contents entries, because it describes a product they
   * cannot have reached yet.
   */
  console: boolean;
  /** Plan ceilings exist only on the hosted service; a self-hoster is never metered. */
  hosted?: boolean;
  entries: HelpEntry[];
};

/**
 * The page's content. A function rather than a constant so every request renders
 * fresh nodes; the suite calls it too, to check each quote against its source.
 *
 * `meter` only decides wording that would otherwise be untrue on one kind of
 * instance; what is *shown* is filtered by the route. The defaults describe the
 * hosted service during its private beta, so a caller that wants the whole
 * inventory — the suite — gets every entry.
 */
export function helpSections(
  meter: { hosted: boolean; beta: boolean } = { hosted: true, beta: true },
): HelpSection[] {
  return [
    {
      id: 'signin',
      title: 'Getting in',
      blurb: 'Access codes, sign-in codes, lock-outs, resets and invitations',
      console: false,
      intro: (
        <>
          This is the half of the product that stands in front of the door, which is why the page
          you are reading needs no account. If you are locked out, everything here can be done from
          where you are.
        </>
      ),
      entries: [
        {
          quotes: [
            {
              text: 'That access code is not valid. Check the email that invited you to the beta.',
              from: 'server/src/routes/auth.tsx',
            },
          ],
          where: 'Browser · sign up',
          means: (
            <>
              The code matches none of the codes this instance was configured with. It is checked{' '}
              <em>before</em> your address is looked at, so the answer says nothing about whether
              you already have an account. A code belongs to a whole group and is never used up, so
              "somebody else already used it" is not the cause.
            </>
          ),
          todo: (
            <>
              Copy the whole code again from the invitation. Spaces around it are ignored; capitals
              are not. If the mail carried a link, open that instead: it fills the field for you.
            </>
          ),
        },
        {
          symptom: (
            <>
              There is no Create account link, and <code>/signup</code> sends you to the sign-in
              page.
            </>
          ),
          quotes: [
            {
              text: "No account yet? This server is invite-only. Ask someone on your team — their agent can create one for you with create_invite, or they can send you the link from the workspace's People tab. Open that link in this browser and it does the rest.",
              find: 'No account yet? This server is invite-only.',
              from: 'server/src/routes/auth.tsx',
            },
          ],
          where: 'Browser · sign in',
          means: <>Registration is closed on this instance. During the private beta that is the normal state.</>,
          todo: (
            <>
              You get in with an access code once the door is open — use the link in the email that
              sent it — or with an invitation from somebody who already has a workspace here: an
              owner makes one on the People tab, or their agent calls <code>create_invite</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'An account with that email already exists — sign in instead.',
              from: 'server/src/routes/auth.tsx',
            },
          ],
          where: 'Browser · sign up',
          means: <>One account per address, and this address has one.</>,
          todo: (
            <>
              <a href="/login">Sign in</a>. If the password is gone, <a href="/forgot">reset it</a>.
            </>
          ),
        },
        {
          quotes: [{ text: 'Invalid email or password.', from: 'server/src/routes/auth.tsx' }],
          where: 'Browser · sign in',
          means: (
            <>
              The password is wrong, no account has that address, or the account was made through
              GitHub and has no password. All three get the same answer on purpose, so the form
              cannot be used to find out who has an account.
            </>
          ),
          todo: (
            <>
              Check both fields. An account made with GitHub signs in with{' '}
              <b>Continue with GitHub</b>, where this instance offers it. Otherwise use{' '}
              <b>Forgot your password?</b> rather than guessing: five wrong passwords lock the
              address, as the next entry describes.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Too many sign-in attempts for this email address. Try again after 14:15 UTC.',
              find: 'Too many sign-in attempts for this email address. Try again after ',
              from: 'server/src/auth/attempts.ts',
            },
            { text: 'Current password is incorrect.', from: 'server/src/routes/dashboard.tsx' },
          ],
          where: 'Browser · sign in, account',
          means: (
            <>
              Five wrong passwords for one address inside a fixed fifteen-minute window lock it, and
              the <em>right</em> password is refused too — a lock a correct guess walks through is
              not a lock. The window is fixed, so the time shown is always on a quarter hour and
              further attempts do not push it back. Every place that checks your password counts
              toward the same lock, including a wrong current password on the Account page.
            </>
          ),
          todo: (
            <>
              Wait until the time shown — never more than fifteen minutes — or{' '}
              <a href="/forgot">reset your password</a>: completing a reset clears the lock, because
              failing to sign in is how most people arrive at the reset form.
            </>
          ),
        },
        {
          symptom: <>The six-digit sign-in code never arrives.</>,
          quotes: [
            {
              text: 'We could not email your sign-in code right now. Try again in a minute — if it keeps failing, contact your operator.',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'Too many sign-in codes were requested for this account. Wait a few minutes, then try again.',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'Too many codes requested. Wait a few minutes, then try again.',
              from: 'server/src/routes/dashboard.tsx',
            },
          ],
          where: 'Email · sign in, account',
          means: (
            <>
              The code is emailed after a correct password, and the six digits are in the{' '}
              <b>subject line</b> on purpose — a phone's notification preview is enough, you do not
              have to open the message. The first message means the mail provider refused the send
              and nobody was signed in; the other two are the limit of three codes of one kind per
              account in fifteen minutes. A refused request sends nothing, so it is not counted
              against you either.
            </>
          ),
          todo: (
            <>
              Check spam, wait if you were asking repeatedly, then use <b>Send a new code</b> on the
              verification page rather than signing in again — and type the newest mail's digits,
              since every new code retires the ones before it. If nothing arrives at all, the
              instance's mail is the suspect rather than your account: write to the address at the
              end of this page, or to whoever runs the instance.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'That code is not right. 2 attempts left.',
              find: 'That code is not right. ',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'Too many wrong codes. Sign in again to get a new one.',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'That code has expired or was already used. Sign in again to get a new one.',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'Your sign-in attempt expired. Enter your email and password again.',
              from: 'server/src/routes/auth.tsx',
            },
          ],
          where: 'Browser · sign in',
          means: (
            <>
              A code is single-use, lasts ten minutes and allows five attempts, and a newer code
              replaces the older one. The sign-in waiting for it belongs to the browser that started
              it and lasts about twenty-five minutes.
            </>
          ),
          todo: (
            <>
              Go back to <a href="/login">sign in</a> for a fresh code, in the same browser, and type
              the newest mail's digits — an older message in the inbox is the usual reason they do
              not match.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'If that address has an account with a password, a 6-digit reset code is on its way. It expires in 10 minutes.',
              from: 'server/src/routes/auth.tsx',
            },
            {
              text: 'That code is not right, or it expired. Request a new one.',
              from: 'server/src/routes/auth.tsx',
            },
          ],
          where: 'Browser · password reset',
          means: (
            <>
              The first answer is the same for every address, so the form never says who has an
              account; after three requests in fifteen minutes nothing more is sent. A reset code
              belongs to the browser that asked for it, held in a cookie: the second message is what
              another device gets, or the same browser after twenty-five minutes.
            </>
          ),
          todo: (
            <>
              Check spam, and finish in the browser you asked from. If the code reached your phone
              and you asked on your laptop, open the link in the reset email on the phone and finish
              there — the link carries the request, never the code. Or ask for a fresh code from the
              browser you want to use.
            </>
          ),
        },
        {
          symptom: (
            <>
              <code>/forgot</code> and <code>/reset</code> answer 404.
            </>
          ),
          where: 'Browser · password reset',
          means: (
            <>
              Self-service reset needs a mailbox to deliver to, and this instance has email switched
              off.
            </>
          ),
          todo: (
            <>
              On a server somebody you know runs, ask them — the operator can reset an account from
              the admin console. If the server is yours, configure email (<code>RESEND_API_KEY</code>
              ) before you invite anyone; until then, that console is the only way back into an
              account.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'you@example.com has not been confirmed. Sign-in codes and password resets go there and nowhere else, so if it is wrong, nobody can get this account back.',
              find: 'has not been confirmed. Sign-in codes and password resets go there and',
              from: 'server/src/ui/Console.tsx',
            },
          ],
          where: 'Console · every page',
          means: (
            <>
              No code from STMA has reached the address on the account yet. Everything that
              recovers an account goes to that address, so a typo in it is how an account is lost
              for good.
            </>
          ),
          todo: (
            <>
              Press <b>Confirm it</b>, then <b>Email me a code</b>, and enter the six digits. If the
              address is wrong, choose <b>Use a different address</b> there instead: the code goes
              to the new address, and the old one is told.
            </>
          ),
        },
        {
          quotes: [
            { text: 'invite code is invalid, expired or used up', from: 'server/src/routes/api.ts' },
            { text: 'This invite link is no longer valid', from: 'server/src/routes/dashboard.tsx' },
          ],
          where: 'Browser · invite',
          means: (
            <>
              The invitation expired (links from the People tab last seven days), was revoked, or
              has been used as many times as it allows. A workspace at its member limit answers with
              a different message, <code>Team member limit reached</code>.
            </>
          ),
          todo: <>Ask an owner for a fresh one: it is on their team page under <b>People</b>.</>,
        },
      ],
    },

    {
      id: 'connect',
      title: 'Connecting an agent',
      blurb: 'stma connect, browser approval, 401s, Windows and Codex',
      console: true,
      intro: (
        <>
          Before you answer <code>[y/N]</code>, read the five lines <code>stma connect</code>{' '}
          prints — server, workspace, project, agent and device, and the checkout path. Two of the
          most common problems on this list are visible there and nowhere else. If a checkout is
          already half-connected and you are not sure what state it is in,{' '}
          <code>stma adapter doctor</code> says so before you change anything. The CLI prints its
          refusals after <code>stma: </code>; the quotes below leave that prefix off.
        </>
      ),
      entries: [
        {
          quotes: [
            {
              text: 'Run this in a regular interactive terminal so you can confirm it. Nothing was connected and the code is unused.',
              from: 'cli/src/index.ts',
            },
            { text: 'Stopped. Nothing was connected and the code is unused.', from: 'cli/src/index.ts' },
          ],
          where: 'Terminal · stma connect',
          means: (
            <>
              The first: the command was given to the agent instead of typed into a terminal. It
              asks <code>y/N</code> at a real terminal before it spends the code, and an agent
              session has no terminal to ask at — so nothing happened and the code is still good.
              The refusal is the design, not a limitation: the code is a one-use secret and must
              never go into a prompt; asked to run it, a real agent refused and told its human the
              same thing. The second: anything but <code>y</code> was answered.
            </>
          ),
          todo: (
            <>
              Open a normal terminal, <code>cd</code> into the checkout, paste the command there and
              answer <code>y</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This code is invalid, expired, already used or revoked. Create a new command under Agent connections.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'The code could not be redeemed. Create a new command under Agent connections.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'This code was created for another client. stma connect supports Claude Code and Codex.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'stma connect needs a project-only code: the hooks belong to one checkout.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · stma connect',
          means: (
            <>
              A connect code is project-only, one use and ten minutes. The second message means it
              ran out, or was used elsewhere, while you were reading the preview; a code made on
              another server than the one after <code>--server</code> reads as invalid too. The last
              two are a code made for a different client, or with workspace or personal access:
              hooks live in one checkout, so a terminal connection is always one client in one
              project.
            </>
          ),
          todo: (
            <>
              Make a new command on <a href="/app/tokens">Agent connections</a> or the project's{' '}
              <b>Agents</b> page — for Claude Code or Codex, with <b>Project only</b> access — and
              run it within ten minutes, with the <code>--server</code> it was printed with. Any
              other client, or wider access, connects through the browser instead.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Could not reach https://stma.example. Nothing was connected.',
              find: 'Could not reach ',
              from: 'cli/src/index.ts',
            },
            {
              text: 'The server describes a different MCP address than --server. Nothing was connected.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · stma connect',
          means: (
            <>
              The first: no answer within fifteen seconds, a TLS failure, or a redirect, which the
              connect command refuses to follow. A server that scales to zero can take longer than
              that to wake. The second: the server's own <code>BASE_URL</code> is not the address
              you passed — the instance was reached through an IP, another port or another name.
            </>
          ),
          todo: (
            <>
              Load any page of the server in a browser to wake it, then run the command again with
              the origin exactly as it was printed: <code>https://host</code>, no path, no{' '}
              <code>www.</code> the server does not use.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Run this at the root of the Git checkout the agent works in. Nothing was connected.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · stma connect',
          means: (
            <>
              Claude Code attaches a local MCP entry to the git root, so connecting from a subfolder
              would leave an entry the agent never loads. A folder that is not a git repository, or
              a machine without git on its path, gets the same answer.
            </>
          ),
          todo: (
            <>
              Move to the folder <code>git rev-parse --show-toplevel</code> prints and run the same
              command again.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Claude Code already connects to https://stma.example here as "stma". A second entry for the same server would give one session two STMA identities.',
              find: 'A second entry for the same server would give one session two STMA identities.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'Also loads MCP server stma: another STMA connection with its own identity.',
              find: 'another STMA connection with its own identity.',
              from: 'cli/src/index.ts',
            },
          ],
          symptom: (
            <>
              The agent asks permission for an STMA server you did not just connect, and the work
              lands nowhere — or <code>stma connect</code> refuses with:
            </>
          ),
          where: 'Terminal · agent',
          means: (
            <>
              This checkout already loads an STMA entry — usually a machine-wide one added earlier.
              An agent given a bare tool name picks one of them, which is a real agent's behaviour
              here, not a hypothetical, and its work lands under the other identity.
            </>
          ),
          todo: (
            <>
              Keep using the existing entry, or remove it with <code>claude mcp remove NAME</code>{' '}
              and connect again; nothing is removed for you. If the agent asks permission for a
              server you did not just connect, do not grant it: name the server instead — the alias
              is on the <code>Will add</code> line of the connect output — and remove or scope the
              other entry.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This checkout already has local profile …. Run "stma adapter disconnect --profile … --apply" first.',
              find: 'This checkout already has local profile ',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · stma connect',
          means: <>A previous attempt left hooks and a profile behind in this checkout.</>,
          todo: (
            <>
              Run exactly what it says, then connect again. <code>stma adapter status</code> lists
              what is there; <code>No adapter profiles installed.</code> is what clean looks like.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Claude Code was not found on PATH. Install it, or use the OAuth path on Agent connections. Nothing was connected.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · stma connect',
          means: <>This shell cannot run <code>claude --version</code>.</>,
          todo: (
            <>
              Install Claude Code or fix the path, or connect that client through the browser
              instead, from <a href="/app/tokens">Agent connections</a>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Not confirmed yet: start Claude Code in this folder within 15 minutes so it loads the entry, or the pending credential expires.',
              find: 'in this folder within 15 minutes so it loads the entry, or the pending credential expires.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'Setup pending: complete the native MCP connection or call whoami to confirm this client. No work authority has been activated.',
              from: 'server/src/routes/mcp.ts',
            },
            {
              text: 'Connection setup expired or was revoked. Create a new connection.',
              from: 'server/src/routes/mcp.ts',
            },
          ],
          where: 'Terminal · agent',
          means: (
            <>
              <b>Not a failure.</b> The credential stays pending until the client itself reaches
              STMA once, and until then it can confirm itself and nothing else. Unconfirmed after
              fifteen minutes, it expires.
            </>
          ),
          todo: (
            <>
              Start the client in that same folder and check its MCP list; the row named{' '}
              <code>stma-FOLDER-XXXX</code> should read connected. On Codex, also open{' '}
              <code>/hooks</code> and trust this project's hooks — until you do, nothing is tracked
              or guarded. If it expired, create a new connection.
            </>
          ),
        },
        {
          symptom: <>MCP calls answer 401.</>,
          quotes: [
            {
              text: 'This agent installation was disabled on 2026-09-20. Ask your human for a new connection prompt at https://stma.example/app/tokens.',
              find: 'Ask your human for a new connection prompt at ',
              from: 'server/src/auth/pat.ts',
            },
            {
              text: 'This credential owner is no longer a member of its team. Ask a team owner before creating a new connection.',
              from: 'server/src/auth/pat.ts',
            },
            { text: 'OAuth access token has expired', by: 'Claude Code' },
          ],
          where: 'Agent · any call',
          means: (
            <>
              Access lasts an hour and the client refreshes it on its own; a revoked installation, a
              membership you lost or a deleted project cannot be refreshed. The last message is
              different: inside a Claude Code session it is Claude's own login, not STMA's.
            </>
          ),
          todo: (
            <>
              For Claude's own login, type <code>/login</code>. Otherwise use the client's own
              Authenticate action first; if that fails, remove the connection in the client, add the
              same <code>/mcp</code> address again and approve a fresh installation. Never paste a
              setup code or an <code>Authorization</code> header as a workaround.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Browser-approved access differs from the requested project.',
              from: 'cli/src/oauthLocal.ts',
            },
            {
              text: 'OAuth approval timed out. No local adapter was installed.',
              from: 'cli/src/oauthLocal.ts',
            },
          ],
          where: 'Terminal · activate',
          means: (
            <>
              The browser approval was for something other than what the command asked: another
              project, or workspace access where it wanted <b>Project only</b>. The second: no
              approval came back within five minutes, which is also what the terminal shows after
              the consent page refused, because no callback ever arrives. Any credential it had
              minted is revoked, and the message says whether that was confirmed.
            </>
          ),
          todo: (
            <>
              Run it again with <code>--team</code> set to the workspace's slug and{' '}
              <code>--project</code> to the project's name as the console shows it, and choose{' '}
              <b>Project only</b> for that project in the browser. For a Claude Code or Codex
              checkout, <code>stma connect</code> is the shorter way to the same hooks.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This checkout commits a .stma/ directory, so the server named there came with the repository. STMA_TOKEN is only sent to a server you name: set STMA_URL. No credential was sent.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'Use adapter activate for browser OAuth, or provide an approved legacy STMA_TOKEN. Never paste a token into a command.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · commands',
          means: (
            <>
              The manual commands send a token only to a server you named. When the repository
              itself carries a server address, somebody else chose it, so the CLI stops before
              anything leaves. The second: a manual command found no credential at all — a{' '}
              <code>stma connect</code> checkout keeps its own for the hooks, and the manual commands
              do not read it.
            </>
          ),
          todo: (
            <>
              Set <code>STMA_URL</code> to the server you mean, in the shell that runs the command.
              In a connected checkout the hooks do the tracking; the manual commands need{' '}
              <code>STMA_URL</code> and an approved <code>STMA_TOKEN</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: '… cannot be loaded because running scripts is disabled on this system',
              by: 'Windows PowerShell',
            },
          ],
          where: 'Windows · PowerShell',
          means: <>PowerShell's default policy blocks npm's <code>.ps1</code> shims.</>,
          todo: (
            <>
              Add <code>.cmd</code>: <code>stma.cmd</code>, <code>npx.cmd</code>,{' '}
              <code>claude.cmd</code>. Do not change the execution policy to get past this.
            </>
          ),
        },
        {
          symptom: (
            <>
              <code>stma adapter disconnect</code> stops part-way — on Windows, antivirus has been
              seen to stop it — and the connection is still there, or it ends with:
            </>
          ),
          quotes: [
            {
              text: 'Remote OAuth revocation is UNCONFIRMED. Revoke this installation in STMA Agent connections.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'Windows user-scope credential protection failed. No credential was exposed.',
              from: 'cli/src/oauthLocal.ts',
            },
          ],
          where: 'Terminal · disconnect',
          means: (
            <>
              The local half ran but the server was never told, or the stored credential could not
              be unlocked at all. Measured once, on this project's own Windows desktop: Kaspersky's
              behaviour monitor flagged the published CLI running from the npx cache while it started
              PowerShell to unlock a stored credential, and the process died before it sent
              anything. Both Windows helper scripts were rewritten to avoid the shape that was
              flagged; whether a published build still trips the same scanner{' '}
              <b>has not been verified</b>.
            </>
          ),
          todo: (
            <>
              <b>Revoke the connection in the browser</b>, on{' '}
              <a href="/app/tokens">Agent connections</a> — that is the half that actually stops
              access — then remove the client's entry and the checkout's hooks by hand if the CLI
              still cannot.
            </>
          ),
        },
        {
          symptom: <>Codex: the hooks never fire and MCP calls are refused.</>,
          quotes: [
            {
              text: 'Codex already connects to https://stma.example/mcp as "stma". Codex loads its user config in every checkout, so a second entry would give one session two STMA identities.',
              find: 'Codex loads its user config in every checkout, so a second entry would give one session two STMA identities.',
              from: 'cli/src/codexConfig.ts',
            },
          ],
          where: 'Codex',
          means: (
            <>
              Codex refuses MCP calls under its non-interactive approval policy, and project hooks
              need explicit trust. It also keeps one STMA identity per machine, because it loads its
              user config in every checkout — a second entry for the same server is refused rather
              than silently replacing the first.
            </>
          ),
          todo: (
            <>
              Use interactive Codex, approve the calls, and trust the hooks in <code>/hooks</code>.
              To replace the existing entry, delete its <code>[mcp_servers.NAME]</code> table from{' '}
              <code>~/.codex/config.toml</code> first, or keep using it.
            </>
          ),
        },
      ],
    },

    {
      id: 'working',
      title: 'Connected, but nothing moves',
      blurb: 'Quiet hooks, edits the guard refuses, runs nobody recorded',
      console: true,
      entries: [
        {
          symptom: (
            <>
              You assign work, say "continue" to the agent, and it answers "continue with what?" —
              or a freshly connected agent opens with "7 debug sessions have unread replies".
            </>
          ),
          where: 'Agent · prompt hook',
          means: (
            <>
              Both measured. The server may have been asleep: an instance that scales to zero takes
              twenty to forty-five seconds to wake, and the prompt hook waits 2.5 seconds for news
              and then stays silent rather than blocking you. Or the checkout runs hooks from a CLI
              older than 0.14.2, which checked at most once a minute, so missed an assignment made
              just after the agent's last tool call, and counted old assignments to other agents as
              this agent's unread mail.
            </>
          ),
          todo: (
            <>
              Load any page of the app in your browser first, then prompt again. Re-pin an older
              checkout with <code>stma adapter repair --pin-runtime --apply</code>. In the
              meantime, one sentence does the job: <i>read your STMA inbox and do the work assigned
              to you</i>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'STMA stopped this file edit: coordination_unavailable. Resolve the connection, scope or conflict with your human; do not bypass it through a shell or another tool.',
              find: 'Resolve the connection, scope or conflict with your human; do not bypass it through a shell or another tool.',
              from: 'cli/src/index.ts',
            },
            {
              text: 'STMA stopped this file edit: no_tracked_run.',
              find: 'no_tracked_run',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Agent · file edit',
          means: (
            <>
              The hooks ask STMA before every file-tool edit and refuse when they cannot get an
              answer: the connection is pending, revoked or unreachable, no run was opened for this
              session, or the path is outside the checkout or inside <code>.git</code>,{' '}
              <code>.stma</code>, <code>.claude</code>, <code>.codex</code> or{' '}
              <code>.cursor</code>. The guard fails closed on purpose. The same sentence follows the
              refusals that name a rule — <code>owner_approval_required</code>,{' '}
              <code>change_budget_exceeded</code>, <code>checkout_mismatch</code>.
            </>
          ),
          todo: (
            <>
              <code>stma adapter status</code> and <code>stma adapter doctor</code> report the local
              half — hooks, profile and stored credential — but never ask the server, so a
              connection revoked in the browser still reads OK there; the connection's own state is
              on <a href="/app/tokens">Agent connections</a>. Fix it there or connect again. A rule
              that refused is the human's to change. If this checkout should not be guarded any
              more, <code>stma adapter disconnect --profile ID --apply</code> removes the hooks.
            </>
          ),
        },
        {
          symptom: (
            <>The agent worked and pushed, but STMA recorded nothing — no run, no claims, an empty agent map.</>
          ),
          where: 'Console · agent map',
          means: (
            <>
              A browser-authorized MCP connection offers an agent the tools; it does not make it use
              them during an ordinary request, and it installs no hooks. Measured: an agent found{' '}
              <code>whoami</code> and tried to run it as a shell command.
            </>
          ),
          todo: (
            <>
              Connect that checkout with <code>stma connect</code> instead — the same installation
              serves the agent and its hooks, and the hook opens the run whether or not the model
              remembers to.
            </>
          ),
        },
        {
          quotes: [{ text: 'unknown_or_inactive_run', from: 'server/src/routes/control.ts' }],
          where: 'Terminal · hook',
          means: <>Harmless: the agent closed its own run before the hook did.</>,
          todo: (
            <>
              Nothing. Current builds stay silent here, so seeing it means the checkout runs older
              hooks — <code>stma adapter repair --pin-runtime --apply</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This credential cannot access run "…": it belongs to another agent connection.',
              find: 'it belongs to another agent connection.',
              from: 'server/src/lib/grants.ts',
            },
          ],
          where: 'Agent · MCP reply',
          means: (
            <>
              The hook starts the run under the local adapter's own installation and tells the agent
              beside it to reuse that <code>run_id</code>. That works when the two are{' '}
              <b>paired</b>, and this is what it looks like when they are not.
            </>
          ),
          todo: (
            <>
              Pair them on <a href="/app/tokens">Agent connections</a> — the adapter's row asks{' '}
              <b>Listens for</b> — and the agent may update, finish and hand off that run from its
              next call. If the run really is somebody else's, the agent should call{' '}
              <code>start_run</code> and use the id it returns instead. A checkout connected with{' '}
              <code>stma connect</code> never sees this: one installation serves the agent and its
              hooks, so there is nothing to pair.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'STMA outbox is full (500 pending, 3 dropped). Run stma adapter status --profile ….',
              find: 'STMA outbox is full (',
              from: 'cli/src/index.ts',
            },
            {
              text: '[stma] Outbox corruption detected for …; run stma adapter repair --profile … --apply.',
              find: 'Outbox corruption detected for ',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · hook',
          means: (
            <>
              Queued lifecycle events could not be delivered: the server was down or asleep, or the
              credential could not be read or refreshed.
            </>
          ),
          todo: (
            <>
              <code>stma adapter status --profile ID</code> shows what is pending and the last
              error, then <code>stma adapter repair --profile ID --apply</code>.
            </>
          ),
        },
      ],
    },

    {
      id: 'coordinate',
      title: 'Collisions and handoffs',
      blurb: 'work_conflict, stale_ground, right of way, accept → resume → complete',
      console: true,
      entries: [
        {
          quotes: [
            {
              text: 'STMA stopped this file edit: work_conflict. Another live run holds this ground: … Tell your human, and wait or coordinate through a session; do not bypass it through a shell or another tool.',
              find: 'Another live run holds this ground',
              from: 'cli/src/index.ts',
            },
            {
              text: 'Another live run overlaps your scope. Narrow what you touch, or coordinate through open_session before writing.',
              from: 'shared/src/conflicts.ts',
            },
            {
              text: 'The ground to leave alone is public/app.js, held by desktop-agent (bob), which declared it first.',
              find: 'The ground to leave alone is ',
              from: 'shared/src/conflicts.ts',
            },
            {
              text: 'Another run declared ground you already hold (public/styles.css). You were first, so you keep the right of way and that run was told to wait for you: carry on, and complete, finish or release when your work is done, which is what frees the ground for it. Do not stop on its account.',
              find: 'You were first, so you keep the right of way and that run was told to wait for you: carry on,',
              from: 'shared/src/conflicts.ts',
            },
          ],
          where: 'Agent · edit, run',
          means: (
            <>
              Two live runs declared the same ground, and the one that declared it first keeps the
              right of way: the guard refuses the later run's edit and names who holds it. Two runs
              usually reach for the same files in a different order, so each can be first on part of
              it — then the reply says both halves, each naming its own files. A collision on a
              migration or a contract opens with <code>STOP and tell your human before writing.</code>
            </>
          ),
          todo: (
            <>
              Leave the ground you were told to leave alone: narrow the scope with{' '}
              <code>update_run</code> so you no longer claim it, or coordinate through{' '}
              <code>open_session</code>. Where you were first, carry on and complete, finish or
              release when done — that is what frees it for the other run. If the message says the
              holder has stopped to ask a person, waiting will not free the ground: talk to their
              human. Do not route around the guard with a shell command; it only sees the client's
              file tools, so going around it hides the collision instead of resolving it.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'STMA stopped this file edit: stale_ground. Another run finished on this ground after yours started, so what you read may be gone.',
              find: 'Another run finished on this ground after yours started, so what you read may be gone.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Agent · file edit',
          means: <>Another run finished on ground yours still holds, so what your agent read may already be gone.</>,
          todo: (
            <>
              Fetch or pull as you direct, then tell the agent to <b>re-declare its scope</b> with{' '}
              <code>update_run</code> — re-declaring is what acknowledges that the ground moved — and
              retry the edit.
            </>
          ),
        },
        {
          quotes: [
            {
              text: "STMA stopped this file edit: policy_content_denied. Your team's published policy denies this content here — …",
              find: 'published policy denies this content here — ',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Agent · file edit',
          means: (
            <>
              Your workspace published a <code>content:</code> rule and the text this edit would add
              matches it. The text never left the machine; only the rule, the path and the outcome
              are recorded, on <b>Governance</b>.
            </>
          ),
          todo: <>Make a change that does not contain it, or ask the owner who published the rule.</>,
        },
        {
          quotes: [
            {
              text: 'Cannot complete an accepted handoff. It is accepted but not resumed: send action "resume" first, which records that the work began, then "complete".',
              find: 'It is accepted but not resumed: send action "resume" first, which records that the work began, then "complete".',
              from: 'server/src/domain/collaboration.ts',
            },
            {
              text: 'Cannot resume a cancelled handoff. The sender withdrew this work: do not start or continue it, and tell your human it was cancelled.',
              find: 'The sender withdrew this work: do not start or continue it, and tell your human it was cancelled.',
              from: 'server/src/domain/collaboration.ts',
            },
          ],
          where: 'Agent · update_handoff',
          means: (
            <>
              The order is <b>accept → resume → complete</b>, and <code>complete</code> before{' '}
              <code>resume</code> is refused. Every reply carries a <code>next</code> field with the
              exact call to make — agents used to find the order by being refused, 48 times in one
              lab round. A cancelled handoff is over: the sender withdrew it.
            </>
          ),
          todo: (
            <>
              Send the call the refusal names, in that order. For cancelled work, stop and tell your
              human.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Resume commit mismatch: expected 1a2b3c4…, observed 9f8e7d6….',
              find: 'Resume commit mismatch: expected ',
              from: 'server/src/domain/checkpoints.ts',
            },
            {
              text: 'Resume requires a clean checkout. Preserve local work and ask the human how to proceed; never reset it.',
              from: 'server/src/domain/checkpoints.ts',
            },
            {
              text: 'This handoff has an immutable checkpoint. Report repository_identity, commit_sha and worktree_clean before resuming.',
              from: 'server/src/domain/collaboration.ts',
            },
          ],
          where: 'Agent · resume',
          means: (
            <>
              A handoff that carries code is resumed from its exact repository and commit in a clean
              worktree, reported together. Resume belongs <i>before</i> the agent changes anything;
              after its own first commit it still works, because the run's start checkpoint is
              accepted as the proof. What stays refused is a run that began in a different
              repository, or a dirty worktree — and the refusal names the way out.
            </>
          ),
          todo: (
            <>
              Report all three fields in one call (<code>commit_sha</code> is the full{' '}
              <code>git rev-parse HEAD</code>). If you already committed on top, send the{' '}
              <code>run_id</code> of the run that began there. Never reset a checkout to make it
              clean: preserve the work and ask your human.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'A branch handoff next_steps cannot tell the receiver to obtain, create, copy, use or configure a credential.',
              from: 'server/src/mcp/fleet.ts',
            },
            {
              text: 'A branch handoff requires an immutable delivery/tested checkpoint.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · handoff_work',
          means: (
            <>
              Both fail closed on purpose, and the run keeps its claims. Nothing in a brief may move
              a secret between machines, and a handoff that carries a branch must say exactly which
              commit it hands over.
            </>
          ),
          todo: (
            <>
              Rewrite the steps so the <em>sending</em> machine runs the credential-dependent check
              and passes on only its non-secret result. For a branch, record a delivery or tested
              checkpoint for that exact commit first, with a clean worktree. A handoff of intent,
              with no branch, needs none.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This work is assigned by name to desktop-agent on desktop. Only that agent can accept, resume or complete it; ask the sender to reassign it.',
              find: '. Only that agent can accept, resume or complete it; ask the sender to reassign it.',
              from: 'server/src/domain/collaboration.ts',
            },
            { text: 'Another agent already accepted this handoff.', from: 'server/src/domain/collaboration.ts' },
          ],
          where: 'Agent · update_handoff',
          means: <>Work assigned by name can be accepted only by the agent it names, and a taken handoff by the one that took it.</>,
          todo: (
            <>
              Send the instruction to that agent, or cancel and re-assign from the project page's{' '}
              <b>Assigned work</b> card — cancelling is shown there, which it was not when somebody
              first reported a cancel that had in fact worked.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Run 3f2a… is finished or unknown. This agent has one live run here — 9c1d… — which is the one your hooks own if they started it: send that run_id. Start a new run only for new work.',
              find: 'is finished or unknown. This agent has one live run here — ',
              from: 'server/src/mcp/fleet.ts',
            },
            {
              text: 'No run_id given and you have no active run. Call start_run first — it returns the run_id every other fleet tool needs.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · runs',
          means: (
            <>
              The usual reason to be holding a dead <code>run_id</code> is that the hooks replaced
              the run a minute ago, on a branch switch. The reply names the live one.
            </>
          ),
          todo: (
            <>
              Send the <code>run_id</code> the reply names. Start a new run only for new work: two
              live runs of one agent in one project is the state in which nothing can tell which one
              a resume means.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'No agent called "desktop" is connected to this team. Connected agents: laptop-agent (alice), desktop-agent (alice). Check list_teammates, or ask its owner to connect it first.',
              find: 'Check list_teammates, or ask its owner to connect it first.',
              from: 'server/src/domain/assignments.ts',
            },
            {
              text: '"desktop-agent" names 2 agents here (alice\'s on laptop, alice\'s on desktop). Add "device" with the machine label to say which one.',
              find: 'Add "device" with the machine label',
              from: 'server/src/domain/assignments.ts',
            },
          ],
          where: 'Agent · assign',
          means: (
            <>
              Work is addressed to one connected agent by its exact name, as{' '}
              <code>list_teammates</code> lists it. One name can belong to two agents — one person's
              laptop and desktop, or two people's.
            </>
          ),
          todo: (
            <>
              Use a name from the list the reply gives. For a shared name, add{' '}
              <code>device</code> with the machine label, or <code>to</code> with the owner's
              username, as the reply asks.
            </>
          ),
        },
      ],
    },

    {
      id: 'refusals',
      title: 'When a tool says no',
      blurb: 'Scope, arguments, ids, replays and rate limits',
      console: true,
      intro: (
        <>
          Every refusal here says <code>Nothing was written</code> or names what was kept, and the
          next step. An agent that reads the whole message usually needs nobody; these are the ones
          worth knowing by sight.
        </>
      ),
      entries: [
        {
          quotes: [
            {
              text: 'This credential is acme / payments-api scoped and cannot access team invitations. Nothing was written. Ask your human to create a separate connection with the required scope.',
              find: 'Nothing was written. Ask your human to create a separate connection with the required scope.',
              from: 'server/src/lib/grants.ts',
            },
            {
              text: 'Repository identity does not match the credential-bound project. Connect this checkout to its own project before starting work.',
              from: 'server/src/lib/projects.ts',
            },
            {
              text: 'You are in 2 teams, so name one with the team parameter: acme, parcel-desk.',
              find: 'teams, so name one with the team parameter: ',
              from: 'server/src/mcp/shared.ts',
            },
          ],
          where: 'Agent · MCP reply',
          means: (
            <>
              A connection is bound to one project, one workspace, or every membership of one
              person, and the call named something outside it — another project, another team, or a
              checkout of a different repository. A personal connection that reaches several teams
              has to say which one.
            </>
          ),
          todo: (
            <>
              Leave <code>team</code> and <code>project</code> out — a scoped connection fills them
              in — or name one of the teams the reply lists. For different ground, the human creates
              a separate connection for it on <a href="/app/tokens">Agent connections</a>; this one
              is never widened.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Unknown parameter "runId" for update_run. Accepted: …. Nothing was written — fix the argument name and call again.',
              find: '. Nothing was written — fix the argument name and call again.',
              from: 'server/src/routes/mcp.ts',
            },
            {
              text: 'run_id "{3f2a…}" is not an id STMA issued. Nothing was read or written.',
              find: ' is not an id STMA issued. Nothing was read or written.',
              from: 'server/src/lib/grants.ts',
            },
            { text: 'No such session in your teams.', from: 'server/src/routes/mcp.ts' },
          ],
          where: 'Agent · MCP reply',
          means: (
            <>
              Arguments are checked before a tool runs, so a misspelt one is refused rather than
              silently ignored. An id must be exactly the one STMA returned — braces, a missing dash
              or an invented id is refused, and a session outside your teams is not found.
            </>
          ),
          todo: (
            <>
              Use an argument from the <code>Accepted</code> list (<code>run_id</code>, not{' '}
              <code>runId</code>), and pass ids exactly as STMA returned them. Session ids come from{' '}
              <code>inbox</code> or <code>list_sessions</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'A "handoff" message is written by handoff_work or assign_work, not by a thread message. Nothing was written. Use one of: question, answer, hypothesis, info-request, resolution, note.',
              find: 'not by a thread message. Nothing was written. Use one of: ',
              from: 'server/src/routes/mcp.ts',
            },
          ],
          where: 'Agent · messages',
          means: (
            <>
              Handoffs and announcements are records with their own tools and rules, so a thread
              message cannot pose as one.
            </>
          ),
          todo: (
            <>
              Hand work over with <code>handoff_work</code>, start somebody with{' '}
              <code>assign_work</code>, broadcast with <code>announce</code> — or post the message
              with one of the kinds listed.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'This request_id was already used with different arguments. Retry unchanged, or use a new request_id for new work.',
              from: 'server/src/domain/handoffRequests.ts',
            },
            {
              text: 'This requestId was already used with different arguments. Retry unchanged, or use a new requestId for new work.',
              from: 'server/src/domain/agents.ts',
            },
          ],
          where: 'Agent · retries',
          means: (
            <>
              A <code>request_id</code> names one logical call. Retrying it unchanged after a lost
              response returns the original result; changing anything under the same id is refused,
              so a retry can never quietly become different work.
            </>
          ),
          todo: <>Retry with the same arguments, or generate a new <code>request_id</code> for new work.</>,
        },
        {
          symptom: <>429 responses.</>,
          quotes: [
            { text: 'rate_limited', from: 'server/src/lib/ratelimit.ts' },
            {
              text: 'This account has made 50,000 tool calls today. Nothing was written. Stop, tell your human, and check for a loop.',
              find: ' tool calls today. Nothing was written. Stop, tell your human, and check for a loop.',
              from: 'server/src/routes/mcp.ts',
            },
            {
              text: 'Loop guard: more than 20 messages in this session within an hour from your side. Stop posting, summarize the state to your human, and wait for them before continuing.',
              find: 'messages in this session within an hour from your side. Stop posting, summarize the state to your human, and wait for them before continuing.',
              from: 'server/src/routes/mcp.ts',
            },
          ],
          where: 'Agent · browser',
          means: (
            <>
              A rate limit, the per-account daily cap, or the loop guard on one thread. They apply
              on every plan and on self-hosted servers, because they stop runaway loops, not use.
            </>
          ),
          todo: (
            <>
              Wait a minute — the response says how long — and look at what the agent was
              repeating, because this is usually a loop rather than real traffic. The daily cap
              resets at 00:00 UTC.
            </>
          ),
        },
      ],
    },

    {
      id: 'environments',
      title: 'Environments',
      blurb: 'Snapshots, compare_env, preflight and baselines',
      console: true,
      entries: [
        {
          quotes: [
            {
              text: 'The selected snapshots belong to different projects (acme/payments-api and acme/web). Pass "repo" so both sides are resolved from the same project; a cross-project environment diff is not meaningful.',
              find: 'a cross-project environment diff is not meaningful.',
              from: 'server/src/routes/mcp.ts',
            },
            {
              text: "These machines' newest snapshots belong to different projects (…). Pick one project above before comparing them.",
              find: 'Pick one project above before comparing them.',
              from: 'server/src/routes/compare.tsx',
            },
          ],
          where: 'Agent · Compare',
          means: (
            <>
              A diff compares one project on two machines. The two newest snapshots were pushed from
              checkouts of different repositories, and every difference between them would be noise.
            </>
          ),
          todo: (
            <>
              Pass <code>repo</code> to <code>compare_env</code>, or pick the project on the Compare
              page, so both sides come from the same project.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'You have no snapshot in this team yet. Call get_snapshot_checklist, collect the data, …',
              find: 'You have no snapshot in this team yet',
              from: 'server/src/routes/mcp.ts',
            },
            {
              text: 'Comparing your own machines needs snapshots from two of them.',
              from: 'server/src/routes/mcp.ts',
            },
          ],
          where: 'Agent · snapshots',
          means: <>There is nothing to compare yet: a side has never pushed a snapshot, or only one of your machines has.</>,
          todo: (
            <>
              On each machine, have the agent call <code>get_snapshot_checklist</code> and then{' '}
              <code>push_snapshot</code> with its own <code>device</code> label, then compare with{' '}
              <code>device</code> and <code>their_device</code>.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'No baseline recorded for this project yet. A team owner can set one from the CLI (stma env baseline) — until then compare_env against a teammate is the next best check.',
              from: 'server/src/mcp/fleet.ts',
            },
            {
              text: 'STMA environment: no baseline. Environment compatibility has not been verified.',
              from: 'cli/src/notices.ts',
            },
            {
              text: 'This snapshot carried no envVarNames, so the required environment variables were not checked.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · preflight',
          means: (
            <>
              Preflight can only report what a baseline claims and what a snapshot sent. With no
              baseline there is nothing to check against; with no variable names the variable check
              is <b>unchecked</b>, not failed — a machine nobody inspected is not a broken one.
            </>
          ),
          todo: (
            <>
              A workspace owner records a baseline from a machine that works — with{' '}
              <code>stma env baseline --team TEAM --project PROJECT</code>, or by promoting a
              snapshot on <b>Governance</b>. For the variable check, send the names of the variables
              (never their values); committed templates such as <code>.env.example</code> do not
              count.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'STMA environment: CRITICAL. Required environment checks failed. Review the project environment report before proceeding; do not copy or expose credential values.',
              from: 'cli/src/notices.ts',
            },
            {
              text: 'Do not start until this is fixed — the baseline says this machine cannot reproduce the project. Tell your human exactly which line differs.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · preflight',
          means: (
            <>
              This machine differs from the project's baseline where it matters: a required variable
              name is missing, a runtime version differs from policy, or a lockfile the baseline
              records is different or missing. A lockfile only this machine has never escalates.
            </>
          ),
          todo: (
            <>
              Fix the line the report names — install the runtime, set the variable, restore the
              lockfile — and run the check again. Never copy a secret's value to make it pass.
            </>
          ),
        },
      ],
    },

    {
      id: 'integrations',
      title: 'Integrations',
      blurb: 'GitHub, Azure DevOps, Jira, ClickUp and inbound webhooks',
      console: true,
      intro: (
        <>
          A provider connection is checked when it is saved, and a failed check still saves it and
          says why (<code>Saved, but the connection check failed.</code>), so these reasons appear
          at the form rather than three screens later.
        </>
      ),
      entries: [
        {
          quotes: [
            {
              text: 'The token was refused — invalid, expired, or revoked (Azure answers a sign-in page, not a 401, so this also covers a mistyped PAT).',
              find: 'The token was refused — invalid, expired, or revoked (Azure answers a sign-in page, not a 401, so this also covers a mistyped PAT).',
              from: 'server/src/lib/azureDevops.ts',
            },
            {
              text: 'The token works but lacks a scope this step needs: Code (Read & Write) to commit the pipeline file, Build (Read & Execute) to register the pipeline.',
              find: 'The token works but lacks a scope this step needs',
              from: 'server/src/lib/azureDevops.ts',
            },
            {
              text: 'Organization, project or repository not found with this token.',
              from: 'server/src/lib/azureDevops.ts',
            },
          ],
          where: 'Team page · Delivery',
          means: (
            <>
              The three answers Azure DevOps gives a connection that does not work: the token was
              refused outright, it works but lacks a scope, or it cannot see what the connection
              names. A token is minted for one organization unless it was made for all accessible
              organizations, so a token from another organization answers exactly like a wrong name.
            </>
          ),
          todo: (
            <>
              Create a new token under <b>User settings → Personal access tokens</b> with both{' '}
              <b>Code (Read &amp; Write)</b> and <b>Build (Read &amp; Execute)</b>, and check the
              organization, project and repository spelling against that token's organization.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Jira refused the credentials on both API doors (the site host and api.atlassian.com).',
              from: 'server/src/lib/jira.ts',
            },
            {
              text: 'Also: this token does not look like a personal API token (those start with "ATATT").',
              find: 'this token does not look like a personal API token (those start with ',
              from: 'server/src/lib/jira.ts',
            },
          ],
          where: 'Team page · Integrations',
          means: (
            <>
              Jira takes a personal API token together with the email of the Atlassian account that
              created it. A password, an SSO login and an admin API key from admin.atlassian.com —
              the one shown next to an Organization ID — cannot read Jira.
            </>
          ),
          todo: (
            <>
              Create a token at <b>id.atlassian.com → Security → API tokens</b> (a scoped one needs
              the Jira app with at least <code>read:jira-user</code> and{' '}
              <code>read:jira-work</code>) and save it with that account's email.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'That ClickUp task is not in Sprint board, the list mapped to this project. STMA reads only the mapped list, so a task filed elsewhere has to be moved or the mapping changed.',
              find: ', the list mapped to this project. STMA reads only the mapped list, so a task filed elsewhere has to be moved or the mapping changed.',
              from: 'server/src/domain/tickets.ts',
            },
            {
              text: 'This project has no ClickUp List mapping. A workspace owner maps it on the team Integrations tab; pass the project name when more than one mapping exists.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · browser · ClickUp',
          means: (
            <>
              STMA reads exactly one ClickUp List per project, the one an owner mapped, and nothing
              outside it. A paused connection answers nothing at all until it is resumed.
            </>
          ),
          todo: (
            <>
              Move the task into the mapped List, or have an owner map this project (or change the
              mapping) on the <b>Integrations</b> tab.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'GitHub refused the request (not_found_or_no_access). Check the repository name and that the token can read its issues.',
              find: '). Check the repository name and that the token can read its issues.',
              from: 'server/src/routes/dashboard.tsx',
            },
            { text: 'X-Hub-Signature-256 mismatch', from: 'server/src/routes/api.ts' },
            { text: 'unknown hook token', from: 'server/src/routes/api.ts' },
          ],
          where: 'Team page · GitHub',
          means: (
            <>
              GitHub answers 404 both for a wrong repository name and for one the token cannot see.
              A webhook is signed with the team's inbound hook token as its secret; an unsigned or
              wrongly signed event is refused, and a hook URL with an old token no longer resolves.
            </>
          ),
          todo: (
            <>
              Check the repository name (<code>owner/name</code>) and the token's access. For the
              webhook, set its <b>Secret</b> to the inbound hook token from the team page; if you
              regenerate the token, update both the URL and the Secret.
            </>
          ),
        },
      ],
    },

    {
      id: 'limits',
      title: 'Plans and limits',
      blurb: 'Hosted plan ceilings, and what the private beta lifts',
      console: true,
      hosted: true,
      intro: meter.beta ? (
        <>
          Every ceiling below is lifted while this service is in its private beta — only how long
          history is kept is not — so you should not meet them yet. They belong to the plan a
          workspace is on, and a server you run yourself is never metered at all.
        </>
      ) : (
        <>
          These belong to the plan a workspace is on. A server you run yourself is never metered,
          and during a private beta the hosted service lifts all of them but the age limit on
          history.
        </>
      ),
      entries: [
        {
          quotes: [
            {
              text: 'Starting a run is not part of the free plan that team "acme" is on. It is included from the solo plan up. Tell your human — this is their decision, not something to work around.',
              find: ' plan up. Tell your human — this is their decision, not something to work around.',
              from: 'server/src/mcp/shared.ts',
            },
          ],
          where: 'Agent · MCP reply',
          means: (
            <>
              The workspace's plan does not include that capability. The agent map stays readable on
              every plan; starting runs, policy, preflight and evidence packs come with the plans the
              reply names.
            </>
          ),
          todo: <>Tell the human who owns the workspace; the plan is theirs to change, not the agent's to work around.</>,
        },
        {
          quotes: [
            {
              text: 'Device limit reached: the free plan keeps snapshots from 2 devices per member, counted over the last 30 days, …',
              find: 'Device limit reached: the ',
              from: 'server/src/lib/devices.ts',
            },
            {
              text: 'Team member limit reached (1 on the free plan).',
              find: 'Team member limit reached (',
              from: 'server/src/routes/dashboard.tsx',
            },
            {
              text: 'Project limit reached (10 on the free plan). Reuse an existing project name or upgrade the plan.',
              find: '. Reuse an existing project name or upgrade the plan.',
              from: 'server/src/lib/projects.ts',
            },
          ],
          where: 'Agent · browser',
          means: (
            <>
              A ceiling of the workspace's plan. A device is the label a snapshot is pushed under,
              and one stops counting thirty days after its last snapshot; connecting agents is never
              limited by machine.
            </>
          ),
          todo: (
            <>
              For devices, push again under the label of the machine this one replaced, or wait for
              an old one to lapse. For people and projects, reuse an existing project or remove a
              member — or the owner changes the plan.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'Team "acme" has used its 20,000 tool calls for today (resets 00:00 UTC). Nothing was written. If this was not a runaway loop, tell your human the team needs a larger plan.',
              find: 'If this was not a runaway loop, tell your human the team needs a larger plan.',
              from: 'server/src/mcp/shared.ts',
            },
            {
              text: 'Team "acme" has used its 3 handoffs for this 30-day window on the free plan (resets 2026-10-15). Nothing was written and your run still holds its claims.',
              find: 'Nothing was written and your run still holds its claims.',
              from: 'server/src/mcp/fleet.ts',
            },
          ],
          where: 'Agent · MCP reply',
          means: (
            <>
              The workspace's allowance of tool calls for the day, or of handoffs and assignments for
              the thirty-day window, is spent. Nothing was lost: the run keeps its claims.
            </>
          ),
          todo: (
            <>
              Check for a loop first. Then push the branch and tell your human what is left — the
              work is not lost, but STMA did not carry the brief this time.
            </>
          ),
        },
        {
          billing: true,
          beta: true,
          quotes: [
            { text: 'Nothing to pay yet', hostedOnly: true },
            { text: 'Not selling yet — STMA is in private beta.', hostedOnly: true },
          ],
          where: 'Browser · Plan & billing',
          means: (
            <>
              STMA is in a private beta. Every workspace has every feature and none of the plan
              limits, and plans are not for sale yet, so there is no billing to manage. History is
              the one exception: kept for 90 days, as on Cloud Free, so the end of the beta deletes
              nothing.
            </>
          ),
          todo: <>Nothing. When pricing starts you will hear it from us first.</>,
        },
      ],
    },

    {
      id: 'selfhost',
      title: 'Your own server',
      blurb: 'Embedded database upgrades, boot refusals, BASE_URL and stma serve',
      console: false,
      entries: [
        {
          quotes: [
            { text: 'PGlite failed to initialize properly', by: 'PGlite' },
            {
              text: "The database in … was written by PostgreSQL 17, and this build's embedded engine is PostgreSQL 18.",
              find: "this build's embedded engine is PostgreSQL ",
              from: 'server/src/db/index.ts',
            },
          ],
          where: 'Server · boot',
          means: (
            <>
              The embedded database's PostgreSQL major moved between releases (PGlite 0.3 carries
              17, 0.5 carries 18), and a major version never opens an older data directory in place.
            </>
          ),
          todo: (
            <>
              The refusal names the command that takes it across:{' '}
              <code>stma-server --upgrade-data "&lt;that directory&gt;"</code>, or the same binary
              through npx. It reads the old database with the engine that wrote it, rebuilds the new
              one from the migrations this build ships, and moves the rows in PostgreSQL's own COPY
              format. The PostgreSQL 17 copy is <b>kept</b> beside the new one and nothing ever
              deletes it, so a bad outcome is one rename away from being undone.{' '}
              <b>Boot still moves nothing on its own</b>: this is a command you type, once. It
              fetches the older engine when it runs and checks it before loading it, so the machine
              needs the registry for a minute — or point <code>STMA_UPGRADE_ENGINE</code> at a copy
              you already have.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'There is no PostgreSQL data directory at … — no PG_VERSION file, so nothing here was written by this server. Point --upgrade-data at the directory the server reported.',
              find: ' — no PG_VERSION file, so nothing here was written by this server. Point ',
              from: 'server/src/db/upgrade.ts',
            },
            {
              text: 'The @electric-sql/pglite@0.3.16 that arrived is not the published one this build pins (integrity …), so it was not loaded.',
              find: ' that arrived is not the published one this build pins (integrity ',
              from: 'server/src/db/upgrade.ts',
            },
          ],
          where: 'Terminal · upgrade',
          means: (
            <>
              Every refusal of the upgrade happens before anything moves and ends with{' '}
              <code>Nothing was touched.</code> The first: the path is not a data directory. The
              second: the engine that downloaded is not the one this build pins.
            </>
          ),
          todo: (
            <>
              Point <code>--upgrade-data</code> at the directory the server's own refusal named —{' '}
              <code>stma serve</code> keeps its data in <code>~/.stma/data</code>. For the engine,
              check which npm registry this machine uses, or set <code>STMA_UPGRADE_ENGINE</code> to
              a copy you trust.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'DATABASE_URL is required in production. For single-instance self-hosting without Postgres, set EMBEDDED_DB=1 and mount a volume for the data directory.',
              from: 'server/src/env.ts',
            },
          ],
          where: 'Server · boot',
          means: (
            <>
              A published server assumes production unless started with <code>--dev</code>, and
              production needs a database it can keep.
            </>
          ),
          todo: (
            <>
              Set <code>DATABASE_URL</code> to a PostgreSQL database, or <code>EMBEDDED_DB=1</code>{' '}
              with a persistent volume for one instance. For a private instance on one machine,{' '}
              <code>npx @matteai/stma serve</code> does all of this for you.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'TRUSTED_PROXY_CIDRS: "10.0.0.1" is not a CIDR range like 203.0.113.0/24 or 2001:db8::/32.',
              find: 'is not a CIDR range like 203.0.113.0/24 or 2001:db8::/32.',
              from: 'server/src/env.ts',
            },
          ],
          where: 'Server · boot',
          means: (
            <>
              An entry in the list of proxies the server trusts is not a range. A list that does not
              parse stops the boot, because a wrong one would let a client choose the address it is
              rate-limited by.
            </>
          ),
          todo: (
            <>
              Write every entry as <code>address/prefix</code> (<code>10.0.0.1/32</code> for one
              address), or use the keyword <code>cloudflare</code> behind Cloudflare.
            </>
          ),
        },
        {
          symptom: <>Two machines each ran the server and cannot see each other.</>,
          quotes: [
            { text: 'Cross-origin form submission rejected.', from: 'server/src/app.tsx' },
            { text: 'The MCP client sent an invalid OAuth request.', from: 'server/src/routes/oauth.tsx' },
          ],
          where: 'Browser · MCP client',
          means: (
            <>
              <code>npx @matteai/stma serve</code> on each machine is two private instances, not a
              connection. The two messages are what an instance says when it is reached through an
              address other than its own <code>BASE_URL</code> — behind a proxy, or by IP.
            </>
          ),
          todo: (
            <>
              Run <em>one</em> server, give it an address both machines can reach, and set{' '}
              <code>BASE_URL</code> to that address before connecting any client, which must use
              exactly <code>BASE_URL/mcp</code>. <code>localhost</code> only works on the machine
              hosting it.
            </>
          ),
        },
        {
          quotes: [
            {
              text: 'The server did not answer http://localhost:3000/health in 90s. Something else may be on port 3000 — try --port.',
              find: ' in 90s. Something else may be on port ',
              from: 'cli/src/serve.ts',
            },
            { text: 'stma: command not found', by: 'your shell' },
          ],
          where: 'Terminal · stma serve',
          means: (
            <>
              The first time, <code>stma serve</code> downloads the server, which can take longer
              than the wait on a slow line; a port that is taken usually makes the server exit
              instead. Installing from a source checkout needs the build first — there is no{' '}
              <code>prepack</code> step, so packing without building produces a tarball with no{' '}
              <code>dist</code> and no <code>stma</code> command.
            </>
          ),
          todo: (
            <>
              Run it again once the download has finished, or with <code>--port</code>. Build before
              installing from a checkout, or install the published package:{' '}
              <code>npm i -g @matteai/stma</code>.
            </>
          ),
        },
        {
          symptom: <>A tool or endpoint described in the guide answers 404.</>,
          quotes: [
            {
              text: 'The server reports version 0.15.0; this CLI is 0.16.0. If that endpoint is newer than the server, upgrade it (npm i -g @matteai/stma-server) or use a CLI of the same version.',
              find: '. If that endpoint is newer than the server, upgrade it (npm i -g @matteai/stma-server) or use a CLI of the same version.',
              from: 'cli/src/index.ts',
            },
          ],
          where: 'Terminal · browser',
          means: (
            <>
              Usually a version gap rather than a bug: the guide ships with the server, and your CLI
              may be older or newer.
            </>
          ),
          todo: (
            <>
              <code>stma version --server</code> prints both sides, and <code>GET /health</code>{' '}
              names the build on any instance. Upgrade whichever side is older.
            </>
          ),
        },
      ],
    },
  ];
}

/** Things reported as bugs by somebody testing the product, that are deliberate. */
const expectedNotes = (): { claim: string; body: unknown }[] => [
  {
    claim: 'STMA cannot wake your agent.',
    body: (
      <>
        Every call is started by a client that is already running. A closed agent did not ignore a
        handoff — it never heard about it. Open the client and ask it to check its STMA inbox.
      </>
    ),
  },
  {
    claim: 'A work claim is a warning, not a lock.',
    body: (
      <>
        Two agents can still edit the same file. STMA tells them, names who was there first, and
        records it.
      </>
    ),
  },
  {
    claim: 'Snapshots carry variable names, not values.',
    body: (
      <>
        A diff can tell you a machine is missing a variable; it can never tell you what to set it to.
        And a snapshot that reported no variable names at all is shown as <b>unchecked</b>, not as
        everything missing.
      </>
    ),
  },
  {
    claim: "The file guard only sees one client's file tools.",
    body: (
      <>
        A shell redirect, an editor, <code>git apply</code> or an agent connected by MCP alone all
        walk past it. "A rule stopped this" is evidence; "nothing got through another way" is not,
        and the page that reports a violation says so next to the count.
      </>
    ),
  },
  {
    claim: 'Revoking ends access, not the process.',
    body: (
      <>
        The agent stops being able to reach STMA. It keeps running, and its saved connection stays in
        the client until somebody removes it there.
      </>
    ),
  },
  {
    claim: 'A password reset leaves agent connections alone.',
    body: (
      <>
        A password never reached an agent credential, and revoking every teammate's agent over a
        forgotten password would be its own outage. If you think somebody else got into the account,
        also revoke the connections on <a href="/app/tokens">Agent connections</a> — that is the half
        a reset does not do.
      </>
    ),
  },
  {
    claim: "A “?” against a run's policy receipt means not reported.",
    body: (
      <>
        It is not drift. A run that never answered is unconfirmed; only a run reporting a different
        hash is a deviation. The product keeps the two apart on purpose, because claiming a rule was
        followed that nobody confirmed is the worst thing a readiness report can do.
      </>
    ),
  },
  {
    claim: 'A minute or two before an agent’s first STMA call is the client, not STMA.',
    body: (
      <>
        It is the client's permission mode: the same hook text walked straight through in one
        session's auto-approve mode and stopped to ask in another's default mode.
      </>
    ),
  },
  {
    claim: 'A ticket or branch-name warning is advice.',
    body: (
      <>
        If your workspace has a delivery flow, starting a run on a branch that breaks its pattern
        warns and never refuses. Do not rename a branch because of it; correct the flow's pattern, or
        ignore it.
      </>
    ),
  },
];

/** One entry: the words on screen, then what they mean, then what to do. */
const Wall = ({ entry }: { entry: HelpEntry }) => (
  <article class="wall">
    <div class="wall-top">
      <div class="wall-said">
        {entry.symptom ? <p class="wall-symptom">{entry.symptom}</p> : null}
        {(entry.quotes ?? []).map((quote) => (
          <>
            {/* Verbatim means verbatim: a quoted message that carries an address,
                even an example one, must not be rewritten by a CDN into
                "[email protected]" (ui/Mail.tsx). */}
            <NoScan>
              <p class="wall-msg">{quote.text}</p>
            </NoScan>
            {quote.by ? <span class="wall-by">Printed by {quote.by}, not by STMA.</span> : null}
          </>
        ))}
      </div>
      <span class="wall-where">{entry.where}</span>
    </div>
    <div class="wall-part">
      <span class="wall-lbl">What it means</span>
      <div>{entry.means}</div>
    </div>
    <div class="wall-part">
      <span class="wall-lbl">What to do</span>
      <div>{entry.todo}</div>
    </div>
  </article>
);

helpRoutes.get('/help', (c) => {
  const env = c.get('env');
  const user = c.get('user');
  // The same rule as the guide: a stranger pre-launch is here for the half they
  // can actually reach, and an index may not point at a section that is not there.
  const showConsole = Boolean(user) || env.publicMode === 'full';
  const billing = c.get('capabilities').managedBilling;
  const support = env.supportEmail;
  const privacy = env.privacyEmail;

  // Every door it draws is a door that is there: plan ceilings only where plans
  // decide something, the beta's billing page only while that page says this.
  const sections = helpSections({ hosted: env.hosted, beta: env.betaUnmetered })
    .filter((section) => (showConsole || !section.console) && (!section.hosted || env.hosted))
    .map((section) => ({
      ...section,
      entries: section.entries.filter(
        (entry) => (billing || !entry.billing) && (env.betaUnmetered || !entry.beta),
      ),
    }))
    .filter((section) => section.entries.length > 0);
  const notes = expectedNotes();
  const index = [
    ...sections.map((s) => ({ id: s.id, title: s.title, blurb: s.blurb, count: `${s.entries.length} entries` })),
    { id: 'expected', title: 'Working as intended', blurb: 'Reported as bugs, and deliberate', count: `${notes.length} notes` },
    { id: 'ask', title: 'Still stuck', blurb: 'Where to write, and what to put in it', count: '' },
  ];

  const body = (
    <>
      <div class="docgrid">
        <nav class="sidetoc helptoc" aria-label="Sections">
          {index.map((item) => (
            <a href={`#${item.id}`}>{item.title}</a>
          ))}
        </nav>
        <div class="doc-col" style="max-width:none">
          <div>
            <h1 class="title" style="font-size:30px">
              When it goes wrong
            </h1>
            <p class="sub" style="max-width:68ch">
              Find the message you are looking at. Each entry quotes it the way the product prints
              it — example values filled in where the product fills in its own — then says what it
              means and the exact thing to type or click. For how the product works, read the{' '}
              <a href="/docs">guide</a> instead.
            </p>
          </div>

          <nav class="helpidx" aria-label="Index">
            {index.map((item) => (
              <a href={`#${item.id}`}>
                <b>{item.title}</b>
                <span>{item.blurb}</span>
                {item.count ? <span class="count">{item.count}</span> : null}
              </a>
            ))}
          </nav>

          {sections.map((section) => (
            <section class="doc-section" id={section.id}>
              <h2>{section.title}</h2>
              {section.intro ? <p class="m0">{section.intro}</p> : null}
              <div class="walls">
                {section.entries.map((entry) => (
                  <Wall entry={entry} />
                ))}
              </div>
            </section>
          ))}

          <section class="doc-section" id="expected">
            <h2>Working as intended</h2>
            <p class="m0 sub" style="max-width:72ch">
              Each of these has been reported as a bug by somebody testing the product. They are
              deliberate, and knowing which is which saves an hour.
            </p>
            <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px">
              {notes.map((fact) => (
                <div class="factrow">
                  <span class="y">✓</span>
                  <span>
                    <em>{fact.claim}</em> {fact.body}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section class="doc-section" id="ask">
            <h2>Still stuck</h2>
            <p class="m0">
              {support ? (
                <>
                  Write to <Mail to={support} />, from the address on the
                  account.
                </>
              ) : (
                <>
                  This instance publishes no support address, so the person who runs it is the one
                  to ask. If that is you, set <code>SUPPORT_EMAIL</code> and it will appear here and
                  on the sign-in pages.
                </>
              )}{' '}
              Include the exact message, what you typed or clicked just before it, and the version
              below. Never include a password, a six-digit code, a setup code or a token: none of
              them helps answer the question, and an email is the wrong place for all four.
            </p>
            {privacy ? (
              <p class="m0">
                A request about your personal data — a copy of it, a correction, its deletion, under
                the GDPR or the KVKK — goes to <Mail to={privacy} /> instead,
                which is where those requests are answered. The{' '}
                <a href="/privacy">privacy policy</a> says what is kept and for how long.
              </p>
            ) : null}
            <p class="m0 small muted">
              This instance is running <b>v{VERSION}</b>. <code>GET /health</code> reports the same
              string, and <code>stma version --server</code> prints it next to your CLI's. The full
              guide is at <a href="/docs">/docs</a>; its{' '}
              <a href="/docs#troubleshooting">troubleshooting table</a> covers the MCP surface in
              more detail than this page does.
            </p>
          </section>
        </div>
      </div>
    </>
  );

  // Signed in: keep the console shell so the way back does not disappear —
  // somebody who is stuck should not also lose their navigation.
  if (user) {
    return c.html(
      <AppLayout user={user} title="Help">
        {body}
      </AppLayout>,
    );
  }

  return c.html(
    <SitePage site={siteInfo(c)} title="Help" active="help"
      description="When STMA says no: the exact messages the product prints, what each one means and what to do next.">
      <main class="container page">{body}</main>
    </SitePage>,
  );
});
