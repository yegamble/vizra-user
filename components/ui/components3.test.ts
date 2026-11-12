import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Avatar, initialsOf } from "./Avatar";
import { Banner } from "./Banner";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Skeleton } from "./Skeleton";
import { Toast, liveRoleOf } from "./Toast";

const r = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);

describe("Avatar (Figma 14:56)", () => {
  it("Type=Image: img with the person's name as alt", () => {
    const html = r(h(Avatar, { name: "Ada Lovelace", src: "/a.jpg", size: "lg" }));
    expect(html).toMatch(/<img src="\/a.jpg" alt="Ada Lovelace"/);
    expect(html).toContain("size-16");
  });
  it("Type=Initials: role=img named, initials decorative", () => {
    const html = r(h(Avatar, { name: "ada lovelace", size: "xs" }));
    expect(html).toContain('role="img" aria-label="ada lovelace"');
    expect(html).toContain('<span aria-hidden="true">AL</span>');
    expect(html).toContain("size-6");
  });
  it("Type=Fallback: no letters → person icon, still named", () => {
    const html = r(h(Avatar, { name: "—" }));
    expect(html).toContain('data-type="fallback"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(initialsOf("  ")).toBe("");
    expect(initialsOf("Émile Zola Extra")).toBe("ÉZ");
  });
  it("Size: XS/SM/MD/LG map to 24/32/40/64", () => {
    for (const [s, c] of [["xs", "size-6"], ["sm", "size-8"], ["md", "size-10"], ["lg", "size-16"]] as const)
      expect(r(h(Avatar, { name: "A", size: s }))).toContain(c);
  });
});

describe("Skeleton (Figma 17:72)", () => {
  it("Line/Block/Circle are decorative and static", () => {
    for (const shape of ["line", "block", "circle"] as const) {
      const html = r(h(Skeleton, { shape }));
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(`data-shape="${shape}"`);
      expect(html).not.toMatch(/animate-/);
    }
  });
});

describe("EmptyState (Figma 17:95) / ErrorState (17:96)", () => {
  it("Kind Empty | No results with caller copy", () => {
    const e = r(h(EmptyState, { kind: "empty", title: "No photos yet", body: "Upload one." }));
    expect(e).toContain('data-kind="empty"');
    expect(e).toContain("<h2");
    expect(r(h(EmptyState, { kind: "noResults", title: "t", body: "b" }))).toContain('data-kind="noResults"');
  });
  it("ErrorState always carries a native retry button", () => {
    const html = r(h(ErrorState, { title: "Could not load", body: "Nothing was changed.", onRetry: () => {} }));
    expect(html).toMatch(/<button type="button"[^>]*>.*Try again/);
    expect(html).toContain("Nothing was changed.");
  });
});

describe("Banner (Figma 17:68)", () => {
  it("Tone Info | Warn | Danger: named region, icon + text, not a live region", () => {
    for (const tone of ["info", "warn", "danger"] as const) {
      const html = r(h(Banner, { tone, title: "Sign-up is closed", body: "The owner can open it." }));
      expect(html).toMatch(/^<section data-tone="[a-z]+" aria-label="Sign-up is closed"/);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(html).not.toContain("aria-live");
      expect(html).not.toContain('role="alert"');
    }
  });
});

describe("Toast / Inline status (Figma 17:40)", () => {
  it("Success and Info are polite status regions with the caller's message", () => {
    for (const tone of ["success", "info"] as const) {
      const html = r(h(Toast, { tone, message: "Saved 3 photos" }));
      expect(html).toMatch(/^<div role="status" aria-live="polite"/);
      expect(html).toContain("Saved 3 photos");
    }
  });
  it("Error is role=alert, not polite, and renders its recovery action", () => {
    const html = r(h(Toast, { tone: "error", message: "Upload failed", action: h("button", { type: "button" }, "Retry") }));
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).not.toContain("aria-live");
    expect(html).toContain(">Retry</button>");
    expect(liveRoleOf("error")).toEqual({ role: "alert" });
  });
  it("no fake success: renders only the message it was given", () => {
    const html = r(h(Toast, { tone: "success", message: "" }));
    expect(html).toContain('<p class="flex-1 text-body"></p>');
  });
});

import { Dialog } from "./Dialog";

describe("Dialog (Figma 16:43)", () => {
  const base = { open: false, onClose: () => {}, title: "Delete album?", confirmLabel: "Delete album", onConfirm: () => {}, children: "The photos stay in your library." };
  it("native <dialog> labelled by its title; named close button; Cancel autofocused", () => {
    const html = r(h(Dialog, base));
    expect(html).toMatch(/^<dialog aria-labelledby="([^"]+)"/);
    const id = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`<h2 id="${id}"`);
    expect(html).toContain('aria-label="Close"');
    expect(html).toMatch(/<button autofocus=""[^>]*data-kind="secondary"[^>]*><span>Cancel<\/span>/i);
    expect(html).not.toContain(" open=");
  });
  it("Kind=Destructive: confirm is the danger button and is not autofocused", () => {
    const html = r(h(Dialog, { ...base, kind: "destructive" }));
    expect(html).toContain('data-kind="destructive"');
    expect(html).toMatch(/<button type="button" data-kind="danger"[^>]*><span>Delete album<\/span>/);
  });
});
