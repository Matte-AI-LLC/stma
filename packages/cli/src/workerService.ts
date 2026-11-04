import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkerJson, signalWorker, writeWorkerJson, type WorkerConfig } from './workerState.js';

type Runner = (executable: string, args: string[]) => { status: number | null; stdout: string };
const run: Runner = (executable, args) => {
  const result = spawnSync(executable, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 500_000,
  });
  if (result.error) throw new Error('Task Scheduler was unavailable.');
  return { status: result.status, stdout: result.stdout ?? '' };
};
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
// Task Scheduler can move Settings/Enabled when /change toggles the task.
// Remove that one field within Settings only; trigger enablement still matters.
const normalized = (value: string) =>
  value
    .replace(/<Settings(?:\s[^>]*)?>[\s\S]*?<\/Settings>/i, (settings) =>
      settings.replace(/\s*<Enabled>\s*(?:true|false)\s*<\/Enabled>/i, ''),
    )
    .trim();
interface Manifest {
  schema: 1;
  task: string;
  exported: string;
}

/** An interactive user logon task: no credentials, password or shell command is stored. */
export function windowsWorkerTaskXml(config: WorkerConfig, node: string, user: string): string {
  if (
    !path.isAbsolute(node) ||
    !path.isAbsolute(config.hookRuntime) ||
    !path.isAbsolute(config.checkout) ||
    [node, config.hookRuntime, config.checkout].some((value) => /[%\r\n"]/.test(value)) ||
    !user ||
    /[\r\n]/.test(user)
  )
    throw new Error('Invalid service identity or executable.');
  const args = `"${config.hookRuntime}" worker start`;
  return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>STMA dedicated worker. Runs only in this user login session.</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>false</StartWhenAvailable><WakeToRun>false</WakeToRun><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(config.checkout)}</WorkingDirectory></Exec></Actions></Task>`;
}

/** Never use /end: a scheduler PID is not proof of ownership of its process tree. */
export function windowsWorkerService(
  action: string,
  config: WorkerConfig,
  directory: string,
  options: { runner?: Runner; scheduler?: string; node?: string; user?: string } = {},
): unknown {
  if (!/^[a-f0-9]{64}$/.test(config.fingerprint)) throw new Error('Invalid checkout fingerprint.');
  const runner = options.runner ?? run;
  const scheduler =
    options.scheduler ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  const task = `STMA-${config.fingerprint}`;
  const manifestPath = path.join(directory, 'service.json');
  const query = () => runner(scheduler, ['/query', '/tn', task, '/xml']);
  const manifest = readWorkerJson<Manifest>(manifestPath);
  const current = query();
  const schedulerState = () => {
    const powershell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const script = `$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder('\\').GetTask('${task}');Write-Output ($t.State.ToString()+','+$t.GetInstances(0).Count.ToString())`;
    const state = runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    const match = state.status === 0 ? /^([0-4]),(\d{1,4})$/.exec(state.stdout.trim()) : null;
    return match
      ? {
          scheduler_state: ['unknown', 'disabled', 'queued', 'ready', 'running'][Number(match[1])],
          instances: Number(match[2]),
        }
      : null;
  };
  const owned = () => {
    if (
      !manifest ||
      manifest.schema !== 1 ||
      manifest.task !== task ||
      current.status !== 0 ||
      normalized(current.stdout) !== normalized(manifest.exported)
    )
      throw new Error('Service ownership or definition cannot be verified; no scheduler change was made.');
  };
  const command = (args: string[]) => {
    if (runner(scheduler, args).status !== 0) throw new Error('Task Scheduler refused the operation.');
  };
  if (action === 'status') {
    const verified =
      !!manifest &&
      manifest.schema === 1 &&
      manifest.task === task &&
      current.status === 0 &&
      normalized(current.stdout) === normalized(manifest.exported);
    return {
      installed: Boolean(manifest),
      verified,
      task,
      manager: verified ? schedulerState() : null,
      autostart: 'user logon session',
      wakes_machine: false,
    };
  }
  if (action === 'install') {
    if (manifest || current.status === 0)
      throw new Error('A service record or task with this name already exists.');
    const user = options.user ?? [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
    const definition = windowsWorkerTaskXml(config, options.node ?? process.execPath, user);
    const temp = path.join(directory, `service-${randomUUID()}.xml`);
    try {
      writeFileSync(temp, '\ufeff' + definition, { encoding: 'utf16le', flag: 'wx', mode: 0o600 });
      command(['/create', '/tn', task, '/xml', temp]);
      const exported = query();
      if (
        exported.status !== 0 ||
        ![options.node ?? process.execPath, config.hookRuntime, config.checkout].every((value) =>
          exported.stdout.includes(xml(value)),
        )
      )
        throw new Error('Created task could not be verified; inspect Task Scheduler before retrying.');
      // Read the registered action, not just substrings in XML that could appear in a comment or extra action.
      const expected = Buffer.from(
        JSON.stringify({
          node: options.node ?? process.execPath,
          args: `"${config.hookRuntime}" worker start`,
          cwd: config.checkout,
        }),
        'utf8',
      ).toString('base64');
      const verifyScript = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder('\\').GetTask('${task}');$a=$t.Definition.Actions;if($a.Count -eq 1 -and $a.Item(1).Type -eq 0 -and $a.Item(1).Path -ceq $p.node -and $a.Item(1).Arguments -ceq $p.args -and $a.Item(1).WorkingDirectory -ceq $p.cwd){'owned'}else{'invalid'}`;
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const actionCheck = runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', verifyScript]);
      if (actionCheck.status !== 0 || actionCheck.stdout.trim() !== 'owned')
        throw new Error('Created task action could not be verified; inspect Task Scheduler before retrying.');
      writeWorkerJson(manifestPath, { schema: 1, task, exported: exported.stdout });
      return { installed: true, autostart: 'user logon session', wakes_machine: false };
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  owned();
  if (action === 'start') {
    command(['/change', '/tn', task, '/enable']);
    command(['/run', '/tn', task]);
    return { requested: 'start', observation: 'Check worker status and journal.' };
  }
  if (action === 'stop') {
    command(['/change', '/tn', task, '/disable']);
    if (existsSync(path.join(directory, 'owner.lock'))) signalWorker(directory, 'stop');
    return {
      requested: 'stop',
      observation: 'Autostart disabled; check worker status and journal for completion.',
    };
  }
  // Deletion is intentionally refused while an owner is recorded: the journal cannot prove a child stopped.
  if (action === 'uninstall') {
    command(['/change', '/tn', task, '/disable']);
    if (existsSync(path.join(directory, 'owner.lock')))
      throw new Error('Autostart disabled. Stop the worker and verify its journal before uninstalling.');
    const state = schedulerState();
    if (!state || state.instances !== 0 || !['ready', 'disabled'].includes(state.scheduler_state ?? ''))
      throw new Error('Autostart disabled; scheduler inactivity could not be verified.');
    const checked = query();
    if (checked.status !== 0 || normalized(checked.stdout) !== normalized(manifest!.exported))
      throw new Error('Task definition changed before uninstall.');
    command(['/delete', '/tn', task, '/f']);
    unlinkSync(manifestPath);
    return { uninstalled: true };
  }
  throw new Error('Use service-install, service-status, service-start, service-stop or service-uninstall.');
}

const unitArgument = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid service path.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$').replaceAll('%', '%%')}"`;
};
export function linuxWorkerUnit(config: WorkerConfig, node: string): string {
  if (!path.isAbsolute(node) || !path.isAbsolute(config.hookRuntime) || !path.isAbsolute(config.checkout))
    throw new Error('Service paths must be absolute.');
  return `[Unit]\nDescription=STMA dedicated worker (user login session)\n[Service]\nType=simple\nWorkingDirectory=${unitArgument(config.checkout)}\nExecStart=${unitArgument(node)} ${unitArgument(config.hookRuntime)} worker start\nRestart=no\nStandardOutput=null\nStandardError=null\n[Install]\nWantedBy=default.target\n`;
}
interface UnitManifest {
  schema: 1;
  unit: string;
  file: string;
  definition: string;
}
/** The user manager is disabled before observing process state; no systemctl stop/kill. */
export function linuxWorkerService(
  action: string,
  config: WorkerConfig,
  directory: string,
  options: { runner?: Runner; home?: string; node?: string; ownerId?: number } = {},
): unknown {
  if (!/^[a-f0-9]{64}$/.test(config.fingerprint)) throw new Error('Invalid checkout fingerprint.');
  const runner = options.runner ?? run;
  const ownerId = options.ownerId ?? process.getuid?.();
  const unit = `stma-${config.fingerprint}.service`;
  const home = options.home ?? os.homedir();
  const directories = [
    path.join(home, '.config'),
    path.join(home, '.config', 'systemd'),
    path.join(home, '.config', 'systemd', 'user'),
  ];
  const file = path.join(directories[2]!, unit);
  const manifestPath = path.join(directory, 'service.json');
  const manifest = readWorkerJson<UnitManifest>(manifestPath);
  const systemctl = existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl';
  const call = (args: string[]) => runner(systemctl, ['--user', ...args]);
  const command = (args: string[]) => {
    if (call(args).status !== 0) throw new Error('The user service manager refused the operation.');
  };
  const safeFile = () => {
    if (!existsSync(file)) return false;
    const stat = lstatSync(file);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === ownerId &&
      !(stat.mode & 0o022) &&
      stat.size < 100_000
    );
  };
  const verified = () =>
    !!manifest &&
    manifest.schema === 1 &&
    manifest.unit === unit &&
    manifest.file === file &&
    safeFile() &&
    readFileSync(file, 'utf8') === manifest.definition;
  if (action === 'status') {
    const isVerified = verified();
    const observed = isVerified ? call(['show', unit, '--property=ActiveState', '--value']) : undefined;
    const fragment = isVerified ? call(['show', unit, '--property=FragmentPath', '--value']) : undefined;
    const state =
      observed &&
      ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(observed.stdout.trim())
        ? observed.stdout.trim()
        : 'unknown';
    return {
      installed: Boolean(manifest),
      verified: isVerified,
      manager_verified: fragment?.status === 0 && fragment.stdout.trim() === file,
      unit,
      manager_state: state,
      autostart: 'user manager session',
      wakes_machine: false,
    };
  }
  if (action === 'install') {
    if (manifest || existsSync(file)) throw new Error('A service record or unit already exists.');
    for (const dir of directories) {
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerId || stat.mode & 0o022)
        throw new Error('User service directory is not safely owned.');
    }
    const old = call(['show', unit, '--property=LoadState', '--value']);
    if (old.status === 0 && old.stdout.trim() !== 'not-found')
      throw new Error('The user manager already knows this service name.');
    const definition = linuxWorkerUnit(config, options.node ?? process.execPath);
    writeFileSync(file, definition, { flag: 'wx', mode: 0o600 });
    // Record before touching the manager so a failed command remains inspectable.
    writeWorkerJson(manifestPath, { schema: 1, unit, file, definition });
    command(['daemon-reload']);
    command(['enable', unit]);
    return { installed: true, autostart: 'user manager session', wakes_machine: false };
  }
  if (!verified())
    throw new Error('Service ownership or definition cannot be verified; no manager change was made.');
  const loaded = call(['show', unit, '--property=FragmentPath', '--value']);
  if (loaded.status !== 0 || loaded.stdout.trim() !== file)
    throw new Error('The user manager loaded a different service definition.');
  if (action === 'start') {
    command(['enable', unit]);
    command(['start', unit]);
    return { requested: 'start', observation: 'Check worker status and journal.' };
  }
  if (action === 'stop') {
    command(['disable', unit]);
    if (existsSync(path.join(directory, 'owner.lock'))) signalWorker(directory, 'stop');
    return {
      requested: 'stop',
      observation: 'Autostart disabled; check worker status and journal for completion.',
    };
  }
  if (action === 'uninstall') {
    command(['disable', unit]);
    if (existsSync(path.join(directory, 'owner.lock')))
      throw new Error('Autostart disabled. Stop the worker and verify its journal before uninstalling.');
    const state = call(['show', unit, '--property=ActiveState', '--value']);
    if (state.status !== 0 || !['inactive', 'failed'].includes(state.stdout.trim()) || !verified())
      throw new Error('Autostart disabled; service inactivity or ownership could not be verified.');
    unlinkSync(file);
    command(['daemon-reload']);
    unlinkSync(manifestPath);
    return { uninstalled: true };
  }
  throw new Error('Use service-install, service-status, service-start, service-stop or service-uninstall.');
}

