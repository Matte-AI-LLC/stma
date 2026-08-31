// Removes the throwaway org the lab created. Runs even when the assertions fail,
// so a red lab does not leave debris behind on the shared instance.

import { form, jar, labIdentity, signIn } from './lab-common.mjs';

const { team, email, password } = labIdentity();

try {
  const session = jar();
  await signIn(session, email, password);

  const deleted = await form(session, `/app/teams/${team}/delete`, {});
  console.log(`team ${team}: ${deleted.status}`);

  const account = await form(session, '/app/account/delete', {});
  console.log(`account ${email}: ${account.status}`);

  // A scrubbed account must no longer be able to sign in.
  const after = jar();
  const retry = await form(after, '/auth/local/login', { email, password });
  const stillIn = retry.status === 302 && (retry.headers.get('location') ?? '').startsWith('/app');
  console.log(stillIn ? 'WARNING: the deleted account can still sign in' : 'cleanup verified');
} catch (error) {
  // Cleanup must never turn a green lab red on its own.
  console.log(`cleanup could not finish: ${error.message}`);
}
