/**
 * One replica, in its own operating-system process.
 *
 * `shared-event-transport.test.ts` spawns two of these against one PostgreSQL
 * database. Two `startServer` calls inside one Node process would share
 * `lib/stream`'s module state — its subscribers and its instance id — so a
 * browser on "A" would hear "B" through a set they happen to have in common
 * and the test would prove nothing about the transport. A second process is
 * what a replica actually is.
 *
 * Not a `*.test.ts` file, so vitest's `include` never collects it. Prints
 * `READY <url>` on stdout when it is serving and nothing else; the parent kills
 * it when the test is done.
 */
import { loadEnv } from '../../src/env';
import { startServer } from '../../src/server';

const env = loadEnv({
  host: '127.0.0.1',
  port: Number(process.env.REPLICA_PORT ?? '0'),
  nodeEnv: 'test',
  devMode: true,
  databaseUrl: process.env.REPLICA_DATABASE_URL,
});

const server = await startServer(env);
process.stdout.write(`READY ${server.url}\n`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
