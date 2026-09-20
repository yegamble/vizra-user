/**
 * Vizra's own ESLint rules. Local to this repository on purpose: they encode
 * ADR-003's SSR identity rules, which no published plugin knows about.
 */

import noIdentityHeadersInCachedFetch from "./no-identity-headers-in-cached-fetch.mjs";
import noRawFetch from "./no-raw-fetch.mjs";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: { name: "vizra", version: "1.0.0" },
  rules: {
    "no-identity-headers-in-cached-fetch": noIdentityHeadersInCachedFetch,
    "no-raw-fetch": noRawFetch,
  },
};

export default plugin;
