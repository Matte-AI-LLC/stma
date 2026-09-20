import { spawnSync } from 'node:child_process';

/**
 * Windows permissions for the directory that holds the pinned runtime.
 *
 * The hook command runs that file as this user on every prompt, so anyone who
 * can write it can run code as this user. POSIX answers that with an owner and
 * mode check; Node exposes neither on Windows, and a checkout's location says
 * nothing about its ACL — a data drive commonly inherits a broad Authenticated
 * Users entry, while a profile folder is private. So read the ACL instead. The
 * directory is STMA's own, so a too-broad ACL is tightened rather than refused;
 * only one we cannot make private, or that an account outside the allowed set
 * owns (an owner can always restore its own access), stops setup. An elevated
 * Windows session owns what it creates as Administrators, which is allowed.
 * `probe` is the read-only half, for refusing before browser consent.
 *
 * SIDs, never names: a check that compares "Administrators" breaks on a
 * localized Windows.
 */
const ALLOWED_WRITERS = [
  'S-1-5-18', // SYSTEM
  'S-1-5-32-544', // Administrators
  'S-1-3-0', // CREATOR OWNER (inheritance placeholder)
  'S-1-3-4', // OWNER RIGHTS
];

/** WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, ChangePermissions, TakeOwnership. */
const WRITE_MASK = 0xd0116;

const SCRIPT = `$ErrorActionPreference = 'Stop'
# Only .NET and language constructs: no Get-Acl, ConvertTo-Json, Test-Path or New-Object.
# A PSModulePath that points at PowerShell 7 (GitHub Actions sets one) makes
# Windows PowerShell find Microsoft.PowerShell.Security and fail to load it, and
# a machine's execution policy can block module autoloading outright.
$directory = $env:STMA_ACL_DIRECTORY
$mode = $env:STMA_ACL_MODE
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @(${ALLOWED_WRITERS.map((sid) => `'${sid}'`).join(', ')}, $me.Value)
$ok = $false; $reason = ''; $writers = @(); $owner = ''
$tightened = $false; $tightens = $false; $created = $false; $missing = $false; $detail = ''
function Get-Security($path) { return ([IO.DirectoryInfo]::new($path)).GetAccessControl() }
function Get-Writers($path) {
  $found = @()
  foreach ($rule in (Get-Security $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    if (([int]$rule.FileSystemRights -band ${WRITE_MASK}) -eq 0) { continue }
    $sid = $rule.IdentityReference.Value
    if (($allowed -notcontains $sid) -and ($found -notcontains $sid)) { $found += $sid }
  }
  return ,@($found)
}
function Set-Private($path) {
  $info = [IO.DirectoryInfo]::new($path)
  $security = $info.GetAccessControl()
  $security.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($security.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
    $null = $security.RemoveAccessRule($rule)
  }
  foreach ($sid in @($me, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  $info.SetAccessControl($security)
}
try {
  if (-not [IO.Directory]::Exists($directory)) {
    # Reading the parent's ACL is the early signal for a filesystem that has none.
    $null = Get-Security ([IO.Path]::GetDirectoryName($directory))
    if ($mode -eq 'probe') { $ok = $true; $missing = $true }
    else {
      $null = [IO.Directory]::CreateDirectory($directory)
      Set-Private $directory
      $created = $true; $writers = Get-Writers $directory
      $ok = ($writers.Count -eq 0); $reason = 'writable_by_other_accounts'
    }
  } else {
    $info = [IO.DirectoryInfo]::new($directory)
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $reason = 'not_a_plain_directory'
    } else {
      $owner = (Get-Security $directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
      $writers = Get-Writers $directory
      if ($allowed -notcontains $owner) { $reason = 'owned_by_another_account' }
      elseif ($mode -eq 'probe') { $ok = $true; $tightens = ($writers.Count -gt 0) }
      else {
        if ($writers.Count -gt 0) { Set-Private $directory; $tightened = $true; $writers = Get-Writers $directory }
        $ok = ($writers.Count -eq 0); $reason = 'writable_by_other_accounts'
      }
    }
  }
} catch {
  $ok = $false; $reason = 'permission_check_failed'; $detail = $_.Exception.Message
}
function Escape-Json($text) { return (([string]$text) -replace '\\\\', '\\\\' -replace '"', '\\"' -replace '[\\r\\n\\t]', ' ') }
$quoted = @()
foreach ($sid in $writers) { $quoted += ('"' + (Escape-Json $sid) + '"') }
$json = '{"ok":' + $(if ($ok) { 'true' } else { 'false' }) +
  ',"reason":"' + (Escape-Json $reason) + '"' +
  ',"writers":[' + ($quoted -join ',') + ']' +
  ',"owner":"' + (Escape-Json $owner) + '"' +
  ',"detail":"' + (Escape-Json $detail) + '"' +
  ',"tightened":' + $(if ($tightened) { 'true' } else { 'false' }) +
  ',"tightens":' + $(if ($tightens) { 'true' } else { 'false' }) +
  ',"created":' + $(if ($created) { 'true' } else { 'false' }) +
  ',"missing":' + $(if ($missing) { 'true' } else { 'false' }) + '}'
[Console]::Out.Write($json)`;

