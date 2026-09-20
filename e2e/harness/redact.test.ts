/**
 * The redactor keeps what makes a failure diagnosable and drops what makes a
 * transcript a credential leak. See `redact.ts` for why a test harness is
 * exactly where a signed URL escapes into a log.
 */

import { describe, expect, it } from "vitest";

import { redactUrl, redactUrlsInText } from "./redact";

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
