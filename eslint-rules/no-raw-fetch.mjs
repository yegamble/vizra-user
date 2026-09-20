/**
 * ESLint rule: only `lib/api/fetch.ts` may call global `fetch`.
 *
 * Every other module reaches vizra-core through `publicFetch` or `viewerFetch`
 * (ADR-003: "`vizra-user` has exactly two fetch helpers"). Two reasons this is
 * a rule and not a convention:
 *
 *  1. The identity/caching guarantees live in those helpers. A page that calls
 *     `fetch` directly re-opens every question they already answered — cookie
 *     forwarding, cache posture, CSRF `Origin`, timeouts — and
 *     `no-identity-headers-in-cached-fetch.mjs` can only judge call sites whose
 *     options it can read syntactically.
 *  2. It is the seam where mock data gets in. A component that fetches its own
 *     JSON from somewhere is exactly how a page ends up rendering something
 *     that never came from the API.
 *
 * The allowed file is configured (default `lib/api/fetch.ts`) so the rule has
 * no hidden knowledge of the layout.
 */

import path from "node:path";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "route all vizra-core access through publicFetch/viewerFetch instead of global fetch",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawFetch:
        "Call publicFetch or viewerFetch from lib/api/fetch.ts instead of global fetch: they carry the identity, cache and CSRF rules of ADR-003, and keep pages from inventing their own data source.",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? ["lib/api/fetch.ts"];
    const filename = context.filename ?? context.getFilename();
    const relative = path
      .relative(context.cwd ?? process.cwd(), filename)
      .split(path.sep)
      .join("/");
    if (allow.includes(relative)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        const isFetch =
          (callee.type === "Identifier" && callee.name === "fetch") ||
          (callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            (callee.object.name === "globalThis" || callee.object.name === "window") &&
            callee.property.type === "Identifier" &&
            callee.property.name === "fetch");
        if (isFetch) context.report({ node, messageId: "rawFetch" });
      },
    };
  },
};

export default rule;
