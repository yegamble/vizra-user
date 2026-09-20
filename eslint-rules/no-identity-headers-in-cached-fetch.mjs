/**
 * ESLint rule: a `fetch()` that carries viewer identity must be explicitly
 * uncached — and a `fetch()` this rule cannot read is an error, not a pass.
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
 * FAIL CLOSED. Two independent reviewers broke the first version of this rule
 * the same way: it returned silently whenever the call was not spelled the way
 * it expected — the init object hoisted into a variable, headers spread from a
 * function, `Object.assign`, a computed key, `new Headers().set()`. Each was a
 * plausible refactor of `lib/api/fetch.ts`, the one file where `no-raw-fetch`
 * is allow-listed off and this rule is therefore the only lint control. So the
 * rule no longer decides between "identity" and "no identity". It decides
 * between "I read this call and it is safe" and "report it":
 *
 *   - second argument present and not an object literal          → `unreadable`
 *   - a property of that object with a key it cannot read        → `unreadable`
 *   - a spread element in that object                            → `unreadable`
 *   - `headers` it cannot resolve to an object literal — a call,
 *     a parameter, a reassigned binding, a `new Headers(x)` with a
 *     non-literal argument, or a binding that escapes into another
 *     expression (passed to `Object.assign`, spread, aliased)    → `unreadable`
 *   - a header key it cannot read statically                     → `unreadable`
 *   - identity present and the call is cached or unmarked        → `revalidated` / `unmarked`
 *
 * `fetch(url)` with no init stays valid: there is nothing to read and nothing
 * to send. The cost of failing closed is that a legitimate dynamic call has to
 * be written as a literal at the call site, or go through the helpers. That is
 * the intended trade.
 *
 * WHAT REMAINS UNREPORTED, PLAINLY. Within a call this rule CAN read, it still
 * only knows the header names it is told about: `IDENTITY_HEADERS` below plus
 * `credentials: "include"`. A future credential carried in a header name not on
 * that list, or a value whose identity is not visible in its key, is not
 * detected. It also judges one call at a time: a wrapper that takes the cache
 * posture as a parameter and is called with identity elsewhere is out of reach
 * of any syntactic rule.
 *
 * This is why the rule is not the control on its own, and the docblock no
 * longer claims it is:
 *   - `no-raw-fetch.mjs` bans global `fetch` outside `lib/api/fetch.ts` AND
 *     bans aliasing the `fetch` binding in every file, including that one;
 *   - `lib/api/fetch.test.ts` asserts the runtime property directly — over
 *     every method/body/upload combination, `viewerFetch`'s init has
 *     `cache: "no-store"` and no `next`, and `cookies()` is consulted on every
 *     path, which is what keeps Next's own cache-scope error armed.
 * A syntactic rule is the cheapest layer, not the last one.
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

/** First property of an object literal that cannot be read statically, or null. */
function unreadablePart(objectExpression) {
  for (const property of objectExpression.properties) {
    if (property.type === "SpreadElement") return property;
    if (staticKey(property) === null) return property;
  }
  return null;
}

/** The object literal holding header entries, whether written directly or as `new Headers({...})`. */
function headersLiteral(value) {
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

/** First identity-named key in an object literal of headers, or null. */
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
 * Is this reference to a headers binding one we can account for?
 *
 * Accounted for: its own initializer, a member expression on it
 * (`headers.cookie`, read or written), and being handed to a fetch as the
 * `headers` option. Anything else — passed to a function, spread into another
 * object, aliased to a second name — means the object can be changed somewhere
 * this rule is not looking, so the call is `unreadable`.
 */
function accountedFor(reference) {
  if (reference.init) return true;
  const identifier = reference.identifier;
  const parent = identifier.parent;
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.object === identifier) return true;
  if (parent.type === "Property" && !parent.computed) {
    const key = staticKey(parent);
    const isValue = parent.shorthand || parent.value === identifier;
    if (isValue && key !== null && key.toLowerCase() === "headers") return true;
  }
  return false;
}

/**
 * Read a headers binding. Returns `{ identity }` (identity may be null) when
 * the binding could be read in full, or `{ unreadable: node }`.
 */
