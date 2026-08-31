import type { User } from '../types';
import { Head, Logo } from './Layout';
import { AppLayout } from './Layout';

/**
 * The page for a URL that is not one.
 *
 * It used to be Hono's default: `text/plain`, no layout, no way back. A signed-in
 * user who mistypes a team slug or follows a link to something that has been
 * deleted lands on a dead page and has to reach for the back button — which is a
 * strange thing for a console to do when it knows exactly who they are and where
 * their work is.
 *
 * It says nothing about what does exist. Several routes answer `c.notFound()`
 * deliberately to keep an area undisclosed (`/admin` to a non-operator, a team
 * you are not in), so this page has to look identical whether the URL is wrong
 * or merely not yours.
 */
export const NotFoundPage = ({ user, path }: { user: User; path: string }) => (
  <AppLayout user={user} title="Not found">
    <div class="card card-pad joincard">
      <span class="tile tile-44 tile-gray">×</span>
      <h2 class="title m0">Page not found</h2>
      <p class="m0 sub">
        Nothing answers <code>{path}</code>. It may have been renamed or deleted, or it may not be
        yours to see.
      </p>
      <div class="row" style="gap:8px">
        <a class="btn btn-primary" href="/app/agents">
          Agent map
        </a>
        <a class="btn" href="/app">
          Teams
        </a>
        <a class="btn" href="/docs">
          Docs
        </a>
      </div>
    </div>
  </AppLayout>
);

/** The same answer for somebody who is not signed in — no rail to send them to. */
export const NotFoundPublic = ({ path }: { path: string }) => (
  <html lang="en">
    <Head title="Not found" />
    <body>
      <div class="auth-wrap">
        <div class="auth-card">
          <Logo lg />
          <div>
            <h1>Page not found</h1>
            <p class="lede">
              Nothing answers <code>{path}</code>. If you were sent here by a link, it may have
              expired.
            </p>
          </div>
          <a class="btn btn-primary" style="width:100%;height:44px" href="/">
            Go to the home page
          </a>
          <p class="finenote">
            Already have an account? <a href="/login">Sign in</a> · <a href="/docs">Docs</a>
          </p>
        </div>
      </div>
    </body>
  </html>
);
