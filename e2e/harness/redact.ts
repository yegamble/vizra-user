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
  return text.replace(/\b(?:https?|wss?|ftp):\/\/[^\s'"<>()[\]]+/g, (match) => redactUrl(match));
}
