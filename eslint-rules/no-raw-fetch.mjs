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
 *
 * THE COMPUTED SPELLING. The first version of the alias ban returned on any
 * `node.computed`, so an independent verifier walked straight through it:
 *
 *     globalThis["fetch"](url, { headers: { cookie }, next: { revalidate: 60 } });
 *     window["fetch"](url, …);   globalThis[`fetch`](url, …);
 *     const g = globalThis["fetch"];  g(url, …);
 *
 * ZERO messages, from either rule — the same shared-cache leak as the alias
 * hole, in a different spelling. A computed key that the rule can READ (a
 * string literal, or a template literal with no expressions) is now treated
 * exactly as the dotted spelling.
 *
 * A key it CANNOT read — `globalThis[name]`, `globalThis[`fet${x}`]` — is
 * reported as `dynamicGlobalMember` rather than waved through. This is the
 * deliberate fail-closed choice the sibling rule already makes for an init it
 * cannot read: the rule cannot rule out `fetch`, and nothing in this repository
 * has any reason to index the global object by a computed name. Ordinary
 * computed access on any OTHER object (`client["fetch"]`, `registry[name]`,
 * `rows[0]`) is untouched — the object must be `globalThis` or `window`.
 *
 * LIMITS, so the docblock does not over-claim: a global reached through a
 * further indirection the rule cannot follow (`const gt = globalThis;
 * gt["fetch"]`, a `Proxy`, `eval`) is not caught, and no syntactic rule ever
 * terminates. The runtime assertions in `lib/api/fetch.test.ts` and Next's own
 * cache-scope throw are the layers that do not depend on spelling.
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

/** A computed key whose value this rule cannot determine at lint time. */
const UNREADABLE = Symbol("unreadable property key");

/**
 * The property name a member expression or object-pattern property names, or
 * `UNREADABLE` when the key is computed from something the rule cannot read.
 *
 * `a.fetch` and `a["fetch"]` and ``a[`fetch`]`` all yield `"fetch"`. A template
 * literal with any substitution, or any other computed expression, is
 * `UNREADABLE` — the caller decides what to do with that, and here it fails
 * closed.
 */
function propertyKey(keyNode, computed) {
  if (!computed) {
    if (keyNode.type === "Identifier") return keyNode.name;
    if (keyNode.type === "Literal") return keyNode.value;
    return UNREADABLE;
  }
  if (keyNode.type === "Literal") return keyNode.value;
  if (keyNode.type === "TemplateLiteral" && keyNode.expressions.length === 0) {
    return keyNode.quasis.map((q) => q.value.cooked).join("");
  }
  return UNREADABLE;
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
      dynamicGlobalMember:
        "Do not index the global object by a computed name: this rule cannot read the key, so it cannot rule out `fetch`, and it fails closed rather than assuming. Name the property directly, or use publicFetch / viewerFetch (ADR-003).",
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

      // `globalThis.fetch` / `globalThis["fetch"]` / `window[`fetch`]` — as a
      // call, or as a value. A computed key the rule cannot read is reported
      // rather than skipped.
      MemberExpression(node) {
        if (node.object.type !== "Identifier") return;
        if (node.object.name !== "globalThis" && node.object.name !== "window") return;
        if (isLocalBinding(sourceCode.getScope(node), node.object.name)) return;

        const key = propertyKey(node.property, node.computed);
        if (key === UNREADABLE) {
          context.report({ node, messageId: "dynamicGlobalMember" });
          return;
        }
        if (key !== "fetch") return;

        const parent = node.parent;
        if (parent && parent.type === "CallExpression" && parent.callee === node) {
          reportCall(parent);
          return;
        }
        context.report({ node, messageId: "aliasedFetch" });
      },

      // `const { fetch } = globalThis` / `const { ["fetch"]: alias } = window`.
      VariableDeclarator(node) {
        if (!node.init || node.init.type !== "Identifier") return;
        if (node.init.name !== "globalThis" && node.init.name !== "window") return;
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type !== "Property") continue;
          const key = propertyKey(property.key, property.computed);
          if (key === UNREADABLE) {
            context.report({ node: property, messageId: "dynamicGlobalMember" });
          } else if (key === "fetch") {
            context.report({ node: property, messageId: "aliasedFetch" });
          }
        }
      },
    };
  },
};

export default rule;
