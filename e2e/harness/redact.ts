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
  // Stop at whitespace and at the quote/bracket characters that commonly
  // terminate a URL inside a sentence.
  const absolute = text.replace(/\b(?:https?|wss?|ftp):\/\/[^\s'"<>()[\]]+/g, (match) => redactUrl(match));

  // AND THE SCHEME-LESS FORM, which is how Playwright writes a step subtitle.
  //
  // An independent verifier reduced the gap to three lines against the artifact
  // redactor (PR #3 re-verification, FINDING 13):
  //
  //   "url":"http://host/m.jpg?X-Amz-Sig=SENTINEL&e=60"     -> ?<redacted>   OK
  //   "path":"/m.jpg?X-Amz-Sig=SENTINEL&e=60"               -> ?<redacted>   OK
  //   "subtitle":"host:3219/m.jpg?X-Amz-Sig=SENTINEL&e=60"  -> UNCHANGED     LEAK
  //
  // Playwright drops the scheme when it records a `test.trace` step subtitle, so
  // ANY `page.goto(signedUrl)` produces one. The absolute program above requires
  // `scheme://`; this one accepts an authority (`host` or `host:port`) directly
  // in front of a path, and a path that starts at `/`.
  //
  // The authority is either DOTTED (a hostname or IPv4 literal, port optional)
  // or any label carrying an explicit `:port` — the second alternative is what
  // makes the verifier's own reduction line redact, since `host:3219` has no
  // dot — and a path starting at `/` must follow immediately. Prose such as
  // "see step 3/4?" has no authority and is untouched. The price is deliberate
  // OVER-redaction of a `1:23/foo?x=y`-shaped string, which costs a little
  // diagnostic text and leaks nothing. `scripts/ci/redact-artifacts.sh` carries
  // the same shape for bytes the driver wrote before any harness code saw them.
  const authorityRelative = absolute.replace(
    /(^|[\s'"(<[=,])((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(?::\d{1,5})?|[A-Za-z0-9-]+:\d{1,5}|localhost)(\/[^\s'"<>()[\]?#]*[?#][^\s'"<>()[\]]*)/g,
    (_match, boundary: string, authority: string, rest: string) => `${boundary}${authority}${redactUrl(rest)}`,
  );

  // AND THE PATH-RELATIVE FORM. `scripts/ci/redact-artifacts.sh` has carried a
  // relative program since D9 caught it — a Next application emits relative URLs
  // everywhere, and the trace recorded one as a page call's ARGUMENT with no
  // scheme and no host. This module did not, so the two redactors covered
  // different sets and only one of them was written down. They now carry the
  // same three programs: absolute, authority-relative, path-relative.
  return authorityRelative.replace(
    /(^|[\s'"(<[=,])(\/[A-Za-z0-9._~%/+-]*[?#][^\s'"<>()[\]]*)/g,
    (_match, boundary: string, rest: string) => `${boundary}${redactUrl(rest)}`,
  );
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
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "\uFFFD");

  // A leading `::` is the workflow-command marker. Break it rather than drop
  // it: a reader should still see that the page said something beginning `::`.
  if (out.startsWith("::")) out = `\u200B${out}`;

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
