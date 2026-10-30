import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotSchema } from '@bridge/shared';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnrollments, authCodes, oauthAuthorizationCodes, oauthRefreshTokens, tokens, webSessions } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { PLANS } from '../src/lib/entitlements';
import { startServer, type StartedServer } from '../src/server';

/**
 * The trust statements, pinned to the code that makes them true.
 *
 * `/docs#trust`, SECURITY.md and the Privacy Policy say what STMA holds, what a
 * revoke does and does not do, and what is not promised. A statement of that
 * kind goes stale silently: nothing throws when a schema grows a field or a
 * retention default moves. So each sentence that can be checked against code is
 * checked here, and the ones that cannot (a certification, an uptime figure) are
 * checked in the other direction: they must not appear.
 *
 * This file ships in the public tree. It reads packages/ and the three public
 * documents and nothing else.
 */

const root = path.resolve(__dirname, '../../..');
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

/** Visible words of a page: tags dropped, entities decoded, whitespace collapsed. */
const words = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// The whole point of these lists is that they say the same thing in both places.
const NOT_PROMISED = [
  'SOC 2 or ISO 27001 certification',
  'legal hold',
  'high availability',
  'recovery point or recovery time objective',
  'data residency beyond',
  'uptime commitment',
];

describe('what the server can do to your machine', () => {
  it('starts no process, except the one offline data upgrade the operator asks for', () => {
    const sources = walk(path.join(root, 'packages/server/src')).filter((file) => /\.(ts|tsx|mjs|js)$/.test(file));
    expect(sources.length).toBeGreaterThan(100);
    const importing = sources
      .filter((file) => /\bchild_process\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(path.join(root, 'packages/server/src'), file).replaceAll('\\', '/'));
    // `--upgrade-data` runs on the operator's own machine, before the server
    // listens. Nothing reachable from a request imports it. A new entry here is
    // a decision, because the Landing page and the guide say the server cannot
    // start a process on your machine.
    expect(importing).toEqual(['db/upgrade.ts']);
  });

  it('holds the same for the private composition the hosted service runs, where it is present', () => {
    // The Landing sentence is about stma.ai, which runs core plus ee/. This file ships in the public tree, which
    // has no ee/, so the scan is skipped there rather than failing.
    const eeSrc = path.join(root, 'ee/src');
    let present = true;
    try { statSync(eeSrc); } catch { present = false; }
    if (!present) return;
    const sources = walk(eeSrc).filter((file) => /\.(ts|tsx|mjs|js)$/.test(file));
    expect(sources.length).toBeGreaterThan(10);
    const importing = sources.filter((file) => /\bchild_process\b/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(eeSrc, file).replaceAll('\\', '/'));
    expect(importing).toEqual([]);
  });
});

describe('how credentials are stored', () => {
  it('keeps a digest of every credential, and no column that could hold the secret', () => {
    // Personal and OAuth access tokens, refresh tokens, authorization and
    // enrollment codes: each is looked up by the digest of what the client
    // presents, so the database never holds a value that could be replayed.
    for (const [name, table] of Object.entries({ tokens, oauthRefreshTokens, oauthAuthorizationCodes, agentEnrollments, authCodes })) {
      const columns = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(columns.filter((column) => /hash/.test(column)).length, `${name} stores a digest`).toBeGreaterThan(0);
      expect(columns.filter((column) => /^(token|secret|code|refresh_token|access_token|plaintext)$/.test(column)), `${name} has a column that could hold the secret`).toEqual([]);
    }
    // The sign-in code the Landing page names: the row holds sha256 of the six digits, and the one function that
    // writes it is the one the other credentials use.
    expect(readFileSync(path.join(root, 'packages/server/src/lib/crypto.ts'), 'utf8')).toMatch(/createHash\('sha256'\)/);
    expect(readFileSync(path.join(root, 'packages/server/src/auth/codes.ts'), 'utf8')).toContain("import { sha256hex } from '../lib/crypto'");
    // A browser session is looked up by its id, which is the cookie value; the page lists
    // sessions by a digest of the id for that reason, and the table keeps no password.
    const sessionColumns = Object.values(getTableColumns(webSessions)).map((column) => column.name);
    expect(sessionColumns.filter((column) => /password/.test(column))).toEqual([]);
  });
});

