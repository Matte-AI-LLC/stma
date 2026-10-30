/**
 * Authenticator-app codes (RFC 6238 TOTP), as a thin wrapper over `otpauth`.
 *
 * Nothing here is hand-written cryptography: the HMAC, the dynamic truncation
 * and the comparison are the library's, and the RFC's own test vectors run
 * through this module in `authenticator.test.ts`. What lives here is the one
 * set of parameters every common authenticator app supports (SHA-1, six
 * digits, thirty seconds) and the arithmetic that turns the library's "delta"
 * into an absolute time step, which is what the replay guard stores.
 *
 * `qrSvg` renders the enrollment URI as an inline SVG, so enrolling needs no
 * image request and no change to the content security policy.
 */
import { Secret, TOTP } from 'otpauth';
import { renderSVG } from 'uqr';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';
/** Steps either side of now that still count: thirty seconds of clock drift. */
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = 'STMA';

const PERIOD_MS = TOTP_PERIOD_SECONDS * 1000;

/** A fresh 160-bit secret, base32 as authenticator apps expect it. */
export function generateAuthenticatorSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The `otpauth://` URI an app scans. It carries the secret, so it is shown once and never logged. */
export function otpauthUri(input: { label: string; secret: string; issuer?: string }): string {
  return new TOTP({
    issuer: input.issuer ?? TOTP_ISSUER,
    label: input.label,
    secret: Secret.fromBase32(input.secret),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).toString();
}

/** The absolute TOTP time step at a moment: what `last_step` stores. */
export const totpStep = (nowMs: number): number => Math.floor(nowMs / PERIOD_MS);

/**
 * The code an app shows at a moment. Production never needs it, since a code is
 * only ever checked, but the tests compute codes from absolute steps with it
 * and the RFC vectors need the other algorithms and lengths.
 */
export function totpCode(
  secret: string,
  nowMs: number,
  options: { algorithm?: string; digits?: number } = {},
): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: options.algorithm ?? TOTP_ALGORITHM,
    digits: options.digits ?? TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp: nowMs,
  });
}

/**
 * Which absolute time step this code belongs to, within one step either side of
 * now, or null when it matches none of them.
 *
 * The shape is checked first so a recovery code or a pasted sentence never
 * reaches the library. The caller decides whether the step is new enough: the
 * same code is valid for the whole window, and only `last_step` stops it being
 * used twice.
 */
export function matchStep(secret: string, token: string, nowMs: number = Date.now()): number | null {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(token)) return null;
  const delta = TOTP.validate({
    token,
    secret: Secret.fromBase32(secret),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp: nowMs,
    window: TOTP_WINDOW,
  });
  return delta === null ? null : totpStep(nowMs) + delta;
}

/**
 * The enrollment URI as a QR code.
 *
 * The output is uqr's own fixed-geometry SVG: the only input is the URI, which
 * becomes black and white modules rather than markup, so inserting it unescaped
 * cannot carry anything a person typed into the page.
 */
export function qrSvg(uri: string): string {
  return renderSVG(uri, { ecc: 'M', border: 2, pixelSize: 5, blackColor: '#111', whiteColor: '#fff' });
}

/** The secret in groups of four, which is how it is easiest to type into an app by hand. */
export const groupedSecret = (secret: string): string => secret.replace(/(.{4})(?=.)/g, '$1 ');
