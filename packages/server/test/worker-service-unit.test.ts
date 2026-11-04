import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  linuxWorkerService,
  linuxWorkerUnit,
  macWorkerPlist,
  macWorkerService,
  windowsWorkerService,
  windowsWorkerTaskXml,
} from '../../cli/src/workerService';
import type { WorkerConfig } from '../../cli/src/workerState';

it('installs only on request and disables before deleting only a verified inactive task', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stma-service-'));
  try {
    const config = {
      fingerprint: 'a'.repeat(64),
      checkout: directory,
      hookRuntime: path.join(directory, 'runtime.mjs'),
    } as WorkerConfig;
    const node = path.join(directory, 'node.exe');
    let definition = '';
    let exists = false;
    let active = false;
    const calls: string[][] = [];
    const runner = (_exe: string, args: string[]) => {
      calls.push(args);
      if (args[0] === '/query') return { status: exists ? 0 : 1, stdout: definition };
      if (args[0] === '/create') {
        definition = readFileSync(args[args.indexOf('/xml') + 1]!, 'utf16le').replace(/^\ufeff/, '');
        exists = true;
      }
      if (
        args[0] === '/change' &&
        args.includes('/disable') &&
        definition.includes('<WakeToRun>false</WakeToRun><Enabled>true</Enabled></Settings>')
      )
        definition = definition
          .replace('<Settings>', '<Settings><Enabled>false</Enabled>')
          .replace(
            '<WakeToRun>false</WakeToRun><Enabled>true</Enabled></Settings>',
            '<WakeToRun>false</WakeToRun></Settings>',
          );
      if (args[0] === '/delete') exists = false;
      if (args[0] === '-NoProfile')
        return {
          status: 0,
          stdout: args.at(-1)?.includes('Definition.Actions') ? 'owned' : active ? '4,1' : '1,0',
        };
      return { status: 0, stdout: '' };
    };
    const options = { runner, scheduler: 'scheduler', node, user: 'TEST\\user' };
    const source = windowsWorkerTaskXml(config, node, 'TEST\\user');
    expect(source).toContain('<WakeToRun>false</WakeToRun>');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(windowsWorkerService('install', config, directory, options)).toMatchObject({ installed: true });
    expect(windowsWorkerService('status', config, directory, options)).toMatchObject({ verified: true });
    const original = definition;
    definition = definition.replace(
      '<LogonTrigger><Enabled>true</Enabled>',
      '<LogonTrigger><Enabled>false</Enabled>',
    );
    expect(windowsWorkerService('status', config, directory, options)).toMatchObject({ verified: false });
    definition = original;
    writeFileSync(path.join(directory, 'owner.lock'), '{}', { mode: 0o600 });
    expect(() => windowsWorkerService('uninstall', config, directory, options)).toThrow(/Stop the worker/);
    rmSync(path.join(directory, 'owner.lock'));
    active = true;
    expect(() => windowsWorkerService('uninstall', config, directory, options)).toThrow(/inactivity/);
    active = false;
    expect(windowsWorkerService('uninstall', config, directory, options)).toMatchObject({
      uninstalled: true,
    });
    expect(calls.some((args) => args.includes('/end'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(process.platform !== 'win32')(
  'manages Linux and macOS definitions without manager stop or kill',
  () => {
    for (const platform of ['linux', 'mac'] as const) {
      const home = mkdtempSync(path.join(os.tmpdir(), 'stma-service-home-'));
      try {
        const config = {
          fingerprint: 'c'.repeat(64),
          checkout: home,
          hookRuntime: path.join(home, 'runtime.mjs'),
        } as WorkerConfig;
        const unit = `stma-${config.fingerprint}.service`;
        const label = `ai.stma.worker.${config.fingerprint}`;
        const file =
          platform === 'linux'
            ? path.join(home, '.config', 'systemd', 'user', unit)
            : path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
        let installed = false;
        let active = false;
        const calls: string[][] = [];
        const runner = (_exe: string, args: string[]) => {
          calls.push(args);
          if (args.includes('--property=LoadState'))
            return { status: 0, stdout: installed ? 'loaded' : 'not-found' };
          if (args.includes('--property=FragmentPath')) return { status: 0, stdout: file };
          if (args.includes('--property=ActiveState'))
            return { status: 0, stdout: active ? 'active' : 'inactive' };
          if (args[0] === 'print')
            return installed
              ? { status: 0, stdout: `path = ${file}\nstate = ${active ? 'running\npid = 99' : 'waiting'}` }
              : { status: 1, stdout: '' };
          if (args.includes('enable') || args[0] === 'bootstrap') installed = true;
          return { status: 0, stdout: '' };
        };
        const options = { runner, home, node: process.execPath, uid: 501 };
        const manage = platform === 'linux' ? linuxWorkerService : macWorkerService;
        expect(manage('install', config, home, options)).toMatchObject({ installed: true });
        active = true;
        expect(() => manage('uninstall', config, home, options)).toThrow(/inactivity/);
        active = false;
        expect(manage('uninstall', config, home, options)).toMatchObject({ uninstalled: true });
        expect(calls.some((args) => args.includes('stop') || args.includes('kill'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);

it('renders per-user definitions without provider credentials or implicit restart', () => {
  const config = {
    fingerprint: 'b'.repeat(64),
    checkout: path.resolve('dedicated checkout'),
    hookRuntime: path.resolve('worker runtime.mjs'),
  } as WorkerConfig;
  const node = path.resolve('node binary');
  const unit = linuxWorkerUnit(config, node);
  expect(unit).toContain('Restart=no');
  expect(unit).toContain('WantedBy=default.target');
  expect(unit).not.toContain('ANTHROPIC_API_KEY');
  const plist = macWorkerPlist(config, node, `ai.stma.worker.${config.fingerprint}`);
  expect(plist).toContain('<key>RunAtLoad</key><true/>');
  expect(plist).toContain('<key>KeepAlive</key><false/>');
  expect(plist).not.toContain('ANTHROPIC_API_KEY');
});

it('refuses to adopt a task when its registered action cannot be verified', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stma-service-'));
  try {
    const config = {
      fingerprint: 'd'.repeat(64),
      checkout: directory,
      hookRuntime: path.join(directory, 'runtime.mjs'),
    } as WorkerConfig;
    const node = path.join(directory, 'node.exe');
    let definition = '';
    let exists = false;
    const runner = (_exe: string, args: string[]) => {
      if (args[0] === '/query') return { status: exists ? 0 : 1, stdout: definition };
      if (args[0] === '/create') {
        definition = readFileSync(args[args.indexOf('/xml') + 1]!, 'utf16le');
        exists = true;
        return { status: 0, stdout: '' };
      }
      if (args[0] === '-NoProfile') return { status: 0, stdout: 'invalid' };
      throw new Error('Unexpected scheduler change');
    };
    expect(() =>
      windowsWorkerService('install', config, directory, {
        runner,
        scheduler: 'scheduler',
        node,
        user: 'TEST\\user',
      }),
    ).toThrow(/action could not be verified/);
    expect(existsSync(path.join(directory, 'service.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