describe('what the collector sends', () => {
  const valid = {
    os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' },
    shell: '/bin/zsh',
    runtimes: { node: '24.12.0' },
    packageManagers: { npm: '11.6.2' },
    lockfiles: [{ path: 'package-lock.json', hash: 'abc123' }],
    envVarNames: ['PATH', 'HOME'],
    git: { branch: 'main', sha: '0123456789abcdef', dirtyFiles: ['src/eta.mjs'], aheadBehind: '0 0' },
    locale: 'en_US',
    timezone: 'Europe/Istanbul',
    collectedAt: '2026-10-22T00:00:00Z',
  };

  it('has exactly the documented fields, and rejects any other top-level field', () => {
    expect(Object.keys(snapshotSchema.shape).sort()).toEqual(
      [
        'schemaVersion', 'os', 'shell', 'runtimes', 'packageManagers', 'lockfiles',
        'envVarNames', 'git', 'locale', 'timezone', 'collectedAt',
      ].sort(),
    );
    expect(snapshotSchema.safeParse(valid).success).toBe(true);
    // The shape that would carry values.
    expect(snapshotSchema.safeParse({ ...valid, env: { SECRET: 'x' } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...valid, files: { '.env': 'SECRET=x' } }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...valid, envVars: { SECRET: 'x' } }).success).toBe(false);
  });

  it('holds environment variables as names only', () => {
    expect(snapshotSchema.safeParse({ ...valid, envVarNames: [{ name: 'A', value: 'x' }] }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...valid, envVarNames: { A: 'x' } }).success).toBe(false);
    // Nothing in the schema is called a value, at any depth.
    const keys = (shape: Record<string, unknown>): string[] =>
      Object.entries(shape).flatMap(([key, field]) => {
        const inner = (field as { _def?: { innerType?: unknown; shape?: () => Record<string, unknown>; type?: unknown } })._def;
        const nested =
          inner?.shape?.() ??
          (inner?.innerType as { _def?: { shape?: () => Record<string, unknown> } } | undefined)?._def?.shape?.() ??
          (inner?.type as { _def?: { shape?: () => Record<string, unknown> } } | undefined)?._def?.shape?.();
        return [key, ...(nested ? keys(nested) : [])];
      });
    const all = keys(snapshotSchema.shape);
    expect(all).toContain('dirtyFiles');
    expect(all.filter((key) => /value|secret|content|token/i.test(key))).toEqual([]);
  });

  it('keeps git state to strings: a branch, a commit and the paths of modified files', () => {
    expect(snapshotSchema.safeParse({ ...valid, git: { ...valid.git, dirtyFiles: [{ path: 'a', diff: '+x' }] } }).success).toBe(false);
    const parsed = snapshotSchema.parse({ ...valid, git: { ...valid.git, diff: '+SECRET=1', content: 'x' } });
    // A field the schema does not name is dropped, not stored.
    expect(Object.keys(parsed.git ?? {}).sort()).toEqual(['aheadBehind', 'branch', 'dirtyFiles', 'sha']);
  });
});

