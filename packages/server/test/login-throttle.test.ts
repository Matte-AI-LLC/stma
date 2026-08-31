import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { mailOutbox } from '../src/lib/mailer';
import { startServer, type StartedServer } from '../src/server';

/**
 * Guessing at somebody's password used to be free.
 *
 * `/auth/*` was limited by IP at 30 requests a minute and nothing else, so seven
 * wrong passwords against one account got the same answer as one, at the same
 * speed, and the account holder was never told it had happened.
 *
 * Its own file because it spends a dozen `/auth/*` requests and the IP limit is
 * shared with every other test in the same process.
 */

let srv: StartedServer;
let dataDir: string;

const VICTIM = 'victim@example.com';
const RIGHT = 'correct-horse-battery';

const post = (url: string, body: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

/** The message a redirect carries back to /login, decoded. */
const errorOf = (res: Response): string =>
  new URL(res.headers.get('location')!, srv.url).searchParams.get('error') ?? '';

const attempt = (email: string, password: string) =>
  post(`${srv.url}/auth/local/login`, { email, password });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'stma-throttle-'));
  srv = await startServer(
    loadEnv({
      port: 0,
      host: 'localhost',
      nodeEnv: 'test',
      devMode: true,
      databaseUrl: undefined,
      pgliteDir: dataDir,
    }),
  );
  await post(`${srv.url}/auth/local/signup`, { email: VICTIM, password: RIGHT });
  mailOutbox.clear();
});

afterAll(async () => {
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it('makes a run of wrong passwords wait, and tells the account holder', async () => {
  for (let i = 0; i < 4; i++) {
    const res = await attempt(VICTIM, `wrong-${i}`);
    expect(errorOf(res), `attempt ${i + 1} still just fails`).toBe('Invalid email or password.');
  }
  expect(mailOutbox.latest(VICTIM), 'four wrong guesses is not news').toBeUndefined();

  const fifth = await attempt(VICTIM, 'wrong-4');
  expect(errorOf(fifth)).toContain('Too many sign-in attempts');

  const mail = mailOutbox.latest(VICTIM);
  expect(mail?.subject).toBe('Failed sign-in attempts on your STMA account');
  expect(mail?.text).toContain('revoke any agent tokens');

  // Enforced even when the password is right. A throttle a correct guess walks
  // through is not a throttle, and answering differently for the right password
  // would make it an oracle for exactly the thing being guessed at.
  const correct = await attempt(VICTIM, RIGHT);
  expect(errorOf(correct)).toContain('Too many sign-in attempts');

  // And once per window, not once per guess.
  const mails = mailOutbox.all().filter((m) => m.to === VICTIM);
  expect(mails).toHaveLength(1);
});

it('counts per address, and a success ends the run before it', async () => {
  const other = 'bystander@example.com';
  await post(`${srv.url}/auth/local/signup`, { email: other, password: RIGHT });

  // The locked account next door changes nothing here.
  for (let i = 0; i < 3; i++) {
    const res = await attempt(other, `wrong-${i}`);
    expect(errorOf(res)).toBe('Invalid email or password.');
  }
  const ok = await attempt(other, RIGHT);
  expect(ok.status).toBe(302);
  expect(ok.headers.get('location')).toBe('/app');

  // Three more would trip a counter that had kept the earlier three.
  for (let i = 0; i < 3; i++) {
    const res = await attempt(other, `wrong-again-${i}`);
    expect(errorOf(res), 'a successful sign-in cleared the run').toBe(
      'Invalid email or password.',
    );
  }
});

it('says the same thing to an address that has no account', async () => {
  const nobody = 'nobody@example.com';
  for (let i = 0; i < 4; i++) {
    expect(errorOf(await attempt(nobody, `wrong-${i}`))).toBe('Invalid email or password.');
  }
  // Same wording, same timing, same lock — the throttle cannot be used to ask
  // whether an account exists, and nothing was mailed anywhere.
  expect(errorOf(await attempt(nobody, 'wrong-4'))).toContain('Too many sign-in attempts');
  expect(mailOutbox.latest(nobody)).toBeUndefined();
});
