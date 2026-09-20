import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-identity-headers-in-cached-fetch.mjs";

// RuleTester calls describe/it when they exist, so vitest reports each case.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("no-identity-headers-in-cached-fetch", rule, {
  valid: [
    // --- the two shapes the helpers actually use ------------------------------
    // viewerFetch: headers assembled in a variable, identity added, no-store.
    {
      code: `const headers = { Accept: "application/json" };\nheaders["cookie"] = jar;\nfetch(url, { headers, cache: "no-store" });`,
    },
    // publicFetch: a headers variable with no identity, revalidated.
    {
      code: `const headers = { Accept: "application/json" };\nfetch(url, { headers, next: { revalidate: 60 } });`,
    },
    // Inline identity plus the explicit opt-out.
    { code: `fetch(url, { headers: { cookie: session }, cache: "no-store" });` },
    { code: `fetch(url, { headers: { Authorization: token }, cache: "no-store" });` },
    // next: { revalidate: 0 } is the same opt-out spelled the framework's way.
    { code: `fetch(url, { headers: { Cookie: c }, next: { revalidate: 0 } });` },
    // Cached, but with no identity at all.
    {
      code: `fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 60 } });`,
    },
    { code: `fetch(url, { headers: { Accept: "application/json" } });` },
    { code: `fetch(url, { credentials: "omit", next: { revalidate: 60 } });` },
    // Not a fetch call at all.
    { code: `request(url, { headers: { cookie: c }, next: { revalidate: 60 } });` },
    // No init: nothing to read, nothing of ours to send. Stays valid by design
    // (the fail-closed rule below is about an init it CANNOT read, not an
    // absent one), and no-raw-fetch governs who may write this at all.
    { code: `fetch(url);` },
  ],
  invalid: [
    // --- the original leak ----------------------------------------------------
    {
      code: `fetch(url, { headers: { cookie: session }, next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated", data: { header: "cookie" } }],
    },
    // Casing must not matter: headers are case-insensitive on the wire.
    {
      code: `fetch(url, { headers: { "Cookie": session }, next: { revalidate: 3600 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    {
      code: `fetch(url, { headers: { AUTHORIZATION: bearer }, cache: "force-cache" });`,
      errors: [{ messageId: "revalidated" }],
    },
    {
      code: `fetch(url, { headers: new Headers({ cookie: session }), next: { revalidate: 10 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    {
      code: `fetch(url, { credentials: "include", next: { revalidate: 10 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // A framework default is not an opt-out.
    {
      code: `fetch(url, { headers: { cookie: session } });`,
      errors: [{ messageId: "unmarked", data: { header: "cookie" } }],
    },
    {
      code: `fetch(url, { method: "POST", headers: { "x-vizra-session": s } });`,
      errors: [{ messageId: "unmarked" }],
    },
    // A contradiction (no-store AND a revalidate window) is reported.
    {
      code: `fetch(url, { headers: { cookie: session }, cache: "no-store", next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    { code: `globalThis.fetch(url, { headers: { cookie: session }, next: { revalidate: 60 } });`, errors: [{ messageId: "revalidated" }] },

    // --- headers assembled in a variable (the mutation that first slipped) ----
    {
      code: `const headers = { Accept: "application/json" };\nheaders["cookie"] = jar;\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated", data: { header: "cookie" } }],
    },
    {
      code: `const headers = { Accept: "application/json" };\nheaders.authorization = bearer;\nfetch(url, { headers });`,
      errors: [{ messageId: "unmarked" }],
    },
    {
      code: `const headers = { cookie: jar };\nfetch(url, { headers, cache: "force-cache" });`,
      errors: [{ messageId: "revalidated" }],
    },
    {
      code: `const h = { cookie: jar };\nfetch(url, { headers: h, next: { revalidate: 5 } });`,
      errors: [{ messageId: "revalidated" }],
    },

    // --- FAIL CLOSED ----------------------------------------------------------
    // Every case below was a SILENT PASS in the first version of this rule.
    // Two independent reviewers found them; they are the reason the rule now
    // reports what it cannot read instead of returning.

    // B5 — the init object hoisted into a variable. One line of refactoring,
    // and the rule saw nothing at all.
    {
      code: `const headers = { cookie: jar };\nconst init = { headers, next: { revalidate: 60 } };\nfetch(url, init);`,
      errors: [{ messageId: "unreadable" }],
    },
    // An init that is any non-literal expression.
    { code: `fetch(url, opts);`, errors: [{ messageId: "unreadable" }] },
    { code: `fetch(url, makeInit());`, errors: [{ messageId: "unreadable" }] },
    { code: `fetch(url, { ...base });`, errors: [{ messageId: "unreadable" }] },
    // B6 — spread into the init.
    {
      code: `fetch(url, { headers: { cookie: jar }, ...posture });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B1 — headers spread from a function call.
    {
      code: `fetch(url, { headers: { ...identityHeaders() }, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B8 — a computed header key.
    {
      code: `fetch(url, { headers: { [name]: session }, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // A computed key in the init itself could be `cache`.
    {
      code: `fetch(url, { headers: { cookie: jar }, [key]: value });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B2 — new Headers() then .set(): the binding escapes into a call.
    {
      code: `const headers = new Headers();\nheaders.set("cookie", jar);\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B9 — Object.assign onto the headers binding.
    {
      code: `const headers = { Accept: "application/json" };\nObject.assign(headers, { cookie: jar });\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B7 — a second alias of the headers binding.
    {
      code: `const headers = { Accept: "application/json" };\nconst other = headers;\nother.cookie = jar;\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // B3 — headers arriving as a function parameter, so the call site's
    // identity is decided somewhere this rule is not looking.
    {
      code: `function send(headers) { return fetch(url, { headers, next: { revalidate: 60 } }); }`,
      errors: [{ messageId: "unreadable" }],
    },
    // A headers binding that is reassigned wholesale.
    {
      code: `let headers = { Accept: "a" };\nheaders = { cookie: jar };\nfetch(url, { headers, cache: "no-store" });`,
      errors: [{ messageId: "unreadable" }],
    },
    // A computed member write: the header NAME is not knowable.
    {
      code: `const headers = { Accept: "a" };\nheaders[name] = value;\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // A non-literal credentials value.
    {
      code: `fetch(url, { credentials: mode, next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
    // Headers built by a call.
    {
      code: `fetch(url, { headers: buildHeaders(), cache: "no-store" });`,
      errors: [{ messageId: "unreadable" }],
    },
    // new Headers(x) with a non-literal argument.
    {
      code: `fetch(url, { headers: new Headers(raw), next: { revalidate: 60 } });`,
      errors: [{ messageId: "unreadable" }],
    },
  ],
});
