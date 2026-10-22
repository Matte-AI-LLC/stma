import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { DOCTYPE, withDoctype } from '../src/lib/doctype';
import { startServer, type StartedServer } from '../src/server';

/**
 * A page with no doctype is drawn in quirks mode (`document.compatMode` is
 * `BackCompat`): a line box ignores its strut, a form carries a bottom margin,
 * a table does not inherit its font size. Every page here is `c.html(<Page />)`
 * with an `<html>` root and nothing in front of it, so the doctype is added
 * where the response leaves (`lib/doctype.ts`). This is the suite that says no
 * shell escapes it: the signed-out site, the console, the operator pages and the
 * answers to a URL that is not one.
 */

describe('withDoctype', () => {
  const app = new Hono();
  app.use('*', withDoctype);
  app.get('/page', (c) => {
    c.header('x-kept', 'yes');
    c.header('set-cookie', 'a=1; Path=/');
    c.header('set-cookie', 'b=2; Path=/', { append: true });
    return c.html('<html lang="en"><head></head><body>hi</body></html>', 422);
  });
  app.get('/spaced', (c) => c.html('\n  <HTML lang="en"><body>hi</body></HTML>'));
  app.get('/own', (c) => c.html('<!DOCTYPE html><html><body>own</body></html>'));
  app.get('/lower', (c) => c.html('<!doctype html><html><body>own</body></html>'));
  app.get('/fragment', (c) => c.html('<div>not a document</div>'));
  app.get('/json', (c) => c.json({ html: '<html>' }));
  app.get('/text', (c) => c.text('<html>plain</html>'));
  app.get('/stream', (c) =>
    c.body('<html>', 200, { 'content-type': 'text/event-stream; charset=utf-8' }),
  );
  app.get('/empty', (c) => c.redirect('/page'));

  const get = (p: string) => app.request(p, { redirect: 'manual' });

  it('puts the doctype in front of an <html> root and keeps everything else', async () => {
    const res = await get('/page');
    expect(await res.text()).toBe(`${DOCTYPE}<html lang="en"><head></head><body>hi</body></html>`);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('x-kept')).toBe('yes');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('reads the root past leading whitespace and in any case', async () => {
    expect((await (await get('/spaced')).text()).startsWith(DOCTYPE)).toBe(true);
  });

  it('leaves a body that already has a doctype alone, so a page can print its own', async () => {
    expect(await (await get('/own')).text()).toBe('<!DOCTYPE html><html><body>own</body></html>');
    expect(await (await get('/lower')).text()).toBe('<!doctype html><html><body>own</body></html>');
  });

  it('touches only an <html> document', async () => {
    expect(await (await get('/fragment')).text()).toBe('<div>not a document</div>');
    expect(await (await get('/json')).json()).toEqual({ html: '<html>' });
    expect(await (await get('/text')).text()).toBe('<html>plain</html>');
    const stream = await get('/stream');
    expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(await stream.text()).toBe('<html>');
    const redirect = await get('/empty');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/page');
  });
});

describe('every shell is drawn in standards mode', () => {
  let srv: StartedServer;
  let dataDir: string;
  let ada: Record<string, string> = {};
  let bo: Record<string, string> = {};
  let inviteCode = '';

  const cookieHeader = (cookies: Map<string, string>) => ({
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  });

  async function signIn(username: string) {
    const res = await fetch(`${srv.url}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const cookies = new Map<string, string>();
    for (const line of res.headers.getSetCookie()) {
      const [kv] = line.split(';');
      const i = kv!.indexOf('=');
      cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
    return cookieHeader(cookies);
  }

  const post = (p: string, body: Record<string, string>, headers: Record<string, string>) =>
    fetch(`${srv.url}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });

  beforeAll(async () => {
    process.env.ADMIN_USERNAMES = 'ada';
    dataDir = mkdtempSync(path.join(tmpdir(), 'stma-doctype-'));
    srv = await startServer(
      loadEnv({
        port: 0,
        host: '127.0.0.1',
        nodeEnv: 'test',
        devMode: true,
        databaseUrl: undefined,
        pgliteDir: dataDir,
      }),
    );
    ada = await signIn('ada');
    expect((await post('/app/teams', { name: 'Standards' }, ada)).status).toBe(302);
    await post('/app/teams/standards/invites', {}, ada);
    const teamPage = await (await fetch(`${srv.url}/app/teams/standards?tab=people`, { headers: ada })).text();
    inviteCode = /\/join\/([A-Za-z0-9_-]+)/.exec(teamPage)?.[1] ?? '';
    expect(inviteCode, 'invite code').toBeTruthy();
    bo = await signIn('bo');
  }, 60_000);

  afterAll(async () => {
    delete process.env.ADMIN_USERNAMES;
    await srv?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The page's first bytes, and how many doctypes it carries: one, and first. */
  async function shell(p: string, headers: Record<string, string> = {}, status = 200) {
    const res = await fetch(`${srv.url}${p}`, { headers });
    expect(res.status, p).toBe(status);
    expect(res.headers.get('content-type'), p).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html.startsWith(`${DOCTYPE}<html lang="en">`), `${p} starts with ${html.slice(0, 40)}`).toBe(true);
    expect(html.match(/<!doctype/gi)?.length, `${p} doctypes`).toBe(1);
    return html;
  }

  it('the signed-out site: landing, guide, help, legal and the doors', async () => {
    for (const p of ['/', '/docs', '/help', '/terms', '/privacy', '/login', '/signup']) {
      await shell(p);
    }
  });

  it('a URL that is not one, signed out and signed in', async () => {
    await shell('/no-such-page', {}, 404);
    await shell('/no-such-page', ada, 404);
    await shell('/app/no-such-page', ada, 404);
  });

  it('an invitation, for a stranger and for a member', async () => {
    await shell(`/join/${inviteCode}`);
    await shell(`/join/${inviteCode}`, bo);
  });

  it('the console: workspace, project and account pages', async () => {
    const t = '/app/teams/standards';
    const pages = [
      '/app',
      '/app/account',
      '/app/notifications',
      t,
      `${t}?tab=people`,
      `${t}?tab=integrations`,
      `${t}?tab=settings`,
      `${t}/projects`,
      `${t}/agents`,
      `${t}/activity`,
      `${t}/compare`,
      `${t}/attention`,
      `${t}/knowledge`,
      `${t}/governance`,
      `${t}/policy`,
      `${t}/delivery`,
      `${t}/repositories`,
      `${t}/connections`,
      `${t}/people/ada`,
      '/app/agents?team=standards',
      '/app/handoffs?team=standards',
      '/app/sessions?team=standards',
    ];
    for (const p of pages) await shell(p, ada);
  });

  it('the operator console', async () => {
    for (const p of ['/admin', '/admin/users', '/admin/teams', '/admin/ops', '/admin/beta', '/admin/usage', '/admin/crm']) {
      await shell(p, ada);
    }
  });

  it('what is not a page is left as it was', async () => {
    const health = await fetch(`${srv.url}/health`);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    const missing = await fetch(`${srv.url}/api/no-such-route`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    const css = await (await fetch(`${srv.url}/style.css`)).text();
    expect(css.startsWith(DOCTYPE)).toBe(false);
    const redirect = await fetch(`${srv.url}/app`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toMatch(/^\/login/);
  });
});
