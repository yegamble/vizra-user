/**
 * ESLint rule: only `lib/api/fetch.ts` may CALL global `fetch`, and no file may
 * ALIAS it.
 *
 * Every other module reaches vizra-core through `publicFetch` or `viewerFetch`
 * (ADR-003: "`vizra-user` has exactly two fetch helpers"). Two reasons this is
 * a rule and not a convention:
 *
 *  1. The identity/caching guarantees live in those helpers. A page that calls
 *     `fetch` directly re-opens every question they already answered — cookie
 *     forwarding, cache posture, CSRF `Origin`, deadlines.
 *  2. It is the seam where mock data gets in. A component that fetches its own
 *     JSON from somewhere is exactly how a page ends up rendering something
 *     that never came from the API.
 *
 * THE ALIAS BAN, AND WHY IT APPLIES EVERYWHERE. An independent reviewer showed
 * that both of these produced no error at all:
 *
 *     const alias = fetch;                       alias(url, { … });
 *     const { fetch: destructured } = globalThis; destructured(url, { … });
 *
 * Neither is a call whose callee is `fetch`, so this rule stayed silent, and
 * `no-identity-headers-in-cached-fetch` only inspects calls it recognises as
 * fetches — so a session cookie could ride a revalidated request with a clean
 * lint run. Rebinding the global is therefore an error in EVERY file,
 * `lib/api/fetch.ts` included: the `allow` option exempts a file from the
 * direct-call ban only, never from the alias ban. Nothing legitimate in this
 * repository needs `fetch` as a value; tests stub it by name
 * (`vi.stubGlobal("fetch", …)`), which is a string, not a reference.
 *
 * A local binding that happens to be named `fetch` (a parameter, an import) is
 * not the global and is left alone.
 */

import path from "node:path";

/** Does this identifier resolve to a local binding rather than the global? */
function isLocalBinding(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) return variable.defs.length > 0 && current.type !== "global";
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "route all vizra-core access through publicFetch/viewerFetch instead of global fetch, and never alias the global fetch binding",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawFetch:
        "Call publicFetch or viewerFetch from lib/api/fetch.ts instead of global fetch: they carry the identity, cache and CSRF rules of ADR-003, and keep pages from inventing their own data source.",
      aliasedFetch:
        "Do not bind global fetch to another name. An aliased fetch is invisible to the identity/caching lint rule, so a session cookie could ride a revalidated request with a clean lint run (ADR-003). Call it directly inside lib/api/fetch.ts, or use publicFetch / viewerFetch.",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? ["lib/api/fetch.ts"];
    const filename = context.filename ?? context.getFilename();
    const relative = path
      .relative(context.cwd ?? process.cwd(), filename)
      .split(path.sep)
      .join("/");
    const callsAllowed = allow.includes(relative);
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** Report a direct call, unless this file is allowed to make them. */
    const reportCall = (node) => {
      if (!callsAllowed) context.report({ node, messageId: "rawFetch" });
    };

    return {
      // Bare `fetch` — as a call, or as a value.
      Identifier(node) {
        if (node.name !== "fetch") return;
        const parent = node.parent;
        if (!parent) return;

        // `x.fetch` / `{ fetch: … }` keys are handled by their own visitors below.
        if (parent.type === "MemberExpression" && parent.property === node) return;
        if (parent.type === "Property" && parent.key === node && !parent.computed) {
          // `{ fetch: value }` in an object literal is a key, not a reference.
          // `const { fetch: alias } = globalThis` is handled by ObjectPattern below.
          return;
        }
        if (parent.type === "VariableDeclarator" && parent.id === node) return; // `const fetch = …`
        if (isLocalBinding(sourceCode.getScope(node), "fetch")) return;

        if (parent.type === "CallExpression" && parent.callee === node) {
          reportCall(parent);
          return;
        }
        context.report({ node, messageId: "aliasedFetch" });
      },

      // `globalThis.fetch` / `window.fetch` — as a call, or as a value.
      MemberExpression(node) {
        if (node.computed) return;
        if (node.property.type !== "Identifier" || node.property.name !== "fetch") return;
        if (node.object.type !== "Identifier") return;
        if (node.object.name !== "globalThis" && node.object.name !== "window") return;

        const parent = node.parent;
        if (parent && parent.type === "CallExpression" && parent.callee === node) {
          reportCall(parent);
          return;
        }
        context.report({ node, messageId: "aliasedFetch" });
      },

      // `const { fetch } = globalThis` / `const { fetch: alias } = window`.
      VariableDeclarator(node) {
        if (!node.init || node.init.type !== "Identifier") return;
        if (node.init.name !== "globalThis" && node.init.name !== "window") return;
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const key =
            property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal"
                ? property.key.value
                : null;
          if (key === "fetch") context.report({ node: property, messageId: "aliasedFetch" });
        }
      },
    };
  },
};

export default rule;
