/**
 * ESLint rule: a `fetch()` that carries viewer identity must be explicitly
 * uncached.
 *
 * ADR-003 ("SSR identity"): "`viewerFetch` … always sets `cache: 'no-store'`
 * and is never called inside a revalidated cache. A lint rule forbids identity
 * headers in revalidated fetches."
 *
 * WHY THIS IS A PRIVACY CONTROL, NOT A STYLE RULE. The Next.js data cache is
 * shared across requests and, in a multi-instance deployment, across viewers.
 * A `fetch` that sends a session cookie and is served from — or written into —
 * that cache hands one viewer's private response to the next visitor who asks
 * for the same URL. That is the private-media leak AGENTS.md's default-deny
 * section exists to prevent, and it produces no error, no log line and no
 * failing test: the page just renders, with someone else's data in it.
 *
 * WHAT COUNTS AS IDENTITY: a `cookie`, `authorization`, `proxy-authorization`
 * or `x-vizra-session` header (any casing), or `credentials: "include"`.
 *
 * WHAT COUNTS AS CACHED: anything that is not an explicit opt-out. The rule
 * demands `cache: "no-store"` (or the equivalent `next: { revalidate: 0 }`)
 * rather than merely rejecting `force-cache`, because caching posture varies
 * by framework version and by route segment config — "I did not write a cache
 * option" is not a guarantee of an uncached request, while `no-store` is.
 *
 * HEADERS IN A VARIABLE ARE JUDGED TOO. Real code rarely writes the headers
 * inline; `viewerFetch` builds a `Record<string, string>` and adds the cookie
 * conditionally. An earlier version of this rule only read object literals at
 * the call site, and a controlled mutation proved it: weakening `viewerFetch`
 * itself from `cache: "no-store"` to `next: { revalidate: 60 }` produced NO
 * lint error, because the headers arrived by name. So the rule now resolves an
 * identifier through scope and inspects both the variable's initializer and
 * every `headers.cookie = …` / `headers["cookie"] = …` write to it.
 *
 * LIMITS, STATED PLAINLY. It is still syntax, not type inference: headers
 * spread from a function call (`...identityHeaders()`), assembled through a
 * `Headers` object's `.set()`, or reached through a second alias are not
 * judged. That is why `no-raw-fetch.mjs` keeps every module except
 * `lib/api/fetch.ts` out of global `fetch` in the first place, and why
 * `lib/api/fetch.test.ts` asserts the helpers' behaviour directly. The three
 * are meant to be used together; none of them alone is the control.
 */

const IDENTITY_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-vizra-session",
]);

/** Static key of an object property, or null when it cannot be read statically. */
function staticKey(property) {
  if (property.type !== "Property" || property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return null;
}

function findProperty(objectExpression, name) {
  if (!objectExpression || objectExpression.type !== "ObjectExpression") return null;
  let found = null;
  for (const property of objectExpression.properties) {
    const key = staticKey(property);
    if (key !== null && key.toLowerCase() === name) found = property; // last wins, as in JS
  }
  return found;
}

/** The object literal holding header entries, whether written directly or as `new Headers({...})`. */
function headersObject(value) {
  if (!value) return null;
  if (value.type === "ObjectExpression") return value;
  if (
    value.type === "NewExpression" &&
    value.callee.type === "Identifier" &&
    value.callee.name === "Headers" &&
    value.arguments.length > 0 &&
    value.arguments[0].type === "ObjectExpression"
  ) {
    return value.arguments[0];
  }
  return null;
}

/** The first identity-named key in an object literal of headers, or null. */
function identityKeyIn(object) {
  for (const property of object.properties) {
    const key = staticKey(property);
    if (key !== null && IDENTITY_HEADERS.has(key.toLowerCase())) {
      return { node: property, header: key };
    }
  }
  return null;
}

/** Resolve an identifier to its variable, innermost scope outwards. */
function lookup(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) return variable;
  }
  return null;
}

/**
 * Identity carried by a headers object held in a variable: either present in
 * its initializer, or written onto it later (`headers.cookie = …`).
 */