function readHeadersVariable(variable, at) {
  const defs = variable.defs;
  if (defs.length !== 1) return { unreadable: at };

  const def = defs[0];
  if (def.node.type !== "VariableDeclarator" || !def.node.init) return { unreadable: at };

  const literal = headersLiteral(def.node.init);
  if (!literal) return { unreadable: at };

  const opaque = unreadablePart(literal);
  if (opaque) return { unreadable: opaque };

  let identity = identityKeyIn(literal);

  for (const reference of variable.references) {
    if (!accountedFor(reference)) return { unreadable: reference.identifier };

    const identifier = reference.identifier;
    const member = identifier.parent;
    if (!member || member.type !== "MemberExpression" || member.object !== identifier) {
      continue;
    }
    let key = null;
    if (member.computed) {
      if (member.property.type === "Literal" && typeof member.property.value === "string") {
        key = member.property.value;
      } else {
        // headers[someExpression] = … — the name is not knowable here.
        return { unreadable: member };
      }
    } else if (member.property.type === "Identifier") {
      key = member.property.name;
    }
    if (key === null || !IDENTITY_HEADERS.has(key.toLowerCase())) continue;

    const assignment = member.parent;
    if (assignment && assignment.type === "AssignmentExpression" && assignment.left === member) {
      identity = identity ?? { node: assignment, header: key };
    }
  }

  return { identity };
}

/**
 * Identity carried by this options object. Returns `{ identity }` (possibly
 * null) or `{ unreadable: node }`.
 */
function readIdentity(options, scope) {
  const opaque = unreadablePart(options);
  if (opaque) return { unreadable: opaque };

  const credentials = findProperty(options, "credentials");
  if (credentials) {
    if (credentials.value.type !== "Literal") return { unreadable: credentials };
    if (credentials.value.value === "include") {
      return { identity: { node: credentials, header: 'credentials: "include"' } };
    }
  }

  const headers = findProperty(options, "headers");
  if (!headers) return { identity: null };

  const literal = headersLiteral(headers.value);
  if (literal) {
    const opaqueHeader = unreadablePart(literal);
    if (opaqueHeader) return { unreadable: opaqueHeader };
    return { identity: identityKeyIn(literal) };
  }

  const value = headers.shorthand ? headers.key : headers.value;
  if (value.type === "Identifier" && scope) {
    const variable = lookup(scope, value.name);
    if (!variable) return { unreadable: headers };
    return readHeadersVariable(variable, headers);
  }

  return { unreadable: headers };
}

/**
 * How this call is cached: "no-store" (explicitly uncached), "revalidated"
 * (an explicit cache/revalidate that is not no-store) or "unmarked".
 */
function cachePosture(options) {
  const cache = findProperty(options, "cache");
  const next = findProperty(options, "next");
  const revalidate =
    next && next.value.type === "ObjectExpression"
      ? findProperty(next.value, "revalidate")
      : null;

  const explicitNoStore =
    cache && cache.value.type === "Literal" && cache.value.value === "no-store";
  const explicitZeroRevalidate =
    revalidate && revalidate.value.type === "Literal" && revalidate.value.value === 0;

  // An explicit revalidate window alongside no-store is a contradiction; treat
  // the caching half as the answer so it is reported rather than excused.
  if (revalidate && !explicitZeroRevalidate) {
    return { posture: "revalidated", node: revalidate };
  }
  if (explicitNoStore || explicitZeroRevalidate) return { posture: "no-store", node: null };
  if (cache || next) return { posture: "revalidated", node: cache ?? next };
  return { posture: "unmarked", node: null };
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "forbid identity headers (cookie/authorization) on a cached or revalidated fetch, and report any fetch init this rule cannot read",
      recommended: true,
    },
    schema: [],
    messages: {
      revalidated:
        'This fetch sends "{{header}}" and is cached or revalidated. A shared cache entry built from one viewer\'s credentials is served to other viewers (ADR-003). Use viewerFetch, or set cache: "no-store".',
      unmarked:
        'This fetch sends "{{header}}" without an explicit cache: "no-store". An identified request must opt out of the data cache at the call site (ADR-003), not rely on a framework default.',
      unreadable:
        'This rule cannot read this fetch, so it cannot prove the request carries no identity on a cached read — and it fails closed (ADR-003). Write the init and its headers as object literals at the call site, or call publicFetch / viewerFetch from lib/api/fetch.ts.',
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
        // `fetch(url)` sends nothing of ours: nothing to read, nothing to report.
        if (!options) return;
        calls.push({ node, options, scope: sourceCode.getScope(node) });
      },

      "Program:exit"() {
        for (const call of calls) {
          if (call.options.type !== "ObjectExpression") {
            context.report({ node: call.options, messageId: "unreadable" });
            continue;
          }

          const read = readIdentity(call.options, call.scope);
          if (read.unreadable) {
            context.report({ node: read.unreadable, messageId: "unreadable" });
            continue;
          }
          if (!read.identity) continue;

          const { posture, node: cacheNode } = cachePosture(call.options);
          if (posture === "no-store") continue;

          context.report({
            node: posture === "revalidated" && cacheNode ? cacheNode : read.identity.node,
            messageId: posture === "revalidated" ? "revalidated" : "unmarked",
            data: { header: read.identity.header },
          });
        }
      },
    };
  },
};

export default rule;
