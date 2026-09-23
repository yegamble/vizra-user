/**
 * The redactor keeps what makes a failure diagnosable and drops what makes a
 * transcript a credential leak. See `redact.ts` for why a test harness is
 * exactly where a signed URL escapes into a log.
 */

import { describe, expect, it } from "vitest";

import { expandFragments, redactExternalText, redactUrl, redactUrlsInText, sanitiseExternalText } from "./redact";

describe("redactUrl", () => {
  it("keeps a URL with no query untouched", () => {
    expect(redactUrl("http://127.0.0.1:3000/health")).toBe("http://127.0.0.1:3000/health");
  });

  it("keeps origin and path, and says how many parameters were dropped", () => {
    expect(redactUrl("https://cdn.example/photo.jpg?X-Amz-Signature=abc&X-Amz-Expires=60")).toBe(
      "https://cdn.example/photo.jpg?<redacted: 2 parameter(s)>",
    );
  });

  it("redacts the SHAPE that triggered this module: an opaque id in a ws:// query", () => {
    // The real value is deliberately not reproduced here. It was an ephemeral
    // Next HMR session id, and committing a high-entropy token-shaped string
    // into a test file is the habit this module exists to break.
    const opaque = "PLACEHOLDER-not-a-real-id";
    const redacted = redactUrl(`ws://127.0.0.1:3212/_next/hmr?id=${opaque}`);
    expect(redacted).toBe("ws://127.0.0.1:3212/_next/hmr?<redacted: 1 parameter(s)>");
    expect(redacted).not.toContain(opaque);
  });

  it("drops the fragment, which never reaches a server but does reach a log", () => {
    expect(redactUrl("https://example.test/reset#token=secret")).toBe(
      "https://example.test/reset#<redacted>",
    );
    expect(redactUrl("https://example.test/p?a=1#token=secret")).toBe(
      "https://example.test/p?<redacted: 1 parameter(s)>#<redacted>",
    );
  });

  it("handles an empty query without claiming a parameter", () => {
    expect(redactUrl("https://example.test/p?")).toBe("https://example.test/p?<redacted: 0 parameter(s)>");
  });

  it("passes non-strings and empty strings through unchanged", () => {
    expect(redactUrl("")).toBe("");
  });
});

describe("redactUrlsInText", () => {
  it("redacts a URL embedded mid-sentence, as Chromium reports one", () => {
    const opaque = "PLACEHOLDER-not-a-real-id";
    const message = `WebSocket connection to 'ws://127.0.0.1:3212/_next/hmr?id=${opaque}' failed`;
    const redacted = redactUrlsInText(message);
    expect(redacted).not.toContain(opaque);
    expect(redacted).toContain("ws://127.0.0.1:3212/_next/hmr?<redacted: 1 parameter(s)>");
    expect(redacted).toContain("failed");
  });

  it("redacts every URL in a message, not only the first", () => {
    const redacted = redactUrlsInText(
      "loading https://a.test/x?k=1 failed after https://b.test/y?j=2",
    );
    expect(redacted).not.toMatch(/k=1|j=2/);
  });

  it("leaves text with no URL alone", () => {
    expect(redactUrlsInText("Uncaught TypeError: x is not a function")).toBe(
      "Uncaught TypeError: x is not a function",
    );
  });
});