function identityInVariable(variable) {
  for (const def of variable.defs) {
    if (def.node.type === "VariableDeclarator" && def.node.init) {
      const object = headersObject(def.node.init);
      const hit = object ? identityKeyIn(object) : null;
      if (hit) return hit;
    }
  }
  for (const reference of variable.references) {
    const identifier = reference.identifier;
    const member = identifier.parent;
    if (!member || member.type !== "MemberExpression" || member.object !== identifier) {
      continue;
    }
    let key = null;
    if (member.computed) {
      if (member.property.type === "Literal" && typeof member.property.value === "string") {
        key = member.property.value;
      }
    } else if (member.property.type === "Identifier") {
      key = member.property.name;
    }
    if (key === null || !IDENTITY_HEADERS.has(key.toLowerCase())) continue;
    const assignment = member.parent;
    if (assignment && assignment.type === "AssignmentExpression" && assignment.left === member) {
      return { node: assignment, header: key };
    }
  }
  return null;
}

/** The identity-bearing node for this options object, or null. */
function identityNode(options, scope) {
  const credentials = findProperty(options, "credentials");
  if (
    credentials &&
    credentials.value.type === "Literal" &&
    credentials.value.value === "include"
  ) {
    return { node: credentials, header: 'credentials: "include"' };
  }

  const headers = findProperty(options, "headers");
  if (!headers) return null;

  const object = headersObject(headers.value);
  if (object) return identityKeyIn(object);

  // `headers,` (shorthand) or `headers: someVariable` — follow it.
  const value = headers.shorthand ? headers.key : headers.value;
  if (value.type === "Identifier" && scope) {
    const variable = lookup(scope, value.name);
    if (variable) {
      const hit = identityInVariable(variable);
      if (hit) return { node: hit.node, header: hit.header };
    }
  }
  return null;
}

/**
 * How this call is cached: "no-store" (explicitly uncached), "revalidated"
 * (an explicit cache/revalidate that is not no-store) or "unmarked".
 */
function cachePosture(options) {
  const cache = findProperty(options, "cache");
  const next = findProperty(options, "next");
  const revalidate = next ? findProperty(next.value, "revalidate") : null;

  const explicitNoStore =
    cache &&
    cache.value.type === "Literal" &&
    cache.value.value === "no-store";
  const explicitZeroRevalidate =
    revalidate &&
    revalidate.value.type === "Literal" &&
    revalidate.value.value === 0;

  // An explicit revalidate window alongside no-store is a contradiction; treat
  // the caching half as the answer so it is reported rather than excused.
  if (revalidate && !explicitZeroRevalidate) {
    return { posture: "revalidated", node: revalidate };
  }
  if (explicitNoStore || explicitZeroRevalidate) return { posture: "no-store", node: null };
  if (cache) return { posture: "revalidated", node: cache };
  return { posture: "unmarked", node: null };
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "forbid identity headers (cookie/authorization) on a cached or revalidated fetch",
      recommended: true,
    },
    schema: [],
    messages: {
      revalidated:
        'This fetch sends "{{header}}" and is cached or revalidated. A shared cache entry built from one viewer\'s credentials is served to other viewers (ADR-003). Use viewerFetch, or set cache: "no-store".',
      unmarked:
        'This fetch sends "{{header}}" without an explicit cache: "no-store". An identified request must opt out of the data cache at the call site (ADR-003), not rely on a framework default.',
    },
  },
  create(context) {
    // Calls are collected during traversal and judged at Program:exit, so that
    // every node's `parent` is set and scope analysis can follow a headers
    // variable whose later assignments appear after the fetch call.
    const calls = [];
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        const callee = node.callee;
        const isFetch =
          (callee.type === "Identifier" && callee.name === "fetch") ||
          (callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier" &&
            callee.property.name === "fetch");
        if (!isFetch) return;

        const options = node.arguments[1];
        if (!options || options.type !== "ObjectExpression") return;
        calls.push({ node, options, scope: sourceCode.getScope(node) });
      },

      "Program:exit"() {
        for (const call of calls) {
          const identity = identityNode(call.options, call.scope);
          if (!identity) continue;

          const { posture, node: cacheNode } = cachePosture(call.options);
          if (posture === "no-store") continue;

          context.report({
            node: posture === "revalidated" && cacheNode ? cacheNode : identity.node,
            messageId: posture === "revalidated" ? "revalidated" : "unmarked",
            data: { header: identity.header },
          });
        }
      },
    };
  },
};

export default rule;
