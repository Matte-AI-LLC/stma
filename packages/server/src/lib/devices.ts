import { createHash } from 'node:crypto';
import { and, eq, gt, max } from 'drizzle-orm';
import type { Db } from '../db';
import { snapshots, teams } from '../db/schema';
import { DAY_MS } from './counters';
import { cheapestWith, planName } from './entitlements';
import { timeAgo } from './format';

/** Device slot used when a caller gives no label and its token has no usable name. */
export const DEFAULT_DEVICE = 'default';
export const DEVICE_LABEL_MAX = 40;

/**
 * How far back a device counts against the plan's per-member ceiling
 * (`maxDevicesPerMember`).
 *
 * A device is a label, not a machine: the caller names it, so one laptop can
 * hold two labels and a replacement can reuse the old one. A count that never
 * forgot would keep a replaced laptop's slot — or one push under a name nobody
 * meant — until retention swept every snapshot it ever sent, 90 days by
 * default, and there is nothing a person could press to give it back. Thirty
 * days is the window the handoff allowance already uses.
 */
export const DEVICE_WINDOW_DAYS = 30;

/** Where the window starts. The gate and `/admin/beta` both count from here. */
export const deviceWindowStart = (now = new Date()): Date =>
  new Date(now.getTime() - DEVICE_WINDOW_DAYS * DAY_MS);

/**
 * A device label names ONE machine of one user ("macbook", "win-desktop"). It is
 * the addressable key for snapshots, so it is normalized hard: trimmed,
 * lowercased, reduced to [a-z0-9._-] and capped. Returns null when nothing
 * usable is left — callers decide whether that is an error or a fallback.
 */
export function normalizeDeviceLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (cleaned.length === 0) return null;
  if (cleaned.length <= DEVICE_LABEL_MAX) return cleaned;
  // Two long names that agree on their first DEVICE_LABEL_MAX characters used to
  // share one slot, so one machine read back the other's environment. Keep the
  // readable head and a short digest of the whole thing.
  const digest = createHash('sha256').update(cleaned).digest('hex').slice(0, 6);
  return `${cleaned.slice(0, DEVICE_LABEL_MAX - 7).replace(/[-._]+$/g, '')}-${digest}`;
}

/** First usable label among the candidates, falling back to DEFAULT_DEVICE. */
export function resolveDeviceLabel(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const label = normalizeDeviceLabel(candidate);
    if (label) return label;
  }
  return DEFAULT_DEVICE;
}

export interface DeviceSummary {
  device: string;
  lastSnapshotAt: Date | null;
}

const byRecency = (a: DeviceSummary, b: DeviceSummary): number =>
  (b.lastSnapshotAt?.getTime() ?? 0) - (a.lastSnapshotAt?.getTime() ?? 0);

/**
 * Devices of one member that have at least one snapshot in this team, newest
 * first. With `since`, only devices that pushed after it — the device ceiling's
 * count.
 */
export async function devicesForUser(
  db: Db,
  teamId: string,
  userId: string,
  since?: Date,
): Promise<DeviceSummary[]> {
  const rows = await db
    .select({ device: snapshots.deviceLabel, last: max(snapshots.createdAt) })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.teamId, teamId),
        eq(snapshots.userId, userId),
        since ? gt(snapshots.createdAt, since) : undefined,
      ),
    )
    .groupBy(snapshots.deviceLabel);
  return rows.map((r) => ({ device: r.device, lastSnapshotAt: r.last })).sort(byRecency);
}

/**
 * Whether a snapshot pushed as `label` fits under the plan's device ceiling.
 *
 * `counted` says whether the label already holds a slot. A push from a device
 * that is already counted cannot change the count, so only one that would add
 * a device is counted again under the workspace lock (`insertFromNewDevice`).
 *
 * The refusal names the devices that count and when each last pushed, because
 * both ways out depend on them: a machine that replaced one of them pushes
 * under its label, and every other device frees its slot a window after its
 * last snapshot. Which way is the human's call, the same as any plan limit.
 */
export async function deviceAllowance(
  db: Db,
  team: { plan: string | null; id: string },
  userId: string,
  label: string,
  cap: number,
  now = new Date(),
): Promise<{ ok: true; counted: boolean } | { error: string }> {
  const recent = await devicesForUser(db, team.id, userId, deviceWindowStart(now));
  if (recent.some((d) => d.device === label)) return { ok: true, counted: true };
  if (recent.length < cap) return { ok: true, counted: false };
  const upgrade = cheapestWith(
    (limits) => limits.maxDevicesPerMember === null || limits.maxDevicesPerMember > cap,
  );
  return {
    error:
      `Device limit reached: the ${planName(team.plan)} plan keeps snapshots from ${cap} ` +
      `device${cap === 1 ? '' : 's'} per member, counted over the last ${DEVICE_WINDOW_DAYS} days` +
      (recent.length > 0 ? `, and you have pushed from ${describeDevices(recent)}` : '') +
      `. The snapshot from "${label}" was not stored. Tell your human: if this machine replaced ` +
      `one of those, push again with that "device" label; if not, a device stops counting ` +
      `${DEVICE_WINDOW_DAYS} days after its last snapshot` +
      (upgrade ? `, and more devices come with the ${upgrade} plan` : '') +
      '. Which way is their decision, not something to work around.',
  };
}

/**
 * Stores a snapshot from a device `deviceAllowance` did not count yet, counting
 * again under the workspace row lock the project ceiling takes. Between that
 * answer and this write another new machine may have taken the last slot, and
 * two pushes that were each told there was room would otherwise both fit.
 */
export async function insertFromNewDevice(
  db: Db,
  team: { plan: string | null; id: string },
  cap: number,
  row: typeof snapshots.$inferInsert & { deviceLabel: string },
): Promise<{ ok: true } | { error: string }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, team.id)).for('update');
    const again = await deviceAllowance(tx, team, row.userId, row.deviceLabel, cap);
    if ('error' in again) return again;
    await tx.insert(snapshots).values(row);
    return { ok: true } as const;
  });
}

/** One grouped query: every member's devices in a team, newest first. */
export async function devicesByMember(
  db: Db,
  teamId: string,
  projectId?: string,
): Promise<Map<string, DeviceSummary[]>> {
  const rows = await db
    .select({
      userId: snapshots.userId,
      device: snapshots.deviceLabel,
      last: max(snapshots.createdAt),
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.teamId, teamId),
        projectId ? eq(snapshots.projectId, projectId) : undefined,
      ),
    )
    .groupBy(snapshots.userId, snapshots.deviceLabel);
  const byUser = new Map<string, DeviceSummary[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ device: row.device, lastSnapshotAt: row.last });
    byUser.set(row.userId, list);
  }
  for (const list of byUser.values()) list.sort(byRecency);
  return byUser;
}

/** Newest snapshot timestamp across a member's devices. */
export function lastSnapshotOf(devices: DeviceSummary[] | undefined): Date | null {
  return devices?.[0]?.lastSnapshotAt ?? null;
}

/** "macbook (2 hours ago), win-desktop (3 days ago)" — for agent-facing errors. */
export function describeDevices(devices: DeviceSummary[]): string {
  return devices
    .map((d) => (d.lastSnapshotAt ? `${d.device} (${timeAgo(d.lastSnapshotAt)})` : d.device))
    .join(', ');
}
