import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-raw-fetch.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("no-raw-fetch", rule, {
  valid: [
    // The one file allowed to CALL global fetch.
    {
      code: `const res = await fetch(url, { cache: "no-store" });`,
      filename: "lib/api/fetch.ts",
    },
    { code: `fetch(url);`, filename: "lib/api/fetch.ts" },
    // An explicit allow-list entry.
    {
      code: `fetch(url);`,
      filename: "lib/other.ts",
      options: [{ allow: ["lib/other.ts"] }],
    },
    // Calling the helpers is the point of the rule.
    {
      code: `const r = await publicFetch("/api/v1/instance", { freshness: "no-store" });`,
      filename: "app/page.tsx",
    },
    // A method named fetch on some other object is not the global.
    { code: `client.fetch(url);`, filename: "app/page.tsx" },
    { code: `const q = { fetch: client.get };`, filename: "app/page.tsx" },
    // A LOCAL binding named fetch is not the global binding.
    {
      code: `function run(fetch) { return fetch(url); }`,
      filename: "app/page.tsx",
    },
    {
      code: `import { fetch } from "./shim";\nfetch(url);`,
      filename: "lib/api/fetch.ts",
    },
    // Tests stub the global by NAME — a string, not a reference.
    {
      code: `vi.stubGlobal("fetch", fetchMock);`,
      filename: "lib/api/fetch.test.ts",
    },
  ],
  invalid: [
    // --- direct calls outside the allow-list ---------------------------------
    {
      code: `const res = await fetch("/api/v1/images");`,
      filename: "app/search/page.tsx",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: `globalThis.fetch(url, { cache: "no-store" });`,
      filename: "lib/whatever.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: `window.fetch(url);`,
      filename: "components/thing.tsx",
      errors: [{ messageId: "rawFetch" }],
    },

    // --- the alias ban: an error in EVERY file, allow-listed or not ----------
    // A reviewer showed both of these escaping BOTH rules: not a call whose
    // callee is `fetch`, so no-raw-fetch was silent, and not a recognised
    // fetch, so the identity rule never looked. A session cookie could ride a
    // revalidated request with a clean lint run.
    {
      code: `const alias = fetch;\nalias(url, { headers: { cookie }, next: { revalidate: 60 } });`,
      filename: "app/probe/page.tsx",
      errors: [{ messageId: "aliasedFetch" }],
    },
    {
      code: `const { fetch: destructured } = globalThis;\ndestructured(url, {});`,
      filename: "app/probe/page.tsx",
      errors: [{ messageId: "aliasedFetch" }],
    },
    {
      code: `const { fetch } = globalThis;`,
      filename: "app/probe/page.tsx",
      errors: [{ messageId: "aliasedFetch" }],
    },
    // Including inside the file whose direct calls ARE allowed: the allow-list
    // exempts calling, never rebinding.
    {
      code: `const alias = fetch;\nalias(url, {});`,
      filename: "lib/api/fetch.ts",
      errors: [{ messageId: "aliasedFetch" }],
    },
    {
      code: `const g = globalThis.fetch;`,
      filename: "lib/api/fetch.ts",
      errors: [{ messageId: "aliasedFetch" }],
    },
    // Passing the global as a value is the same escape by another route.
    {
      code: `wrap(fetch);`,
      filename: "lib/api/fetch.ts",
      errors: [{ messageId: "aliasedFetch" }],
    },
    {
      code: `export default fetch;`,
      filename: "lib/api/fetch.ts",
      errors: [{ messageId: "aliasedFetch" }],
    },
  ],
});
