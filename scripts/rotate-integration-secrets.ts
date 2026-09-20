import postgres from 'postgres';
import {
  protectIntegrationSecret,
  revealIntegrationSecret,
} from '../packages/server/src/lib/secretStore';

// Deliberately does not boot the app or run migrations. Dry-run is read-only.
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
try {
  if (!apply) {
    const counts =
      await client`select count(*)::int as total, count(*) filter (where token like 'enc:v1:%')::int as encrypted from team_integrations`;
    console.log(
      JSON.stringify({
        mode: 'dry-run',
        ...counts[0],
        action:
          'Back up the database and key versions separately; review the target before --apply.',
      }),
    );
  } else {
    let changed = 0;
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
    });
    console.log(
      JSON.stringify({
        mode: 'applied',
        changed,
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
