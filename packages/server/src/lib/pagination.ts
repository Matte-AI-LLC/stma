/**
 * Offset pagination for the server-rendered lists.
 *
 * Offset rather than a keyset cursor because every paged list here already filters
 * and sorts on an indexed column and the reachable depth is deliberately small: the
 * default ceiling matches the retention row cap, so "everything still stored is
 * reachable" holds without letting a crawler ask for offset 10_000_000.
 *
 * Callers fetch `limit` rows (one more than the page size) and hand the result to
 * `slicePage`, which reports whether an older page exists — no second COUNT query.
 */
export interface PageWindow {
  /** 1-based page number, already clamped. */
  page: number;
  /** Rows shown per page. */
  size: number;
  offset: number;
  /** How many rows to ask the database for: `size + 1`, the extra one is the probe. */
  limit: number;
}

/** Deepest offset any list will serve; also the point where retention has bitten. */
export const MAX_OFFSET = 20_000;

export function pageWindow(raw: unknown, size: number, maxOffset = MAX_OFFSET): PageWindow {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  const maxPage = Math.max(1, Math.floor(maxOffset / size) + 1);
  const page = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maxPage) : 1;
  return { page, size, offset: (page - 1) * size, limit: size + 1 };
}

export interface Paged<T> {
  items: T[];
  /** True when the probe row came back: there is an older page. */
  hasMore: boolean;
  /** 1-based index of the first row shown, for the "Showing 101–200" line. */
  from: number;
  to: number;
}

/** Trim the probe row off a `limit`-sized fetch and describe the window. */
export function slicePage<T>(rows: T[], w: PageWindow): Paged<T> {
  const hasMore = rows.length > w.size;
  const items = hasMore ? rows.slice(0, w.size) : rows;
  return {
    items,
    hasMore,
    from: items.length === 0 ? 0 : w.offset + 1,
    to: w.offset + items.length,
  };
}

/**
 * A link to `page` of `path`, carrying the filters the view is already showing.
 * Page 1 drops the parameter so the canonical URL stays clean (and bookmarkable).
 */
export function pageHref(
  path: string,
  query: Record<string, string | number | undefined | null>,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
