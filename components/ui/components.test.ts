import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BUTTON_KIND_CLASS, Button, FOCUS_RING_CLASS } from "./Button";
import { ICON_BUTTON_KIND_CLASS, IconButton } from "./IconButton";
import { TextField } from "./TextField";

const r = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);

describe("Button (Figma 7:146)", () => {
  for (const kind of Object.keys(BUTTON_KIND_CLASS) as (keyof typeof BUTTON_KIND_CLASS)[]) {
    it(`Kind=${kind}: native button with name, kind tokens and focus ring`, () => {
      const html = r(h(Button, { kind, label: "Save" }));
      expect(html).toMatch(/^<button type="button"/);
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain("<span>Save</span>");
      for (const c of BUTTON_KIND_CLASS[kind].split(" ")) expect(html).toContain(c);
      for (const c of FOCUS_RING_CLASS.split(" ")) expect(html).toContain(c);
      expect(html).toMatch(/hover:|active:/);
    });
  }
  it("State=Disabled sets native disabled and the readable disabled tokens", () => {
    const html = r(h(Button, { label: "Save", disabled: true }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("disabled:bg-bg-tint");
    expect(html).toContain("disabled:text-ink-3");
    expect(html).not.toContain("aria-busy");
  });
  it("State=Loading sets aria-busy, disables, keeps the name, honours reduced motion", () => {
    const html = r(h(Button, { label: "Save", loading: true }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("<span>Save</span>");
    expect(html).toContain("motion-reduce:animate-none");
  });
  it("Default is not busy and not disabled", () => {
    const html = r(h(Button, { label: "Save" }));
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain("aria-busy");
  });
});

describe("IconButton (Figma 8:104)", () => {
  for (const kind of Object.keys(ICON_BUTTON_KIND_CLASS) as (keyof typeof ICON_BUTTON_KIND_CLASS)[]) {
    it(`Kind=${kind}: name on the button, svg hidden, 44px hit box`, () => {
      const html = r(h(IconButton, { kind, icon: "favorite", label: "Favorite" }));
      expect(html).toMatch(/^<button type="button" aria-label="Favorite"/);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("size-touch-min");
      for (const c of ICON_BUTTON_KIND_CLASS[kind].split(" ")) expect(html).toContain(c);
      expect(html).toContain(kind === "onMedia" ? "var(--vz-on-media-scrim)" : "focus-visible:outline-focus-ring");
    });
  }
  it("toggle exposes aria-pressed; non-toggle does not", () => {
    expect(r(h(IconButton, { icon: "favorite", label: "Favorite", pressed: true }))).toContain('aria-pressed="true"');
    expect(r(h(IconButton, { icon: "favorite", label: "Favorite", pressed: false }))).toContain('aria-pressed="false"');
    expect(r(h(IconButton, { icon: "favorite", label: "Favorite" }))).not.toContain("aria-pressed");
  });
  it("State=Disabled is native disabled with disabled tokens", () => {
    const html = r(h(IconButton, { icon: "delete", label: "Delete", disabled: true }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("group-disabled:text-ink-3");
  });
});

describe("TextField (Figma 9:42)", () => {
  it("Default: visible label bound to the input, focus ring, no invalid", () => {
    const html = r(h(TextField, { label: "Username", autoComplete: "username" }));
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain(">Username</label>");
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain("focus-visible:outline-focus-ring");
    expect(html).toContain("border-line");
    expect(html).not.toContain("aria-invalid");
  });
  it("Error: aria-invalid, describedby links helper and error, icon plus text", () => {
    const html = r(h(TextField, { label: "Email", helper: "We never share it", error: "Enter an email address" }));
    expect(html).toContain('aria-invalid="true"');
    const ids = /aria-describedby="([^"]+)"/.exec(html)?.[1]?.split(" ") ?? [];
    expect(ids).toHaveLength(2);
    for (const i of ids) expect(html).toContain(`id="${i}"`);
    expect(html).toContain("border-danger");
    expect(html).toMatch(/aria-hidden="true"[^>]*>.*<\/svg>Enter an email address/);
  });
  it("Disabled: native disabled", () => {
    expect(r(h(TextField, { label: "Name", disabled: true }))).toContain('disabled=""');
  });
});
