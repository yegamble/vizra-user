/**
 * URL redaction for everything the harness prints.
 *
 * WHY. The guard copies URLs it observed in the browser into failure messages,
 * into CI logs, and into the transcripts committed under `docs/evidence/`. A
 * URL's QUERY STRING is exactly where a credential lives: a signed media URL
 * (ADR-005 storage capabilities), a password-reset or invite link, a session or
 * CSRF token a page put in a link. The meta `AGENTS.md` is explicit — "never
 * log credentials, private signed URLs, or raw private metadata" — and a test
 * harness is not exempt, because its output is the most widely shared output
 * this repository produces.
 *
 * This was not theoretical. The first run of the dev-server demonstration
 * committed the Next dev server's HMR WebSocket URL — `/_next/hmr?id=<opaque>`
 * — into the evidence transcripts, and the repository's secret scanner flagged
 * it. That particular value was an ephemeral session id and harmless, but the
 * scanner was reading the shape correctly: the harness was copying opaque
 * query-string values out of a page and committing them. The next such value
 * will be a real signed URL from vizra-core. (The flagged string itself is not
 * reproduced anywhere in this repository, including in the tests.)
 *
 * So origin and path survive — they are what makes a failure diagnosable — and
 * everything after `?` or `#` is replaced by a marker that says how many
 * parameters were dropped. Nothing here tries to decide WHICH parameters are
 * sensitive: a list of "safe" parameter names is a list someone forgets to
 * update, and the path alone has always been enough to identify the request.
 */

/** `https://h/p?a=1&b=2#frag` → `https://h/p?<redacted: 2 parameter(s)>`. */
export function redactUrl(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;

  // Fragments never reach a server but do reach a log. Drop them first.
  const [withoutFragment, ...fragmentParts] = raw.split("#");
  const hadFragment = fragmentParts.length > 0;
  const base = withoutFragment ?? raw;

  const queryStart = base.indexOf("?");
  if (queryStart === -1) {
    return hadFragment ? `${base}#<redacted>` : base;
  }

  const path = base.slice(0, queryStart);
  const query = base.slice(queryStart + 1);
  const count = query === "" ? 0 : query.split("&").length;
  const redacted = `${path}?<redacted: ${count} parameter(s)>`;
  return hadFragment ? `${redacted}#<redacted>` : redacted;
}

import sharedPrograms from "./redaction-patterns.json";

/**
 * THE PROGRAMS ARE SHARED, NOT COPIED.
 *
 * This module and `scripts/ci/redact-artifacts.sh` used to carry their own
 * copies of the URL programs, and AGENTS.md said they were "the same four
 * programs". An independent verifier showed they were not (PR #8, R2-FINDING C):
 * a fully slash-escaped `https:\/\/host\/p?sig=…` was redacted here and SURVIVED
 * the shell redactor — the one that touches uploaded bytes — and the
 * double-escaped form Playwright writes when a spec prints a slash-escaped URL
 * survived both, into `results.json` and `trace.zip::test.trace`, after the
 * redactor reported OK.
 *
 * So both now read `./redaction-patterns.json`, and
 * `./redaction-corpus.test.ts` runs BOTH over one corpus and checks every output
 * byte for byte. Each pattern has exactly one capture group — the part that is
 * kept — and what it matches after that (the query and/or fragment) is replaced.
 * Here the replacement says how many parameters were dropped; the shell writes
 * `?<redacted>`. That is the only difference, and the corpus pins both.
 */
/**
 * `<<NAME>>` in a pattern is the fragment of that name, which may use fragments
 * declared above it. `redact-artifacts.sh` expands them the same way; an unknown
 * name throws rather than expanding to nothing.
 */
export function expandFragments(pattern: string, fragments: ReadonlyMap<string, string>): string {
  const expanded = pattern.replace(/<<([A-Za-z0-9_]+)>>/g, (_whole, name: string) => {
    const fragment = fragments.get(name);
    if (fragment === undefined) throw new Error(`redaction-patterns.json: unknown fragment <<${name}>>`);
    return fragment;
  });
  // A placeholder the name pattern did not recognise would otherwise survive as
  // literal regex text and match nothing, silently.
  if (expanded.includes("<<")) throw new Error(`redaction-patterns.json: unexpanded placeholder in ${pattern}`);
  return expanded;
}

const FRAGMENTS: ReadonlyMap<string, string> = sharedPrograms.fragments.reduce(
  (declared: Map<string, string>, fragment: { name: string; pattern: string }) =>
    declared.set(fragment.name, expandFragments(fragment.pattern, declared)),
  new Map<string, string>(),
);

