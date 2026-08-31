/**
 * Step-by-step token instructions, folded into the connect forms.
 *
 * These exist because "needs a PAT with Code read & write" is a sentence for
 * someone who has minted PATs before. The people this product onboards have
 * usually connected trackers through an OAuth button — the token pages are
 * genuinely hard to find the first time (the Jira one moved off the Jira site
 * entirely, onto id.atlassian.com), and a wrong guess at the Azure scopes
 * fails three screens later at apply time. The steps name every click.
 */

export const AdoTokenHelp = () => (
  <details class="tokhelp">
    <summary>How to create this token (step by step)</summary>
    <ol>
      <li>
        Open <span class="mono">dev.azure.com/&lt;your-organization&gt;</span> and sign in.
      </li>
      <li>
        Top right, click the <b>user settings</b> icon (the little person with a gear, next to
        your avatar) → <b>Personal access tokens</b>.
      </li>
      <li>
        <b>+ New Token</b>. Name it (e.g. <span class="mono">stma</span>), and under{' '}
        <b>Organization</b> pick <b>this organization</b> — a token minted for another org answers
        exactly like a wrong repository name.
      </li>
      <li>
        Under <b>Scopes</b> choose <b>Custom defined</b>, then tick{' '}
        <b>Code → Read &amp; write</b> and <b>Build → Read &amp; execute</b>. (Click "Show all
        scopes" at the bottom if Build is not visible.)
      </li>
      <li>
        <b>Create</b>, copy the token immediately — Azure shows it exactly once — and paste it
        here. Note the expiry date: Azure PATs expire (90 days by default) and an expired one
        fails with the same message as a mistyped one.
      </li>
    </ol>
  </details>
);

export const JiraTokenHelp = () => (
  <details class="tokhelp">
    <summary>How to create this token (step by step)</summary>
    <ol>
      <li>
        Go to <span class="mono">id.atlassian.com/manage-profile/security/api-tokens</span> —
        this lives on your <b>Atlassian account</b>, not inside Jira, which is why it is hard to
        find from the Jira UI. (Manual route: avatar → <b>Manage account</b> → <b>Security</b> →{' '}
        <b>Create and manage API tokens</b>.)
      </li>
      <li>
        <b>Create API token.</b> Atlassian's current flow creates tokens <b>with scopes</b> (the
        old plain kind was retired in 2026 — if you still see both, either works). For a scoped
        one: choose the <b>Jira</b> app and tick at least <b>read:jira-user</b> and{' '}
        <b>read:jira-work</b>. Name it, set the expiry, create, copy it once — it starts with{' '}
        <span class="mono">ATATT</span>. STMA detects a scoped token on its own and routes the
        calls accordingly.
      </li>
      <li>
        <b>Wrong door check:</b> if the page that made your key also showed an{' '}
        <b>Organization ID</b>, you were on <span class="mono">admin.atlassian.com</span> — that
        is an <i>admin API key</i> for user management, and it cannot read Jira issues. Go back to
        the address above instead; a personal token never comes with an organization ID.
      </li>
      <li>
        Back here: <b>site</b> is your Jira host (<span class="mono">acme.atlassian.net</span>),{' '}
        <b>email</b> is the address of the Atlassian account that just created the token, and the
        token goes in the last box. All three must belong together — a valid token with somebody
        else's email fails as if it were wrong.
      </li>
      <li>
        If your company signs into Jira through SSO and the token page is blocked by policy, use a
        personal/test Atlassian site instead — STMA only reads issue titles, it never writes.
      </li>
    </ol>
  </details>
);
