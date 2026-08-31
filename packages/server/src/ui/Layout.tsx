import type { Child } from 'hono/jsx';
import { CSS_URL, FAVICON_URL, JS_URL } from './assets';
import type { User } from '../types';
import { ConsoleShell, Logo, type KeyHint, type RailKey } from './Console';

// The mark lives in Console.tsx (the shell owns the brand); re-exported here so
// the nine pages that always imported it from the layout keep working.
export { Logo };

export const Head = ({ title }: { title?: string }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title ? `${title} — STMA` : 'STMA — Speak to my Agent'}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
    <link
      href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link rel="icon" type="image/svg+xml" href={FAVICON_URL} />
    <link rel="stylesheet" href={CSS_URL} />
    <script src={JS_URL} defer></script>
  </head>
);

export const ConfirmDialog = () => (
  <dialog id="confirm-dialog" class="confirm">
    <form method="dialog">
      <h3 data-dlg-title="t">Are you sure?</h3>
      <p data-dlg-body="t"></p>
      <div class="dialog-actions">
        <button value="cancel" class="btn" type="submit">
          Cancel
        </button>
        <button value="ok" class="btn btn-danger-solid" type="submit" data-dlg-ok="t">
          Confirm
        </button>
      </div>
    </form>
  </dialog>
);

/**
 * Signed-in application shell.
 *
 * The name and signature are unchanged on purpose: this used to render a dark
 * top nav, and twenty-three call sites passed exactly `user`, `active`,
 * `title` and children. Rebuilding it as the command console rather than
 * introducing a second layout meant every page got the rail on the same day,
 * instead of half the app looking like the old product.
 *
 * The console's extra slots — status strip, page head, alert band, inspector,
 * key hints — are all optional, so the pages that were not part of the redesign
 * keep the padded column they were written for.
 */
export const AppLayout = ({
  user,
  active,
  title,
  strip,
  scope,
  head,
  band,
  inspector,
  keys,
  keysNote,
  bleed,
  children,
}: {
  user: User;
  active?: RailKey;
  title?: string;
  strip?: Child;
  scope?: Child;
  head?: Child;
  band?: Child;
  inspector?: Child;
  keys?: KeyHint[];
  keysNote?: string;
  bleed?: boolean;
  children?: Child;
}) => (
  <html lang="en">
    <Head title={title} />
    <body>
      <ConsoleShell
        user={user}
        active={active}
        strip={strip}
        scope={scope}
        head={head}
        band={band}
        inspector={inspector}
        keys={keys}
        keysNote={keysNote}
        bleed={bleed}
      >
        {children}
      </ConsoleShell>
      <ConfirmDialog />
    </body>
  </html>
);
