# Security policy

STMA sits between a company's coding agents and their machines, so a flaw here can
reach further than the service itself. Reports are welcome and taken seriously.

## Reporting a vulnerability

Email **support@stma.ai** with enough detail to reproduce: the endpoint or tool,
the request, what you expected and what happened. One mailbox, read by the people
who can act on it: a separate `security@` address that nobody watches is worse
than none, because a report to it looks delivered and is not. A proof-of-concept helps; a
video is never required.

- We acknowledge within **3 business days** and give a first assessment within **7**.
- We will tell you when a fix ships, and credit you in the release notes unless you
  prefer otherwise.
- Please give us **90 days** before public disclosure, or less if we agree on it.

Do not open a public GitHub issue for a suspected vulnerability.

## Scope

In scope: the hosted service at `stma.ai`, this repository, and the published
`@matteai/stma` and `@matteai/stma-server` npm packages.

Out of scope: our internal staging environment (it is not published, and its data is
disposable), denial of service through raw volume, social engineering, and findings that
require a compromised developer machine — an agent that has already been taken
over on someone's laptop can act as that person by design.

## What we ask you not to do

Do not access data belonging to a team you were not invited to, and do not run
automated scanners against the hosted service. If a proof-of-concept needs a
second account, sign up for one with another address you control — the hosted
service is a public beta — or run your own instance with `npx @matteai/stma serve`.

## What the product deliberately does

These are design decisions, not oversights:

- **Environment snapshots carry names, never values.** Environment variable names,
  tool versions, lockfile hashes and git metadata are collected; values and file
  contents are not.
- **Peer content is untrusted data.** Messages from another person's agent are
  framed as data rather than instructions, and the server cannot start anything on a
  machine: agents call it, it never calls them.
- **Tokens are stored as SHA-256 hashes** and shown exactly once.
- **Work claims are advisory.** They warn about collisions; they do not lock files.
  An agent can ignore a warning. With the local hooks, a supported client's file-tool
  edit on ground another run holds is refused; a shell command is not.
- **Shared limits, except per-address ones.** Account-keyed rate limits, sign-in
  throttling and the agent loop guard count in the database, so they hold across
  replicas. Per-IP limits on unauthenticated routes stay in each instance's memory,
  so with several replicas they are proportionally more generous.

## Handling secrets that reach us anyway

Message bodies, attachments, announcements and error records pass through
server-side redaction for common credential shapes before storage. This is
defense in depth, not a guarantee — if you believe a real secret was stored,
email the address above and we will purge it.

## What we hold and what we do not promise

STMA stores what a client or a person sends it: environment variable names but never
values, git metadata, run records, and the text people and their agents write into
messages, briefs and Knowledge records. It cannot promise that a secret never arrives
in text somebody wrote. Revoking a connection ends its access to the server; it does not
stop a process already running on your machine and it does not revoke GitHub, Azure
DevOps, Jira or ClickUp tokens at those providers.

Not promised:

- A SOC 2 or ISO 27001 certification, or any other third-party audit report.
- A legal hold, or retention beyond the periods in the Privacy Policy.
- High availability, or a recovery point or recovery time objective.
- Data residency beyond the hosting region the Privacy Policy names.
- An uptime commitment or a support response time, outside a signed order. The acknowledgement and
  assessment targets under "Reporting a vulnerability" are targets for security reports, not a service level.

The full statement is at https://stma.ai/docs#trust.
