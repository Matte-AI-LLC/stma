import { createHash } from 'node:crypto';
import { and, eq, max } from 'drizzle-orm';
import type { Db } from '../db';
import { snapshots } from '../db/schema';
import { timeAgo } from './format';

/** Device slot used when a caller gives no label and its token has no usable name. */
export const DEFAULT_DEVICE = 'default';
export const DEVICE_LABEL_MAX = 40;

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

/** Devices of one member that have at least one snapshot in this team, newest first. */
export async function devicesForUser(
  db: Db,
  teamId: string,
  userId: string,
): Promise<DeviceSummary[]> {
  const rows = await db
    .select({ device: snapshots.deviceLabel, last: max(snapshots.createdAt) })
    .from(snapshots)
    .where(and(eq(snapshots.teamId, teamId), eq(snapshots.userId, userId)))
    .groupBy(snapshots.deviceLabel);
  return rows.map((r) => ({ device: r.device, lastSnapshotAt: r.last })).sort(byRecency);
}

/** One grouped query: every member's devices in a team, newest first. */
export async function devicesByMember(
  db: Db,
  teamId: string,
): Promise<Map<string, DeviceSummary[]>> {
  const rows = await db
    .select({
      userId: snapshots.userId,
      device: snapshots.deviceLabel,
      last: max(snapshots.createdAt),
    })
    .from(snapshots)
    .where(eq(snapshots.teamId, teamId))
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
