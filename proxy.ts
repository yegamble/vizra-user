/**
 * Per-request Content-Security-Policy (see lib/security/headers.ts).
 *
 * Next.js reads the policy from the REQUEST headers while it renders and puts
 * the nonce on every script it emits; the same policy goes on the RESPONSE so
 * the browser enforces it. Both must carry the same nonce, so both are set
 * here from one value.
 *
 * The matcher excludes only the two static prefixes, whose responses are not
 * documents and get the static headers from next.config.ts. Everything else —
 * pages, 404s, prefetches — is covered: a route added later is protected
 * without anyone remembering to list it.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  generateNonce,
  STATIC_SECURITY_HEADERS,
} from "@/lib/security/headers";

export function proxy(request: NextRequest): NextResponse {
  const policy = buildContentSecurityPolicy(generateNonce(), {
    development: process.env.NODE_ENV === "development",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_HEADER, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  // Also set by next.config.ts for every path. Repeated here so a response
  // this function handles carries them even if that configuration is lost.
  for (const { key, value } of STATIC_SECURITY_HEADERS) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
