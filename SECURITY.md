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
