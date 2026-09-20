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
    // Headers built in a variable, with the explicit opt-out: the shape
    // viewerFetch actually uses.
    {
      code: `const headers = { Accept: "application/json" };\nheaders["cookie"] = jar;\nfetch(url, { headers, cache: "no-store" });`,
    },
    // A variable of headers with no identity in it, cached: fine.
    {
      code: `const headers = { Accept: "application/json" };\nfetch(url, { headers, next: { revalidate: 60 } });`,
    },
    // The shape viewerFetch uses: identity plus an explicit opt-out.
    {
      code: `fetch(url, { headers: { cookie: session }, cache: "no-store" });`,
    },
    {
      code: `fetch(url, { headers: { Authorization: token }, cache: "no-store" });`,
    },
    // next: { revalidate: 0 } is the same opt-out spelled the framework's way.
    {
      code: `fetch(url, { headers: { Cookie: c }, next: { revalidate: 0 } });`,
    },
    // The shape publicFetch uses: cached, but with no identity at all.
    {
      code: `fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 60 } });`,
    },
    { code: `fetch(url, { headers: { Accept: "application/json" } });` },
    // credentials: "omit" is not identity.
    { code: `fetch(url, { credentials: "omit", next: { revalidate: 60 } });` },
    // Not a fetch call.
    { code: `request(url, { headers: { cookie: c }, next: { revalidate: 60 } });` },
    // No options object to read: out of this rule's reach by design — see the
    // header comment, and no-raw-fetch keeps such call sites out of the tree.
    { code: `fetch(url);` },
  ],
  invalid: [
    // THE REGRESSION THIS RULE WAS STRENGTHENED FOR: headers assembled in a
    // variable (as viewerFetch does) and then revalidated. The first version
    // of the rule missed exactly this, so weakening viewerFetch produced no
    // lint error at all.
    {
      code: `const headers = { Accept: "application/json" };\nheaders["cookie"] = jar;\nfetch(url, { headers, next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated", data: { header: "cookie" } }],
    },
    {
      code: `const headers = { Accept: "application/json" };\nheaders.authorization = bearer;\nfetch(url, { headers });`,
      errors: [{ messageId: "unmarked" }],
    },
    // Identity present in the variable's initializer.
    {
      code: `const headers = { cookie: jar };\nfetch(url, { headers, cache: "force-cache" });`,
      errors: [{ messageId: "revalidated" }],
    },
    // Shorthand and explicit spelling behave the same.
    {
      code: `const h = { cookie: jar };\nfetch(url, { headers: h, next: { revalidate: 5 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // The leak this rule exists to stop: a session cookie on a revalidated read.
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
    // A bearer token is identity too.
    {
      code: `fetch(url, { headers: { authorization: bearer }, next: { revalidate: 30 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // new Headers({...}) hides nothing.
    {
      code: `fetch(url, { headers: new Headers({ cookie: session }), next: { revalidate: 10 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // credentials: "include" is identity without a header.
    {
      code: `fetch(url, { credentials: "include", next: { revalidate: 10 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // No cache option at all: a framework default is not an opt-out.
    {
      code: `fetch(url, { headers: { cookie: session } });`,
      errors: [{ messageId: "unmarked", data: { header: "cookie" } }],
    },
    {
      code: `fetch(url, { method: "POST", headers: { "x-vizra-session": s } });`,
      errors: [{ messageId: "unmarked" }],
    },
    // A contradiction (no-store AND a revalidate window) is reported, not excused.
    {
      code: `fetch(url, { headers: { cookie: session }, cache: "no-store", next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated" }],
    },
    // Member-expression callee.
    {
      code: `globalThis.fetch(url, { headers: { cookie: session }, next: { revalidate: 60 } });`,
      errors: [{ messageId: "revalidated" }],
    },
  ],
});
