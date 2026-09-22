import type { Child } from 'hono/jsx';
import type { Context } from 'hono';
import { accessCodeRequired } from '../auth/accessCodes';
import type { AppEnv, User } from '../types';
import { VERSION } from '../version';
import { Head, Logo } from './Layout';
import { Mail, NoScan } from './Mail';

/**
 * The signed-out site: header, footer and the page around them.
 *
 * Five pages drew their own copy of this — the landing page, the guide, help,
 * the legal pages and pricing — and they had drifted: one footer offered
 * support and four did not, one header linked Help and four did not. One
 * component, so a visitor meets one site.
 *
 * Every door it draws is a door that is there: Pricing only where billing is
 * composed, the access-code call to action only where codes are configured,
 * the support and privacy addresses only where the instance has them. That is
 * the rule the landing page's call to action always followed, applied to the
 * whole frame.
 */
export type SiteInfo = {
  user: User | null | undefined;
  /** Where a person writes when something goes wrong; empty means no door. */
  support: string;
  /** Where a data-protection request goes; empty means no door. */
  privacy: string;
  /** Billing is composed: the pricing page exists. */
  pricing: boolean;
  /** Signup takes an access code (the private beta's door). */
  codeDoor: boolean;
  /**
   * Which beta this instance is running, if any.
   *
   * A door that asks for a code is a private beta; a door anybody can walk
   * through is a public one; and once people are paying it is not a beta at
   * all. `BETA_UNMETERED` decides that last part because that flag *is*
   * "nothing to pay yet" — the same fact `effectivePlanLabel` reads inside the
   * console, so the page a stranger sees and the plan label a member sees can
   * never disagree. Derived rather than configured: a second variable saying
   * "call it public now" is one more thing to forget on the day the door opens.
   */
  beta: 'private' | 'public' | null;
  /** Signup is open at all. */
  signupsOpen: boolean;
  /** The pre-launch face: `SITE_MODE=teaser`. */
  teaser: boolean;
  /** The hosted service rather than somebody's own instance. */
  hosted: boolean;
};

export function siteInfo(c: Context<AppEnv>): SiteInfo {
  const env = c.get('env');
  const signupsOpen = env.localAuth && env.signupsOpen;
  const codeDoor = signupsOpen && accessCodeRequired(env);
  const openToAnyone = signupsOpen && !codeDoor && env.publicMode !== 'teaser';
  return {
    user: c.get('user'),
    support: env.supportEmail,
    privacy: env.privacyEmail,
    // Pricing sells plans; a teaser page does not sell anything yet.
    pricing: c.get('capabilities').managedBilling && env.publicMode !== 'teaser',
    codeDoor,
    signupsOpen,
    teaser: env.publicMode === 'teaser',
    hosted: env.hosted,
    // The pre-launch face is a private beta whatever else is set — nobody can
    // sign up at all. Otherwise the beta is the hosted service while nobody is
    // paying, and the door decides which one it is.
    beta:
      env.publicMode === 'teaser'
        ? 'private'
        : env.hosted && env.betaUnmetered
          ? openToAnyone
            ? 'public'
            : 'private'
          : null,
  };
}

/**
 * The one way in a signed-out visitor is offered, if there is one: the access
 * code while the beta asks for one, open signup where it is open and the site
 * is not the pre-launch face, and otherwise nothing but Sign in.
 */
export function siteDoor(site: SiteInfo): { href: string; short: string; long: string } | undefined {
  if (site.user) return undefined;
  if (site.codeDoor) return { href: '/signup', short: 'Get access', long: 'I have an access code' };
  if (site.signupsOpen && !site.teaser) return { href: '/signup', short: 'Get started', long: 'Get started free' };
  return undefined;
}

export const SiteHeader = ({ site, active }: { site: SiteInfo; active?: 'docs' | 'help' | 'pricing' | 'legal' }) => {
  const door = siteDoor(site);
  const on = (key: typeof active) => (key === active ? 'plain on' : 'plain');
  return (
    <header class="site-head">
      <div class="container site-head-inner">
        <a class="brand" href="/">
          <Logo />
          Speak to my Agent
        </a>
        <nav class="site-nav" aria-label="Site">
          <a class="plain wide-only" href="/#product">
            Product
          </a>
          <a class="plain wide-only" href="/#security">
            Security
          </a>
          <a class={on('docs')} href="/docs">
            Docs
          </a>
          <a class={`${on('help')} wide-only`} href="/help">
            Help
          </a>
          {site.pricing ? (
            <a class={`${on('pricing')} wide-only`} href="/pricing">
              Pricing
            </a>
          ) : null}
          {site.user ? (
            <a class="btn btn-sm btn-primary" href="/app">
              Open console
            </a>
          ) : (
            <a class="btn btn-sm" href="/login">
              Sign in
            </a>
          )}
          {door ? (
            <a class="btn btn-sm btn-primary narrow-hide" href={door.href}>
              {door.short}
            </a>
          ) : null}
        </nav>
      </div>
    </header>
  );
};

export const SiteFooter = ({ site }: { site: SiteInfo }) => (
  <footer class="site-foot">
    <div class="container">
      <div class="foot-grid">
        <div class="foot-brand">
          <a class="brand" href="/">
            <Logo />
            Speak to my Agent
          </a>
          <p>
            AgentOps for teams that build with coding agents: see every run, keep agents off each
            other's ground, give them the team's rules and prove what they did.
          </p>
        </div>
        <nav class="foot-col" aria-label="Product">
          <h5>Product</h5>
          <a href="/#product">Overview</a>
          <a href="/docs">Documentation</a>
          <a href="/help">Help &amp; troubleshooting</a>
          {site.pricing ? <a href="/pricing">Pricing</a> : null}
          <a href="/#security">Security</a>
        </nav>
        <nav class="foot-col" aria-label="Legal">
          <h5>Legal</h5>
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
          {site.privacy ? <a href="/privacy#rights">GDPR &amp; KVKK requests</a> : null}
        </nav>
        {site.support || site.privacy ? (
          <nav class="foot-col" aria-label="Contact">
            <h5>Contact</h5>
            {/* Before Terms in the old footer, because somebody reading a footer
                in trouble is looking for this one; its own column now. */}
            {site.support ? <Mail to={site.support} label="Support" /> : null}
            {site.support ? <NoScan><span class="foot-addr">{site.support}</span></NoScan> : null}
            {site.privacy ? <Mail to={site.privacy} label="Data protection" /> : null}
            {site.privacy ? <NoScan><span class="foot-addr">{site.privacy}</span></NoScan> : null}
          </nav>
        ) : null}
      </div>
      <div class="foot-base">
        <span>© 2026 Matte AI LLC</span>
        <span>
          {site.beta ? `${site.beta === 'public' ? 'Public' : 'Private'} beta · ` : ''}v{VERSION}
        </span>
      </div>
    </div>
  </footer>
);

/** A whole signed-out page: head, site header, the page's own content, footer. */
export const SitePage = ({
  site,
  title,
  description,
  active,
  children,
}: {
  site: SiteInfo;
  title?: string;
  description?: string;
  active?: 'docs' | 'help' | 'pricing' | 'legal';
  children?: Child;
}) => (
  <html lang="en">
    <Head title={title} description={description} />
    <body class="site">
      <SiteHeader site={site} active={active} />
      {children}
      <SiteFooter site={site} />
    </body>
  </html>
);
