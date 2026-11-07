import postgres from 'postgres';
import {
  protectIntegrationSecret,
  resealAuthSecret,
  revealIntegrationSecret,
} from '../packages/server/src/lib/secretStore';

// Deliberately does not boot the app or run migrations. Dry-run is read-only.
// Two tables carry sealed values: team_integrations (provider credentials) and,
// since migration 0053, user_authenticators (authenticator-app secrets, always
// sealed, under their own associated data). Both are re-sealed in one
// transaction, or an old key version could never be retired.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('Inject DATABASE_URL securely; this migration tool requires PostgreSQL.');
const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes(`--confirm-database=${new URL(databaseUrl).pathname.slice(1)}`))
  throw new Error(
    'Apply requires --confirm-database=<exact database name> after a reviewed dry run and backup.',
  );
if (apply && !process.env.STMA_INTEGRATION_KEYS)
  throw new Error(
    'Configure old and new key versions before applying. No credentials were changed.',
  );
const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
/** A database older than migration 0053 has no authenticator table; that is not an error here. */
const hasAuthenticators = async (sql: typeof client) =>
  Boolean((await sql`select to_regclass('public.user_authenticators') as t`)[0]?.t);
try {
  if (!apply) {
    const counts =
      await client`select count(*)::int as total, count(*) filter (where token like 'enc:v1:%')::int as encrypted from team_integrations`;
    const integrations = Object.fromEntries(
      (await client`select split_part(token, ':', 3) as key_id, count(*)::int as n
        from team_integrations where token like 'enc:v1:%' group by 1 order by 1`)
        .map((row) => [row.key_id, row.n]),
    );
    // Counted by key version, never read: which versions are still in use is
    // what decides whether an old key may be dropped.
    const authenticators = (await hasAuthenticators(client))
      ? Object.fromEntries(
          (
            await client`select split_part(secret_ref, ':', 3) as key_id, count(*)::int as n from user_authenticators group by 1 order by 1`
          ).map((row) => [row.key_id, row.n]),
        )
      : {};
    console.log(
      JSON.stringify({
        mode: 'dry-run',
        ...counts[0],
        integrationsByKey: integrations,
        authenticatorsByKey: authenticators,
        action:
          'Back up the database and key versions separately; review the target before --apply.',
      }),
    );
  } else {
    let changed = 0;
    let changedAuthenticators = 0;
    await client.begin(async (tx) => {
      const rows =
        await tx`select id, team_id, provider, repo, token from team_integrations for update`;
      for (const row of rows) {
        const context = `${row.team_id}:${row.provider}:${row.repo}`;
        const plain = await revealIntegrationSecret(row.token, context);
        const sealed = await protectIntegrationSecret(plain, context);
        if (
          !sealed.startsWith('enc:v1:') ||
          (await revealIntegrationSecret(sealed, context)) !== plain
        )
          throw new Error('Encryption roundtrip failed; transaction rolled back.');
        await tx`update team_integrations set token = ${sealed}, updated_at = now() where id = ${row.id}`;
        changed++;
      }
      if (!(await hasAuthenticators(tx as unknown as typeof client))) return;
      const factors = await tx`select user_id, secret_ref from user_authenticators for update`;
      for (const row of factors) {
        // Opens, re-seals on the active key and checks the result opens again;
        // any failure throws and rolls the whole transaction back.
        const sealed = await resealAuthSecret(row.secret_ref, row.user_id);
        await tx`update user_authenticators set secret_ref = ${sealed} where user_id = ${row.user_id}`;
        changedAuthenticators++;
      }
    });
    console.log(
      JSON.stringify({
        mode: 'applied',
        changed,
        changedAuthenticators,
        warning:
          'Keep old keys and encrypted backups until restore and rotation acceptance are complete.',
      }),
    );
  }
} catch {
  throw new Error(
    'Credential migration failed; no credential values are included in this error. Review database access and key versions.',
  );
} finally {
  await client.end();
}