export interface WindowsPrivateDirectoryResult {
  ok: boolean;
  reason?: string;
  /** The Windows error behind a failed check, for a message somebody can act on. */
  detail?: string;
  writers?: string[];
  owner?: string;
  tightened?: boolean;
  tightens?: boolean;
  created?: boolean;
  missing?: boolean;
}

/** Turn the PowerShell verdict into the message a person can act on. */
export function windowsDirectoryRefusal(
  directory: string,
  result: WindowsPrivateDirectoryResult,
): string | undefined {
  if (result.ok) return undefined;
  if (result.reason === 'owned_by_another_account') {
    return `${directory} belongs to another Windows account (${result.owner ?? 'unknown'}) and is writable by it, so STMA cannot make it private. Remove it or take ownership, then run this again.`;
  }
  if (result.reason === 'not_a_plain_directory') {
    return `${directory} is a link or not a directory. Replace it with a plain folder before installing the pinned runtime.`;
  }
  if (result.reason === 'permission_check_failed') {
    const detail = result.detail ? ` Windows reported: ${result.detail.replaceAll(/\s+/g, ' ').slice(0, 200)}` : '';
    return `STMA could not read Windows permissions for ${directory} through PowerShell, so it cannot promise the pinned runtime is private to your account. Nothing was installed.${detail}`;
  }
  const writers = result.writers?.length ? ` Still writable by: ${result.writers.join(', ')}.` : '';
  return `STMA could not make ${directory} private to your Windows account, so another account could replace the pinned runtime.${writers} A drive without NTFS permissions (FAT32/exFAT) cannot hold it; use a checkout on an NTFS drive.`;
}

/**
 * `probe` only reads (and refuses before consent); `ensure` creates the
 * directory private, or tightens an ACL that lets other accounts write.
 */
export function windowsPrivateDirectory(
  directory: string,
  mode: 'probe' | 'ensure',
): WindowsPrivateDirectoryResult {
  // No `-ExecutionPolicy Bypass`. It was here for the days this script called
  // Get-Acl, whose module a Restricted policy would not autoload; the script is
  // cmdlet-free now, an inline -Command is not subject to execution policy, and
  // the flag is what a behavioural antivirus scores as malware (2026-09-20,
  // Kaspersky System Watcher, PDM:Trojan.Win32.Generic on `adapter disconnect`).
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    // The script takes no stdin and its own module path: a PowerShell 7
    // PSModulePath in the environment breaks Windows PowerShell's built-ins.
    env: {
      ...process.env,
      PSModulePath: `${system}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      STMA_ACL_DIRECTORY: directory,
      STMA_ACL_MODE: mode,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const detail = (result.stderr ?? '').trim() || result.error?.message;
    return { ok: false, reason: 'permission_check_failed', ...(detail ? { detail } : {}) };
  }
  try {
    const parsed = JSON.parse(result.stdout) as WindowsPrivateDirectoryResult;
    if (typeof parsed?.ok !== 'boolean') return { ok: false, reason: 'permission_check_failed' };
    // PowerShell may hand back a lone SID rather than a one-element array.
    const writers = Array.isArray(parsed.writers)
      ? parsed.writers.map(String)
      : parsed.writers
        ? [String(parsed.writers)]
        : [];
    return { ...parsed, writers };
  } catch {
    return { ok: false, reason: 'permission_check_failed' };
  }
}