describe("redactUrlsInText — the SCHEME-LESS form (PR #3 re-verification, FINDING 13)", () => {
  // Playwright drops the scheme when it writes a `test.trace` step subtitle, so
  // any `page.goto(signedUrl)` produces `host:port/path?query`. The absolute
  // program requires `scheme://` and the relative program requires the match to
  // begin at `/`; this form satisfied neither, and the verifier's own three-line
  // reduction is reproduced below verbatim.
  it("redacts the verifier's reduction line, which has an UNDOTTED host", () => {
    expect(redactUrlsInText('"subtitle":"host:3219/m.jpg?X-Amz-Sig=SENTINEL&e=60"')).toBe(
      '"subtitle":"host:3219/m.jpg?<redacted: 2 parameter(s)>"',
    );
  });

  it("redacts the shape a real Playwright subtitle carries", () => {
    expect(redactUrlsInText('"subtitle":"127.0.0.1:3987/media/p.jpg?X-Amz-Signature=SENTINEL"')).toBe(
      '"subtitle":"127.0.0.1:3987/media/p.jpg?<redacted: 1 parameter(s)>"',
    );
  });

  it("redacts a dotted host with no port", () => {
    expect(redactUrlsInText("cdn.example/photo.jpg?sig=SENTINEL")).toBe(
      "cdn.example/photo.jpg?<redacted: 1 parameter(s)>",
    );
  });

  it("still redacts the absolute and relative forms the two old programs covered", () => {
    expect(redactUrlsInText('"url":"http://host/m.jpg?X-Amz-Sig=SENTINEL&e=60"')).toContain("<redacted:");
    expect(redactUrlsInText("navigating to /m.jpg?X-Amz-Sig=SENTINEL")).toContain("<redacted:");
  });

  it("leaves ordinary prose alone — no authority, no path", () => {
    expect(redactUrlsInText("see step 3/4? and a 1:23/foo timestamp")).toBe(
      "see step 3/4? and a 1:23/foo timestamp",
    );
  });

  it("leaves a fraction with no query alone", () => {
    expect(redactUrlsInText("host:3219/m.jpg")).toBe("host:3219/m.jpg");
  });
});

describe("sanitiseExternalText — workflow-command injection (seat FINDING 13)", () => {
  // The page under test controls its own console text. That text is copied into
  // a Playwright failure message, printed by the `list` reporter, and lands in
  // the GitHub Actions log, where a line beginning `::` is a workflow command.
  it("a leading :: cannot start a workflow command", () => {
    const out = sanitiseExternalText("::error file=app.ts::pwned");
    expect(out.startsWith("::")).toBe(false);
    expect(out).toContain("error file=app.ts");
  });

  it("an embedded newline cannot start a new line", () => {
    const out = sanitiseExternalText("harmless" + "\n" + "::add-mask::secret");
    expect(out).not.toContain("\n");
    expect(out).not.toMatch(/^::/m);
  });

  it("a carriage return is collapsed too", () => {
    expect(sanitiseExternalText("a" + "\r" + "b")).not.toContain("\r");
  });

  it("the percent-encoded spellings GitHub also accepts are escaped", () => {
    const out = sanitiseExternalText("a%0A::stop-commands::x%25y");
    expect(out).not.toContain("%0A::");
    expect(out).toContain("%250A");
    expect(out).toContain("%2525");
  });

  it("a bare ESC cannot rewrite a terminal transcript", () => {
    expect(sanitiseExternalText("a" + "\u001B" + "[2Jb")).not.toContain("\u001B");
  });

  it("caps the length and says how much was dropped", () => {
    const out = sanitiseExternalText("x".repeat(500));
    expect(out.length).toBeLessThan(260);
    expect(out).toContain("more character(s) dropped");
  });

  it("leaves an ordinary message untouched", () => {
    expect(sanitiseExternalText("Uncaught TypeError: x is not a function")).toBe(
      "Uncaught TypeError: x is not a function",
    );
  });

  it("is a no-op on the empty string", () => {
    expect(sanitiseExternalText("")).toBe("");
  });
});

describe("redactExternalText — the two in order", () => {
  it("redacts the URL and then makes the rest inert", () => {
    const out = redactExternalText("::error::fetch host:3219/m.jpg?sig=SENTINEL failed");
    expect(out).not.toContain("SENTINEL");
    expect(out).toContain("<redacted:");
    expect(out.startsWith("::")).toBe(false);
  });
});

