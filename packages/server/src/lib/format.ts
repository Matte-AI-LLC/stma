export const fmtDate = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : '—');

/** "ada.marek" → "AM", "alice" → "AL" */
export function initials(name: string): string {
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  const chars =
    parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return chars.toUpperCase();
}

export function timeAgo(d: Date | null | undefined): string | null {
  if (!d) return null;
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  return fmtDate(d);
}
