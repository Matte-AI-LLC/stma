import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsDirectoryRefusal, windowsPrivateDirectory } from './windowsAcl.js';

export interface WorkerConfig {
  schema: 1; checkout: string; fingerprint: string; targetId: string; installationId: string; server: string;
  executable: string; runtimeVersion: string; apiKeyEnv: string; hookRuntime: string; profile?: string;
  runtime?: 'claude-print-v1' | 'codex-read-only-v1';
  codexModel?: string;
  maxRuntimeSeconds: number; maxTurns: number;
}
export interface WorkerJournal {
  schema: 1; workerId: string; phase: 'idle' | 'claiming' | 'claimed' | 'spawn_intent' | 'running' | 'terminal' | 'quarantined';
  updatedAt: string; jobId?: string; attemptId?: string; fence?: number; sessionId?: string;
  reason?: string; pid?: number; startedAt?: string;
  providerThreadId?: string;
}
export interface WorkerControl { owner: string; command: 'run' | 'pause' | 'stop' | 'disable'; }
export function canonicalCheckout(directory: string): string {
  const resolved = realpathSync.native(directory);
  if (!lstatSync(resolved).isDirectory()) throw new Error('Worker checkout must be a directory.');
  return resolved;
}
export function checkoutFingerprint(directory: string, platform = process.platform): string {
  return createHash('sha256').update(platform === 'win32' ? directory.toLowerCase() : directory).digest('hex');
}
export function ensureWorkerPrivateDirectory(directory: string): void {
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error('Worker storage must be a plain private directory.');
  if (process.platform === 'win32') {
    const refusal = windowsDirectoryRefusal(directory, windowsPrivateDirectory(directory, 'ensure'));
    if (refusal) throw new Error(refusal);
  } else {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Worker storage must be private to its owner.');
  }
}
export function workerDirectory(checkout: string, home = os.homedir()): string {
  return path.join(home, '.stma', 'workers', checkoutFingerprint(checkout));
}
export function prepareWorkerDirectory(checkout: string, home = os.homedir()): string {
  for (const directory of [path.join(home, '.stma'), path.join(home, '.stma', 'workers'), workerDirectory(checkout, home)]) {
    if (!existsSync(directory)) {
      if (process.platform === 'win32') ensureWorkerPrivateDirectory(directory);
      else mkdirSync(directory, { mode: 0o700 });
    }
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Worker storage cannot follow links.');
    if (directory.endsWith('workers') || directory === workerDirectory(checkout, home)) ensureWorkerPrivateDirectory(directory);
  }
  return workerDirectory(checkout, home);
}
export function readWorkerJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256_000 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw new Error('Unsafe worker state file.');
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
/** Worker files never inherit an old file's potentially broad mode. */
export function writeWorkerJson(file: string, value: unknown): void {
  if (existsSync(file)) readWorkerJson(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  try { const dir = openSync(path.dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Windows cannot fsync a directory. */ }
}
/** No stale-PID or timeout eviction: an unobserved child may still own the checkout. */
export function acquireWorkerLock(directory: string, owner: string): () => void {
  const file = path.join(directory, 'owner.lock');
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); }
  catch { throw new Error('This checkout has a worker owner or unresolved prior execution. Inspect worker status; use a new checkout if ownership cannot be verified.'); }
  try { writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  return () => { if (readWorkerJson<{ owner: string }>(file)?.owner === owner) unlinkSync(file); };
}
export function workerControl(directory: string, owner: string): WorkerControl['command'] {
  const control = readWorkerJson<WorkerControl>(path.join(directory, 'control.json'));
  return control?.owner === owner ? control.command : 'stop';
}
export function signalWorker(directory: string, command: WorkerControl['command']): void {
  const lock = readWorkerJson<{ owner: string }>(path.join(directory, 'owner.lock'));
  if (!lock?.owner) throw new Error('No worker owner is recorded.');
  writeWorkerJson(path.join(directory, 'control.json'), { owner: lock.owner, command });
}
