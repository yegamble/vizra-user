import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { config as proxyConfig, proxy } from "../../proxy";
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  generateNonce,
  STATIC_SECURITY_HEADERS,
} from "./headers";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";

function directives(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === undefined || name === "") continue;
    if (map.has(name)) throw new Error(`directive ${name} appears twice`);
    map.set(name, sources);
  }
  return map;
}

describe("the Content-Security-Policy", () => {
  const policy = directives(buildContentSecurityPolicy(NONCE));

  it("allows scripts only from this origin or carrying the request's nonce", () => {
    expect(policy.get("script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
  });

  it("has no unsafe-inline, unsafe-eval or wildcard source in ANY directive in production", () => {
    for (const [name, sources] of policy) {
      for (const source of sources) {
        expect(source, `${name} carries ${source}`).not.toMatch(/unsafe-|^\*$|^https?:$/);
      }
    }
  });

  it("forbids framing, plugins, foreign <base> and foreign form targets", () => {
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("defaults everything else to this origin", () => {
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
  });

  it("allows eval only when asked for the development server, and nothing else changes", () => {
    const development = directives(buildContentSecurityPolicy(NONCE, { development: true }));
    expect(development.get("script-src")).toEqual([...(policy.get("script-src") ?? []), "'unsafe-eval'"]);
    development.delete("script-src");
    const production = new Map(policy);
    production.delete("script-src");
    expect([...development]).toEqual([...production]);
  });

  it.each(["", "short", "abc'; script-src *", "AAAAAAAAAAAAAAAAAAAAAA==\r\nX-Injected: 1", "AAAAAAAAAAAAAAAAAAAA A=="])(
    "refuses a nonce that is not a base64 token: %j",
    (bad) => {
      expect(() => buildContentSecurityPolicy(bad)).toThrow(/nonce/);
    },
  );

  it("mints a different 128-bit nonce every time", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(nonces.size).toBe(200);
    for (const nonce of nonces) {
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
      expect(() => buildContentSecurityPolicy(nonce)).not.toThrow();
    }
  });
});

/** The headers queue row 5 names, with the values this application commits to. */
const REQUIRED_STATIC: Readonly<Record<string, RegExp>> = {
  "x-content-type-options": /^nosniff$/,
  "referrer-policy": /^strict-origin-when-cross-origin$/,
  "permissions-policy": /^(?=.*\bcamera=\(\))(?=.*\bmicrophone=\(\))(?=.*\bgeolocation=\(\)).+$/,
};

describe("the static security headers", () => {
  it("are exactly nosniff, Referrer-Policy and Permissions-Policy", () => {
    const got = new Map(STATIC_SECURITY_HEADERS.map(({ key, value }) => [key.toLowerCase(), value]));
    expect([...got.keys()].sort()).toEqual(Object.keys(REQUIRED_STATIC).sort());
    for (const [key, pattern] of Object.entries(REQUIRED_STATIC)) expect(got.get(key)).toMatch(pattern);
  });

  it("are applied by next.config.ts to every path", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.source).toBe("/:path*");
    const got = new Map((rules?.[0]?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
    for (const [key, pattern] of Object.entries(REQUIRED_STATIC)) {
      expect(got.get(key), `next.config.ts does not send ${key}`).toMatch(pattern);
    }
  });
});

describe("proxy.ts", () => {
  const run = () => proxy(new NextRequest("http://vizra.test/some/page"));

  it("sends an ENFORCING policy, not a report-only one", () => {
    const response = run();
    expect(response.headers.get(CSP_HEADER)).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}=='/);
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("sends the production policy outside `next dev` (no unsafe-* source)", () => {
    expect(process.env.NODE_ENV).not.toBe("development");
    expect(run().headers.get(CSP_HEADER)).not.toMatch(/unsafe-/);
  });

  it("hands the renderer the SAME policy it sends the browser", () => {
    const response = run();
    // NextResponse.next({ request: { headers } }) records each overridden
    // request header as `x-middleware-request-<name>`.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(
      response.headers.get(CSP_HEADER),
    );
  });

  it("uses a fresh nonce for every request", () => {
    const nonce = (value: string | null) => /'nonce-([^']+)'/.exec(value ?? "")?.[1];
    const first = nonce(run().headers.get(CSP_HEADER));
    const second = nonce(run().headers.get(CSP_HEADER));
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("also carries every static header", () => {
    const response = run();
    for (const [key, pattern] of Object.entries(REQUIRED_STATIC)) {
      expect(response.headers.get(key), `the proxy response lacks ${key}`).toMatch(pattern);
    }
  });

  it("excludes only the static asset prefixes from its matcher", () => {
    expect(proxyConfig.matcher).toEqual(["/((?!_next/static|_next/image).*)"]);
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    for (const covered of ["/", "/health", "/api/anything", "/favicon.ico", "/no/such/page"]) {
      expect(matcher.test(covered), `${covered} must be covered`).toBe(true);
    }
    for (const excluded of ["/_next/static/chunks/a.js", "/_next/image"]) {
      expect(matcher.test(excluded), `${excluded} must be excluded`).toBe(false);
    }
  });
});
