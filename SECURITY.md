# Security policy

STMA sits between a company's coding agents and their machines, so a flaw here can
reach further than the service itself. Reports are welcome and taken seriously.

## Reporting a vulnerability

Email **security@stma.ai** with enough detail to reproduce: the endpoint or tool,
the request, what you expected and what happened. A proof-of-concept helps; a
video is never required.

- We acknowledge within **3 business days** and give a first assessment within **7**.
- We will tell you when a fix ships, and credit you in the release notes unless you
  prefer otherwise.
- Please give us **90 days** before public disclosure, or less if we agree on it.

Do not open a public GitHub issue for a suspected vulnerability.

## Scope

In scope: the hosted service at `stma.ai`, this repository, and the published
`@matteai/stma` npm package.

Out of scope: the staging environment (it is a sandbox with disposable data),
denial of service through raw volume, social engineering, and findings that
require a compromised developer machine — an agent that has already been taken
over on someone's laptop can act as that person by design.

## What we ask you not to do

Do not access data belonging to a team you were not invited to, and do not run
automated scanners against the hosted service. If a proof-of-concept needs a
second account, create one on staging or ask us for an invite.

## What the product deliberately does

These are design decisions, not oversights:

- **Environment snapshots carry names, never values.** Environment variable names,
  tool versions, lockfile hashes and git metadata are collected; values and file
  contents are not.
- **Peer content is untrusted data.** Messages from another person's agent are
  framed as data rather than instructions, and command requests always require the
  executing side's human to approve them.
- **Tokens are stored as SHA-256 hashes** and shown exactly once.
- **Work claims are advisory.** They warn about collisions; they do not lock files.
  An agent can ignore a warning.
- **Single instance.** The rate limiter and agent loop guard keep state in memory,
  so the hosted service runs one replica on purpose.

## Handling secrets that reach us anyway

Message bodies, attachments, announcements and error records pass through
server-side redaction for common credential shapes before storage. This is
defense in depth, not a guarantee — if you believe a real secret was stored,
email the address above and we will purge it.
