import { serve } from '@hono/node-server';
import { createApp } from './app';
import { connectDb, type Db } from './db';
import type { Env } from './env';
import { startCleanup } from './lib/cleanup';
import { installProcessErrorCapture } from './lib/errors';
import { metrics } from './lib/metrics';
import type { AppExtension, AppLifecycleHooks } from './extensions';
import { appExtensionRequirements } from './db/schema';
import { withSecurityHooks } from './lib/securityHooks';
import { attachChangeTransport } from './lib/stream';

export interface StartedServer {
  port: number;
  url: string;
  /** This instance's database handle — for tests and scripts that drive sweeps directly. */
  db: Db;
  close: () => Promise<void>;
}

export interface ServerComposition {
  /** Run operator-owned migrations after the core database is ready. */
  prepareDb?: (db: Db, env: Env) => Promise<void>;
  extensions?: readonly AppExtension[];
  lifecycle?: AppLifecycleHooks;
  /** Start background services; return a disposer for graceful shutdown. */
  startServices?: (db: Db, env: Env) => void | (() => void | Promise<void>);
}

export async function startServer(env: Env, composition: ServerComposition = {}): Promise<StartedServer> {
  const { db, close: closeDb, notifyBus } = await connectDb(env);
  try {
    await composition.prepareDb?.(db, env);
    const required = await db.select().from(appExtensionRequirements);
    if (required.some((row) => !composition.extensions?.some((extension) => extension.name === row.name))) {
      throw new Error('This database requires a security extension missing from the running composition. Start the matching distribution; never remove the requirement to bypass this gate.');
    }
  } catch (error) {
    await closeDb();
    throw error;
  }
  const stopCleanup = withSecurityHooks(composition.lifecycle ?? {}, () => startCleanup(db, env));
  // The live channel's other half. Best effort by construction: without it this
  // replica simply keeps its events to itself, which is what every embedded
  // instance does, and the page's 30s poll is the floor either way.
  const stopTransport = await attachChangeTransport(notifyBus);
  const stopSampler = metrics.startSampler();
  const stopErrorCapture = installProcessErrorCapture(db);
  let stopServices: void | (() => void | Promise<void>) = undefined;
  let app: ReturnType<typeof createApp>;
  try {
    stopServices = composition.startServices?.(db, env);
    app = createApp(
      { db, env },
      { extensions: composition.extensions, lifecycle: composition.lifecycle },
    );
  } catch (error) {
    stopCleanup();
    stopSampler();
    stopErrorCapture();
    await stopTransport();
    await stopServices?.();
    await closeDb();
    throw error;
  }

  return new Promise<StartedServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
      const displayHost = env.host === '0.0.0.0' ? 'localhost' : env.host;
      // Port 0 is useful for collision-free local/test servers, but a prompt
      // containing localhost:0 is a dead end. The app keeps the same Env object,
      // so resolve its public URL as soon as the kernel chooses the real port.
      if (!env.baseUrl || /:0$/.test(env.baseUrl)) {
        env.baseUrl = `http://${displayHost}:${info.port}`;
      }
      resolve({
        port: info.port,
        url: `http://${displayHost}:${info.port}`,
        db,
        close: async () => {
          stopCleanup();
          stopSampler();
          stopErrorCapture();
          await stopTransport();
          await stopServices?.();
          await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
          await closeDb();
        },
      });
    });
  });
}
