/**
 * NO SPEC AUTHENTICATES, FILLS A CREDENTIAL, OR TOUCHES A SIGNED URL — yet.
 *
 * WHY THIS EXISTS, AND WHY IT IS TEMPORARY. `scripts/ci/redact-artifacts.sh`
 * covers URL query strings, fragments and `Location`. It does **not** cover
 * `Authorization`, `Cookie`, `Set-Cookie` or vendor token headers (they survive
 * in the trace's `1-trace.network` member), request and response bodies,
 * non-URL tokens in console messages, DOM snapshots, or **Playwright call
 * parameters** — the `page.fill` / `page.evaluate` arguments that a login spec
 * would use, and the channel nobody had named until an independent verifier
 * measured all eleven.
 *
 * Nothing leaks today, for one reason only: **nothing in this repository
 * authenticates.** There is no vizra-core, no session cookie, no signed URL.
 * The traces are safe by accident of scope, not by control. That accident holds
 * only while it is true, so it is asserted here rather than hoped for.
 *
 * WHEN THIS GOES AWAY. The artifact-privacy slice (header, body, DOM and
 * call-parameter redaction) is queued as its own slice. When it lands, this
 * file is deleted or narrowed in the same diff, and the first authenticating
 * spec proves the coverage with `scripts/e2e/sweep-artifacts.sh`, which already
 * does exactly this search. Until then, a spec that authenticates would publish
 * the credential in a 14-day CI artifact the first time its lane went red.
 *
 * This is a source sweep, not a type check: the point is to be impossible to
 * satisfy accidentally, and to name the slice in the failure message so the
 * next author knows what they are waiting for.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Patterns that mean "this spec is handling a credential". Each is a Playwright
 * or HTTP surface that puts a secret into the trace through a channel the
 * redactor does not cover.
 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\baddCookies\s*\(/, what: "setting cookies on the context" },
  { pattern: /\bstorageState\b/, what: "a saved authenticated storage state" },
  { pattern: /\bsetExtraHTTPHeaders\s*\(/, what: "injecting request headers" },
  { pattern: /\bhttpCredentials\b/, what: "HTTP basic credentials" },
  { pattern: /\bAuthorization\b/i, what: "an Authorization header" },
  { pattern: /\bBearer\b/, what: "a bearer token" },
  { pattern: /\bSet-Cookie\b/i, what: "a Set-Cookie header" },
  { pattern: /\bx-amz-security-token\b/i, what: "an AWS session token header" },
  { pattern: /\.fill\s*\(/, what: "filling a form field (the `page.fill` call-parameter channel)" },
  { pattern: /\b(password|passphrase|secret)\b/i, what: "a credential-shaped identifier" },
  { pattern: /X-Amz-Signature|X-Goog-Signature|\bSignature=/i, what: "a signed URL" },
];

/**
 * The one exception, declared the same way the browser-error guard declares
 * its own: per file, per pattern, with a written reason. Nothing is exempt by
 * being in a particular directory.
 */
const ALLOWED: ReadonlyArray<{ file: string; pattern: RegExp; reason: string }> = [
  {
    file: "demos/signed-url-artifact.demo.ts",
    pattern: /SENTINEL-SIGNATURE-DO-NOT-SHIP|X-Amz-Signature/,
    reason:
      "D9's sentinel. It is shaped like a signed URL on purpose and is not one: it is the " +
      "value the artifact-redaction demonstration searches for, and it is redacted by the " +
      "time anything is uploaded. Removing this file would remove the proof.",
  },
];

/**
 * Strip comments before matching.
 *
 * These files document, at length, the very channels they are forbidden to
 * use — the D9 demo's header explains the secret scanner that started all of
 * this, and tripped this guard on the word "secret" in its own prose. A
 * credential written in a comment is never sent to the browser and so cannot
 * reach a trace, which is the channel this guard exists for; a credential in
 * code can. Matching code only keeps the guard about the hazard rather than
 * about vocabulary.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * EVERY `.ts` under `e2e/` except the harness itself — not a hard-coded
 * `["specs", "demos"]`.
 *
 * The list of two directories was a hole an independent verifier walked
 * through: `playwright.config.ts` collected `**​/*.spec.ts` under the whole of
 * `e2e/`, so a spec at `e2e/other/x.spec.ts` ran while this sweep and the ESLint
 * rule both looked elsewhere. The collection root is now `e2e/specs` and the
 * lint glob is `e2e/**` minus the harness; this walk follows the lint glob
 * rather than the collection root, deliberately, so that a file which is not
 * collected today but could be tomorrow is still swept.
 *
 * Every extension is swept, not only `*.spec.ts` / `*.demo.ts`: a helper named
 * `login.ts` beside a spec would put the credential into the trace through the
 * same call-parameter channel as the spec itself.
 *
 * `e2e/harness/**` is excluded for the same reason the lint rule excludes it —
 * it is the guard, `.github/CODEOWNERS` covers it, and it must be able to name
 * the patterns it forbids. That exclusion is a known limit, stated in AGENTS.md:
 * a login helper placed in `e2e/harness/` evades this sweep.
 */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (dir === e2eRoot && entry === "harness") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(entry)) files.push(full);
    }
  };
  walk(e2eRoot);
  return files;
}

describe("no spec authenticates until the artifact-privacy slice lands", () => {
  const files = sourceFiles();

  it("finds the specs at all (an empty sweep would pass vacuously)", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files.map((file) => [path.relative(e2eRoot, file), file]))(
    "%s handles no credential",
    (relative, file) => {
      const source = withoutComments(readFileSync(file, "utf8"));
      // For each forbidden pattern that matches, take the matched TEXT and ask
      // whether an allow-list entry for this file covers that text. An entry
      // exempts the text it names, never the whole file.
      const hits = FORBIDDEN.map(({ pattern, what }) => ({
        what,
        matched: pattern.exec(source)?.[0],
      }))
        .filter((hit): hit is { what: string; matched: string } => hit.matched !== undefined)
        .filter(
          (hit) =>
            !ALLOWED.some(
              (entry) => relative.endsWith(entry.file) && entry.pattern.test(hit.matched),
            ),
        )
        .map((hit) => `${hit.what} — "${hit.matched}"`);

      expect(
        hits,
        `${relative} appears to handle a credential (${hits.join("; ")}).\n` +
          "The artifact redactor covers URL query strings, fragments and Location — NOT " +
          "Authorization/Cookie/Set-Cookie headers, request or response bodies, console " +
          "tokens, DOM snapshots, or Playwright call parameters. A red lane would publish " +
          "the credential in a 14-day CI artifact.\n" +
          "This is not a style rule: wait for the artifact-privacy slice, or land it first. " +
          "See AGENTS.md, 'What the redactor does not cover'.",
      ).toEqual([]);
    },
  );
});
