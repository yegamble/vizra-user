/**
 * The security response headers (war-room queue row 5, "security F3"):
 * a nonce-based Content-Security-Policy with no `unsafe-inline` /
 * `unsafe-eval` in `script-src`, `frame-ancestors 'none'`, Referrer-Policy,
 * `nosniff` and Permissions-Policy — ENFORCING, never `-Report-Only`.
 *
 * This module is the single definition. Two callers apply it:
 *   - `next.config.ts` `headers()` puts STATIC_SECURITY_HEADERS on every path,
 *     static assets included;
 *   - `proxy.ts` mints a nonce per request and puts the policy on every
 *     response it handles (everything except `/_next/static` and
 *     `/_next/image`).
 *
 * Pure and dependency-free on purpose: it is imported by the proxy, by the
 * Next configuration and by tests, and none of those should pull in more.
 */

export const CSP_HEADER = "Content-Security-Policy";

/** Headers whose value never varies by request. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ readonly key: string; readonly value: string }> = [
  // A response is what its Content-Type says it is. Matters most for a
  // service whose whole purpose is serving files that visitors uploaded.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Cross-origin navigations and requests learn the origin and nothing else:
  // an unlisted photo's URL is its capability and must not leak in a Referer.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny, for this origin and every frame, the device capabilities the
  // product does not use.
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  },
];

/** base64 / base64url alphabet, at least 128 bits' worth of characters. */
const NONCE = /^[A-Za-z0-9+/_-]{22,}={0,2}$/;

/** A fresh, unpredictable nonce: 128 random bits, base64. One per request. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface CspOptions {
  /**
   * `next dev` only: React's development build reconstructs server stacks with
   * `eval`, so the DEVELOPMENT policy must allow it. A production build never
   * sets this, and the tests assert the production policy has no `unsafe-*`
   * source anywhere.
   */
  readonly development?: boolean;
}

/**
 * The policy for one response.
 *
 * - `script-src`: same-origin files and scripts carrying this request's nonce.
 *   `'strict-dynamic'` lets a nonced script load the chunks it needs, which is
 *   how Next.js loads route code. No `unsafe-inline`, no `unsafe-eval`.
 * - `style-src`: same-origin stylesheets and nonced `<style>`; no inline
 *   `style=""` allowance.
 * - `img-src` / `connect-src` / `font-src`: this origin only (plus `blob:` and
 *   `data:` for images the page itself produces). A slice that serves media
 *   from another origin extends this list here, in review, with the reason.
 * - `frame-ancestors 'none'`: the application cannot be framed anywhere.
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`: the three
 *   injection routes `default-src` does not cover.
 *
 * `upgrade-insecure-requests` is deliberately absent: a self-hosted instance
 * may be reached over plain HTTP on a private network, and transport policy
 * belongs to the deployment's TLS terminator.
 */
export function buildContentSecurityPolicy(nonce: string, options: CspOptions = {}): string {
  if (!NONCE.test(nonce)) {
    // A nonce is interpolated into a header. Refuse anything that is not a
    // plain base64 token rather than emit a policy an attacker helped write.
    throw new Error("buildContentSecurityPolicy: the nonce is not a base64 token of at least 128 bits");
  }
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (options.development === true) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
