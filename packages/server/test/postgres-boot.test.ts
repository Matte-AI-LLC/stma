import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue([]);
  const migration = Object.assign(query, { end: vi.fn().mockResolvedValue(undefined) });
  const pool = { end: vi.fn().mockResolvedValue(undefined) };
  const factory = vi.fn((_url: string, options: { max: number }) => options.max === 1 ? migration : pool);
  return { query, migration, pool, factory, migrate: vi.fn().mockResolvedValue(undefined), drizzle: vi.fn((client) => ({ client })) };
});
vi.mock('postgres', () => ({ default: mocks.factory }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: mocks.migrate }));
import { connectDb } from '../src/db';
import { loadEnv } from '../src/env';

const env = loadEnv({ nodeEnv: 'test', databaseUrl: 'postgres://fixture@localhost/stma_migration_test' });
beforeEach(() => { vi.clearAllMocks(); });

it('uses a dedicated non-recycling full client for the migration lock, migration and unlock', async () => {
  const connected = await connectDb(env);
  expect(mocks.factory).toHaveBeenCalledWith(env.databaseUrl, expect.objectContaining({
    max: 1, idle_timeout: 0, max_lifetime: 0,
  }));
  expect(mocks.query.mock.calls.map((call) => String(call[0][0]))).toEqual([
    'select pg_advisory_lock(727272)', 'select pg_advisory_unlock(727272)',
  ]);
  expect(mocks.migrate.mock.calls[0]?.[0]).toEqual({ client: mocks.migration });
  expect(mocks.migration.end).toHaveBeenCalledOnce();
  expect(mocks.pool.end).not.toHaveBeenCalled();
  await connected.close();
  expect(mocks.pool.end).toHaveBeenCalledOnce();
});

it('unlocks and closes both clients after a failed migration', async () => {
  mocks.migrate.mockRejectedValueOnce(new Error('migration failed'));
  await expect(connectDb(env)).rejects.toThrow('migration failed');
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.migration.end).toHaveBeenCalledOnce();
  expect(mocks.pool.end).toHaveBeenCalledOnce();
});

it('closes both clients when locking fails', async () => {
  mocks.query.mockRejectedValueOnce(new Error('lock failed'));
  await expect(connectDb(env)).rejects.toThrow('lock failed');
  expect(mocks.migrate).not.toHaveBeenCalled();
  expect(mocks.migration.end).toHaveBeenCalledOnce();
  expect(mocks.pool.end).toHaveBeenCalledOnce();
});