describe('the pages that make the statements', () => {
  let full: StartedServer;
  let teaser: StartedServer;
  const dirs: string[] = [];
  const BASE = { port: 0, host: '127.0.0.1', nodeEnv: 'test' as const, devMode: false, databaseUrl: undefined };

  beforeAll(async () => {
    for (const name of ['full', 'teaser']) dirs.push(mkdtempSync(path.join(tmpdir(), `stma-trust-${name}-`)));
    full = await startServer(loadEnv({ ...BASE, pgliteDir: dirs[0], hosted: true }));
    teaser = await startServer(loadEnv({ ...BASE, pgliteDir: dirs[1], hosted: true, publicMode: 'teaser' }));
  });

  afterAll(async () => {
    await full?.close();
    await teaser?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const get = async (srv: StartedServer, route: string) => {
    const res = await fetch(`${srv.url}${route}`);
    expect(res.status, `${route} is public`).toBe(200);
    return res.text();
  };

  const trustSlice = (html: string) => {
    const start = html.indexOf('id="trust"');
    expect(start, 'the guide has a Data and trust section').toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</section>', start));
  };

  it('shows the Data and trust section to a signed-out reader, in both site modes', async () => {
    for (const [mode, srv] of [['full', full], ['teaser', teaser]] as const) {
      const html = await get(srv, '/docs');
      expect(html, `${mode}: the contents list links it`).toContain('href="#trust"');
      const text = words(trustSlice(html));
      expect(text).toContain('Data and trust');
      // What the collector sends, and that values are not part of it.
      expect(text).toContain('a field outside it is rejected or dropped');
      expect(text).toContain('Environment variable values and file contents are not part of it.');
      // What only people and agents type, and the promise STMA cannot make.
      expect(text).toContain('cannot promise that a secret never arrives');
      // A revoke ends server access and nothing more.
      expect(text).toContain('does not stop an agent process that is already running on your machine');
      for (const provider of ['GitHub', 'Azure DevOps', 'Jira', 'ClickUp']) expect(text).toContain(provider);
      expect(text).toContain('revoking the token at the provider is yours to do');
      // Pointers rather than a second copy of the numbers.
      expect(html).toContain('href="/privacy#retention"');
      expect(html).toContain('href="/terms#deletion"');
      expect(text).toContain('there is no export of a whole workspace');
      for (const item of NOT_PROMISED) expect(text.toLowerCase(), `${mode}: not promised: ${item}`).toContain(item.toLowerCase());
      // The owner's copy rule: no em dash in anything new.
      expect(trustSlice(html), `${mode}: the section has an em dash`).not.toContain('\u2014');
      expect(trustSlice(html)).not.toContain('&mdash;');
    }
  });

  it('prints retention periods that equal the defaults the sweep uses', async () => {
    const env = loadEnv({ ...BASE, pgliteDir: dirs[0], hosted: true });
    const page = words(await get(full, '/privacy'));
    // The retention table, not the earlier section that lists the same data classes.
    const privacy = page.slice(page.lastIndexOf('How long we keep it'));
    const row = (label: string, figure: RegExp) => {
      const at = privacy.indexOf(label);
      expect(at, `/privacy lists "${label}"`).toBeGreaterThan(-1);
      expect(privacy.slice(at, at + 400), `${label}: ${figure}`).toMatch(figure);
    };
    row('Browser sessions', new RegExp(`at most ${env.sessionTtlDays} days after sign-in`));
    row('Environment snapshots', new RegExp(`${env.snapshotRetentionDays} days, and never more than the 20 newest`));
    row('Error records', new RegExp(`${env.errorRetentionDays} days`));
    row('Announcements', new RegExp(`${env.activityRetentionDays} days`));
    row('Workspace activity log and agent run trail', new RegExp(`${PLANS.free.retentionDays} days on the free plan`));
    // And the defaults are the numbers the trust section points at.
    expect([env.sessionTtlDays, env.snapshotRetentionDays, env.errorRetentionDays, env.activityRetentionDays, PLANS.free.retentionDays]).toEqual([30, 90, 30, 180, 90]);
  });
});

describe('the public documents', () => {
  it('SECURITY.md carries the same not-promised list and points at the guide', () => {
    const text = read('SECURITY.md').replace(/\s+/g, ' ').toLowerCase();
    for (const item of NOT_PROMISED) expect(text, `SECURITY.md: ${item}`).toContain(item.toLowerCase());
    expect(read('SECURITY.md')).toContain('https://stma.ai/docs#trust');
    expect(text).toContain('does not revoke github, azure devops, jira or clickup tokens');
    // The owner's copy rule applies to what is new; older paragraphs keep their dashes.
    expect(read('SECURITY.md').slice(read('SECURITY.md').indexOf('## What we hold'))).not.toContain('\u2014');
  });

  it('does not promise a response time in one place and disclaim it in another', () => {
    const security = read('SECURITY.md').replace(/\s+/g, ' ');
    // The reporting targets are real targets; what is not promised is a support service level.
    expect(security).toContain('We acknowledge within **3 business days**');
    expect(security).toContain('An uptime commitment or a support response time, outside a signed order.');
    expect(security).toContain('targets for security reports, not a service level');
    const docs = read('packages/server/src/routes/docs.tsx').replace(/\s+/g, ' ');
    expect(docs).toContain('An uptime commitment or a support response time, outside a signed order.');
  });

  it('says who can export the activity log the way the route authorizes it', () => {
    // docs.tsx once said only an owner could; the route admits any member.
    const docs = read('packages/server/src/routes/docs.tsx').replace(/\s+/g, ' ');
    expect(docs).toContain('A workspace member can export the activity log as CSV');
    const route = read('packages/server/src/routes/activity.tsx');
    const handler = route.slice(route.indexOf('const activityCsv'), route.indexOf('const activityCsv') + 1200);
    expect(handler).toContain('teamForMember(');
    expect(handler).not.toMatch(/role\s*[!=]==?\s*'owner'|isOwner|requireOwner|teamForOwner/);
  });

  it('claims no certification, audit report or uptime figure anywhere it speaks for the product', () => {
    const files = [
      'README.md',
      'SECURITY.md',
      'PRODUCT_FLOWS.md',
      'packages/server/src/ui/Landing.tsx',
      'packages/server/src/routes/docs.tsx',
      'packages/server/src/routes/help.tsx',
      'packages/server/src/routes/legal.tsx',
    ];
    // Said as a refusal ("not promised") these words are fine; as an assertion
    // they are not. The phrases below only occur as assertions.
    const asserted = [
      /SOC ?2[- ](?:type|compliant|compliance|certified|certification|attested|attestation)/i,
      // "SOC 2 or ISO 27001 certification" is the refusal itself, so a second standard after "or" is not an assertion.
      /(?<!or )ISO ?27001[- ](?:compliant|compliance|certified|certification)/i,
      /\b(?:we are|is|are|be|being|fully|now) (?:SOC ?2|ISO ?27001|GDPR|HIPAA)[- ]?(?:compliant|certified)/i,
      /\bHIPAA\b/i,
      /guaranteed uptime/i,
      /\b99\.9+ ?%/,
      /\b(?:uptime|availability) (?:sla|guarantee)\b/i,
    ];
    for (const file of files) {
      const text = read(file);
      for (const pattern of asserted) expect(text, `${file} must not assert ${pattern}`).not.toMatch(pattern);
    }
  });

  it('leaks no private identifier into the new public text', () => {
    // Spelled as joins so this file does not match the scan it exists to satisfy.
    const forbidden = [['docs', 'business'].join('/'), ['stma', 'internal'].join('-'), ['stma', 'kv', '3ca9'].join('-')];
    const docs = read('packages/server/src/routes/docs.tsx');
    const slice = docs.slice(docs.indexOf('id="trust"'), docs.indexOf('</section>', docs.indexOf('id="trust"')));
    for (const [name, text] of [['docs trust section', slice], ['SECURITY.md', read('SECURITY.md')], ['README.md', read('README.md')]] as const) {
      for (const needle of forbidden) expect(text, `${name} contains a private identifier`).not.toContain(needle);
    }
  });

  it('shows the README client table with the levels the code implements', () => {
    const readme = read('README.md');
    const at = readme.indexOf('## Client support');
    expect(at).toBeGreaterThan(-1);
    const table = readme.slice(at, readme.indexOf('## Beyond the first reply'));
    expect(table).toMatch(/\| Claude Code \| yes \| yes \| yes, for Edit, Write, MultiEdit and NotebookEdit \|/);
    expect(table).toMatch(/\| Codex \| yes \| yes, after you trust them at `\/hooks` \|/);
    expect(table).toMatch(/\| Cursor \| yes \| lifecycle events only \| no \|/);
    expect(table).toMatch(/\| Any other MCP client \| yes \| no \| no \|/);
    // What the table says about the guard has to be what the adapter code refuses.
    expect(readFileSync(path.join(root, 'packages/cli/src/adapters.ts'), 'utf8')).toContain(
      'The synchronous file guard is currently supported only for Claude Code and Codex.',
    );
    expect(table).not.toContain('\u2014');
  });
});
