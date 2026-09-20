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
    // The one module allowed to call global fetch.
    {
      code: `const res = await fetch(url, { cache: "no-store" });`,
      filename: "lib/api/fetch.ts",
    },
    // An explicit allow list entry.
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
    // A method named fetch on some object is not global fetch.
    { code: `client.fetch(url);`, filename: "app/page.tsx" },
  ],
  invalid: [
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
  ],
});