describe("redactUrlsInText — the four shapes a verifier found uncovered (FINDING 4)", () => {
  // AGENTS.md said the redaction covered "URLs that carry a scheme or start at
  // `/`". `//host:8443/p?q` starts at `/`; `HTTPS://h/p?q` carries a scheme;
  // neither was matched. Each shape is pinned here so the next round cannot
  // re-discover it, and the AGENTS.md sentence now maps clause by clause to
  // these cases.
  const M = "MARKERVALUE";

  it("an UPPERCASE scheme is redacted", () => {
    expect(redactUrlsInText(`HTTPS://host.example/p?sig=${M}`)).not.toContain(M);
  });

  it("a mixed-case scheme is redacted", () => {
    expect(redactUrlsInText(`HtTp://host.example/p?sig=${M}`)).not.toContain(M);
  });

  it("JSON-ESCAPED slashes are redacted", () => {
    const json = '{"u":"https:\\/\\/host/p?sig=' + M + '"}';
    expect(redactUrlsInText(json)).not.toContain(M);
  });

  it("a PROTOCOL-RELATIVE URL is redacted", () => {
    expect(redactUrlsInText(`"u":"//host.example:8443/p?sig=${M}"`)).not.toContain(M);
  });

  it("a protocol-relative URL with no port is redacted", () => {
    expect(redactUrlsInText(`"u":"//host.example/p?sig=${M}"`)).not.toContain(M);
  });

  it("a bracketed IPv6 authority with a port is redacted", () => {
    expect(redactUrlsInText(`"u":"[::1]:3000/p?sig=${M}"`)).not.toContain(M);
  });

  it("a bracketed IPv6 authority with no port is redacted", () => {
    expect(redactUrlsInText(`"u":"[2001:db8::1]/p?sig=${M}"`)).not.toContain(M);
  });

  it("a protocol-relative IPv6 authority is redacted", () => {
    expect(redactUrlsInText(`"u":"//[::1]:3000/p?sig=${M}"`)).not.toContain(M);
  });

  it("the host and path stay readable in every one of them", () => {
    expect(redactUrlsInText(`"u":"//host.example:8443/p?sig=${M}"`)).toContain("//host.example:8443/p");
    expect(redactUrlsInText(`HTTPS://host.example/p?sig=${M}`)).toContain("host.example/p");
  });

  it("prose with a bare // and a ? is still untouched", () => {
    expect(redactUrlsInText("see step 3/4? and a//b?c")).toBe("see step 3/4? and a//b?c");
  });
});

describe("sanitiseExternalText — leading whitespace before :: (FINDING 5)", () => {
  it("two leading spaces do not buy a workflow command", () => {
    const out = sanitiseExternalText("  ::error file=app.ts::pwned");
    expect(out).not.toMatch(/^\s*::/);
    expect(out).toContain("error file=app.ts");
  });

  it("a leading TAB does not buy a workflow command", () => {
    expect(sanitiseExternalText("\t" + "::add-mask::secret")).not.toMatch(/^\s*::/);
  });

  it("mixed leading whitespace does not buy a workflow command", () => {
    expect(sanitiseExternalText(" " + "\t" + " ::stop-commands::x")).not.toMatch(/^\s*::/);
  });

  it("a :: in the MIDDLE of a line is left alone — it is not a command", () => {
    expect(sanitiseExternalText("TypeError: Foo::bar is not a function")).toBe(
      "TypeError: Foo::bar is not a function",
    );
  });
});

describe("expandFragments — the shared programs' placeholders (R3-FINDING I)", () => {
  const fragments = new Map([
    ["SLASH", "/"],
    ["IPV6", "\\[::1\\]"],
  ]);

  it("expands every placeholder, including a name with a digit", () => {
    expect(expandFragments("a<<SLASH>>b<<IPV6>>", fragments)).toBe("a/b\\[::1\\]");
  });

  it("REFUSES an unknown name rather than expanding it to nothing", () => {
    expect(() => expandFragments("<<NOPE>>", fragments)).toThrow(/unknown fragment <<NOPE>>/);
  });

  it("REFUSES a placeholder it could not read, rather than leaving it as literal regex text", () => {
    expect(() => expandFragments("<<NOT-A-NAME>>", fragments)).toThrow(/unexpanded placeholder/);
  });
});