const PROGRAMS: readonly RegExp[] = sharedPrograms.programs.map(
  (program: { pattern: string; flags: string }) =>
    new RegExp(expandFragments(program.pattern, FRAGMENTS), program.flags),
);

/**
 * An ENCODED query separator at the start of what a program matched — `\u003f`,
 * `\x3F`, `%3F` (R3-FINDING I). `redactUrl` splits on a literal `?`, so the
 * separator is normalised to one first; without this the harness would match the
 * URL and then hand the query back unchanged.
 */
const ENCODED_QUERY_SEPARATOR = new RegExp(`^${FRAGMENTS.get("QSEP_ENCODED") ?? "(?!)"}`);

/**
 * Redact every URL-looking substring inside a free-text message.
 *
 * Console messages and browser error strings embed URLs mid-sentence
 * ("WebSocket connection to 'ws://…?id=…' failed"), so redacting only the
 * fields the harness assembles itself would leave the query string in the text
 * the browser handed us.
 */
export function redactUrlsInText(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const program of PROGRAMS) {
    out = out.replace(program, (match: string, keep: string) => {
      const rest = match.slice(keep.length);
      const encoded = ENCODED_QUERY_SEPARATOR.exec(rest);
      return `${keep}${redactUrl(encoded ? `?${rest.slice(encoded[0].length)}` : rest)}`;
    });
  }
  return out;
}

/**
 * Make a string that came from OUTSIDE this repository inert before it is
 * printed or attached — the security seat's FINDING 13.
 *
 * WHY. `describeConsole` copies `message.text()` — text the PAGE controls —
 * into a Playwright failure message, which the `list` reporter writes to stdout,
 * which is the GitHub Actions log. GitHub interprets `::workflow-command::`
 * sequences at the start of a line in step output, so page text containing a
 * newline followed by `::add-mask::`, `::stop-commands::<token>` or
 * `::error file=…::` manipulates the run's own log and annotations.
 *
 * And the content half matters more than the injection half: from M1 this text
 * is product content, and from federation it is a remote instance's
 * attacker-controlled display name, caption or error string. This harness would
 * otherwise be the first place Vizra prints remote content into a durable log
 * that every collaborator on this private repository can read.
 *
 * What it does, and nothing more: collapse CR and LF so a workflow command
 * cannot start a line, neutralise a leading `::`, escape the percent-encoded
 * spellings GitHub also accepts (`%0A`, `%0D`, `%25`), and cap the length. It is
 * NOT a credential filter — `redactUrlsInText` is the URL half and the real
 * control for credentials is that nothing authenticates in this lane.
 */
const EXTERNAL_TEXT_LIMIT = 200;

export function sanitiseExternalText(text: string): string {
  if (typeof text !== "string" || text === "") return text;

  let out = text
    // `%25` first, or escaping the others would be re-escaped by this one.
    .replace(/%25/gi, "%2525")
    .replace(/%0A/gi, "%250A")
    .replace(/%0D/gi, "%250D")
    // A real newline or carriage return would let the rest of the string start
    // a line, which is what makes a workflow command a workflow command.
    .replace(/\r\n|\r|\n/g, "\u23CE")
    // Other C0 controls (a bare ESC can rewrite a terminal transcript).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "\uFFFD");

  // A leading `::` is the workflow-command marker. Break it rather than drop
  // it: a reader should still see that the page said something beginning `::`.
  // A leading `::` is the workflow-command marker, and GitHub tolerates leading
  // WHITESPACE before it - a verifier found `"  ::error::"` and a tab-prefixed
  // form unescaped by the first version. Rather than guess how much whitespace
  // GitHub trims, refuse `::` after ANY run of leading whitespace. Broken rather
  // than dropped: a reader should still see that the page said something
  // beginning `::`.
  out = out.replace(/^(\s*)::/, `$1\u200B::`);

  if (out.length > EXTERNAL_TEXT_LIMIT) {
    out = `${out.slice(0, EXTERNAL_TEXT_LIMIT)}… (${out.length - EXTERNAL_TEXT_LIMIT} more character(s) dropped)`;
  }
  return out;
}

/**
 * The two together, in the order they must be applied: redact URLs first (so the
 * URL matcher sees the text the browser actually produced), then make what is
 * left inert. Every externally-sourced string the harness prints goes through
 * this one function, so there is one place to read and one place to change.
 */
export function redactExternalText(text: string): string {
  return sanitiseExternalText(redactUrlsInText(text));
}