export function macWorkerPlist(config: WorkerConfig, node: string, label: string): string {
  if (
    !path.isAbsolute(node) ||
    !path.isAbsolute(config.hookRuntime) ||
    !path.isAbsolute(config.checkout) ||
    !/^ai\.stma\.worker\.[a-f0-9]{64}$/.test(label)
  )
    throw new Error('Invalid launch agent identity or executable.');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(config.hookRuntime)}</string><string>worker</string><string>start</string></array><key>WorkingDirectory</key><string>${xml(config.checkout)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`;
}
interface AgentManifest {
  schema: 1;
  label: string;
  file: string;
  definition: string;
}
export function macWorkerService(
  action: string,
  config: WorkerConfig,
  directory: string,
  options: { runner?: Runner; home?: string; node?: string; uid?: number; ownerId?: number } = {},
): unknown {
  if (!/^[a-f0-9]{64}$/.test(config.fingerprint)) throw new Error('Invalid checkout fingerprint.');
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid! < 1) throw new Error('A user login session is required.');
  const runner = options.runner ?? run;
  const label = `ai.stma.worker.${config.fingerprint}`;
  const ownerId = options.ownerId ?? process.getuid?.();
  const home = options.home ?? os.homedir();
  const parent = path.join(home, 'Library');
  const agents = path.join(parent, 'LaunchAgents');
  const file = path.join(agents, `${label}.plist`);
  const manifestPath = path.join(directory, 'service.json');
  const manifest = readWorkerJson<AgentManifest>(manifestPath);
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const call = (args: string[]) => runner('/bin/launchctl', args);
  const command = (args: string[]) => {
    if (call(args).status !== 0) throw new Error('The user launch agent manager refused the operation.');
  };
  const loadedPath = (output: string) => /^[ \t]*path[ \t]*=[ \t]*(.*?)[ \t]*\r?$/m.exec(output)?.[1];
  const verified = () => {
    if (
      !manifest ||
      manifest.schema !== 1 ||
      manifest.label !== label ||
      manifest.file !== file ||
      !existsSync(file)
    )
      return false;
    const stat = lstatSync(file);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === ownerId &&
      !(stat.mode & 0o022) &&
      stat.size < 100_000 &&
      readFileSync(file, 'utf8') === manifest.definition
    );
  };
  if (action === 'status') {
    const isVerified = verified();
    const observed = isVerified ? call(['print', target]) : undefined;
    const match =
      observed?.status === 0 ? /\bstate\s*=\s*(waiting|not running|running)\b/i.exec(observed.stdout) : null;
    return {
      installed: Boolean(manifest),
      verified: isVerified,
      manager_verified: observed?.status === 0 && loadedPath(observed.stdout) === file,
      label,
      manager_state: match?.[1]?.toLowerCase() ?? 'unknown',
      autostart: 'GUI login session',
      wakes_machine: false,
    };
  }
  if (action === 'install') {
    if (manifest || existsSync(file) || call(['print', target]).status === 0)
      throw new Error('A service record or launch agent with this name already exists.');
    for (const dir of [parent, agents]) {
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerId || stat.mode & 0o022)
        throw new Error('Launch agent directory is not safely owned.');
    }
    const definition = macWorkerPlist(config, options.node ?? process.execPath, label);
    writeFileSync(file, definition, { flag: 'wx', mode: 0o600 });
    writeWorkerJson(manifestPath, { schema: 1, label, file, definition });
    command(['bootstrap', domain, file]);
    return {
      installed: true,
      autostart: 'GUI login session',
      wakes_machine: false,
      observation: 'The agent may start immediately; check worker status and journal.',
    };
  }
  if (!verified())
    throw new Error('Service ownership or definition cannot be verified; no manager change was made.');
  const check = () => {
    const state = call(['print', target]);
    if (state.status !== 0 || loadedPath(state.stdout) !== file)
      throw new Error('The login manager did not verify this launch agent.');
    return state.stdout;
  };
  const initial = call(['print', target]);
  if (initial.status !== 0 && call(['print', domain]).status !== 0)
    throw new Error('The GUI user manager is unavailable.');
  if (initial.status === 0 && loadedPath(initial.stdout) !== file)
    throw new Error('The login manager loaded a different launch agent.');
  if (action === 'start') {
    command(['enable', target]);
    if (initial.status === 0) command(['kickstart', target]);
    else command(['bootstrap', domain, file]);
    return { requested: 'start', observation: 'Check worker status and journal.' };
  }
  if (action === 'stop') {
    command(['disable', target]);
    if (existsSync(path.join(directory, 'owner.lock'))) signalWorker(directory, 'stop');
    return {
      requested: 'stop',
      observation: 'Autostart disabled; check worker status and journal for completion.',
    };
  }
  if (action === 'uninstall') {
    command(['disable', target]);
    if (existsSync(path.join(directory, 'owner.lock')))
      throw new Error('Autostart disabled. Stop the worker and verify its journal before uninstalling.');
    if (initial.status === 0) {
      const state = check();
      if (/\bpid\s*=/.test(state) || !/\bstate\s*=\s*(?:waiting|not running)\b/i.test(state) || !verified())
        throw new Error('Autostart disabled; launch agent inactivity could not be verified.');
      command(['bootout', target]);
    } else if (call(['print', target]).status === 0 || !verified())
      throw new Error('Launch agent state changed before removal.');
    unlinkSync(file);
    unlinkSync(manifestPath);
    return { uninstalled: true };
  }
  throw new Error('Use service-install, service-status, service-start, service-stop or service-uninstall.');
}
