import { serve } from '@hono/node-server';
import { createApp } from './app';
import { connectDb, type Db } from './db';
import type { Env } from './env';
import { startCleanup } from './lib/cleanup';
import { installProcessErrorCapture } from './lib/errors';
import { metrics } from './lib/metrics';

export interface StartedServer {
  port: number;
  url: string;
  /** This instance's database handle — for tests and scripts that drive sweeps directly. */
  db: Db;
  close: () => Promise<void>;
}

export async function startServer(env: Env): Promise<StartedServer> {
  const { db, close: closeDb } = await connectDb(env);
  const stopCleanup = startCleanup(db, env);
  const stopSampler = metrics.startSampler();
  const stopErrorCapture = installProcessErrorCapture(db);
  const app = createApp({ db, env });

  return new Promise<StartedServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
      const displayHost = env.host === '0.0.0.0' ? 'localhost' : env.host;
      resolve({
        port: info.port,
        url: `http://${displayHost}:${info.port}`,
        db,
        close: async () => {
          stopCleanup();
          stopSampler();
          stopErrorCapture();
          await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
          await closeDb();
        },
      });
    });
  });
}
