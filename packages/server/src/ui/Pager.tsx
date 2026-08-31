import { pageHref, type Paged, type PageWindow } from '../lib/pagination';

/**
 * Newer/Older links plus the sentence that makes the window honest: how many rows
 * this page is showing, and whether older ones are still behind it. Rendered even
 * on a single page, so a list never quietly looks complete when it is not.
 */
export const Pager = ({
  path,
  query,
  window: w,
  page: p,
  noun,
  note,
}: {
  path: string;
  /** Filters the current view is showing; carried into both links. */
  query?: Record<string, string | number | undefined | null>;
  window: PageWindow;
  page: Paged<unknown>;
  /** Plural noun for the count line, e.g. "events". */
  noun: string;
  /** Extra clause appended to the count line, e.g. a retention reminder. */
  note?: string;
}) => {
  const q = query ?? {};
  const newer = w.page > 1;
  return (
    <div class="pager">
      <span class="pager-note">
        {p.items.length === 0 ? (
          <>No {noun} on this page.</>
        ) : (
          <>
            Showing {noun} <b>{p.from}</b>–<b>{p.to}</b>
            {p.hasMore ? (
              <>
                {' '}
                — <b>older {noun} are not shown</b>; use Older to reach them
              </>
            ) : (
              <> — this is the end of the list</>
            )}
          </>
        )}
        {note ? ` ${note}` : ''}
      </span>
      <div class="row">
        <a
          class={`btn btn-sm${newer ? '' : ' off'}`}
          href={newer ? pageHref(path, q, w.page - 1) : '#'}
          aria-disabled={newer ? undefined : 'true'}
        >
          ← Newer
        </a>
        <a
          class={`btn btn-sm${p.hasMore ? '' : ' off'}`}
          href={p.hasMore ? pageHref(path, q, w.page + 1) : '#'}
          aria-disabled={p.hasMore ? undefined : 'true'}
        >
          Older →
        </a>
      </div>
    </div>
  );
};
