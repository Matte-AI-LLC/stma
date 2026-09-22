import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';

/**
 * An email address the page means to publish, kept readable.
 *
 * Cloudflare's Email Address Obfuscation rewrites every `mailto:` link and every
 * address it finds in the text into a script-decoded placeholder. Measured on
 * production 2026-09-22, the privacy policy's own contact sentence read
 * "write to [email protected]" in the served HTML, and that is all a reader
 * with no script gets — on the page whose job is to publish the address a data
 * protection request goes to. `<!--email_off-->` is Cloudflare's own per-block
 * opt-out, so the fix is in the markup rather than in a zone setting somebody
 * has to remember.
 *
 * Wrap the address itself, not the paragraph around it: the comment pair only
 * has to cover what the scanner would rewrite.
 */
export const NoScan = ({ children }: { children: Child }) => (
  <>
    {raw('<!--email_off-->')}
    {children}
    {raw('<!--email_on-->')}
  </>
);

/** A `mailto:` link whose address stays legible: the common case. */
export const Mail = ({
  to,
  subject,
  label,
  class: className,
}: {
  to: string;
  subject?: string;
  label?: Child;
  class?: string;
}) => (
  <NoScan>
    <a class={className} href={`mailto:${to}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`}>
      {label ?? to}
    </a>
  </NoScan>
);
