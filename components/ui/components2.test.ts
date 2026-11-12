import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Textarea } from "./Textarea";

const r = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
const idOf = (html: string, re: RegExp) => html.match(re)?.[1];

describe("Textarea (Figma 9:83)", () => {
  it("Default: native textarea labelled by a visible label, not invalid", () => {
    const html = r(h(Textarea, { label: "Description" }));
    const id = idOf(html, /<label for="([^"]+)"/);
    expect(html).toContain(`<textarea id="${id}"`);
    expect(html).not.toContain("aria-invalid");
    expect(html).toContain("border-line");
    expect(html).toContain("hover:border-ink-3");
    expect(html).toContain("focus-visible:outline-focus-ring");
  });
  it("Error: aria-invalid, icon + text linked by aria-describedby, danger border", () => {
    const html = r(h(Textarea, { label: "Description", helper: "Optional", error: "Too long" }));
    expect(html).toContain('aria-invalid="true"');
    const ids = idOf(html, /aria-describedby="([^"]+)"/)!.split(" ");
    expect(ids).toHaveLength(2);
    for (const i of ids) expect(html).toContain(`id="${i}"`);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain("Too long");
    expect(html).toContain("border-danger");
  });
  it("Disabled: native disabled with disabled tokens", () => {
    const html = r(h(Textarea, { label: "Description", disabled: true }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("disabled:bg-bg-tint");
  });
});

import { Select } from "./Select";

describe("Select (Figma 9:139)", () => {
  const options = [{ value: "a", label: "Newest" }, { value: "b", label: "Oldest" }];
  it("Default: native select labelled by visible label, options, decorative chevron", () => {
    const html = r(h(Select, { label: "Sort", options }));
    const id = idOf(html, /<label for="([^"]+)"/);
    expect(html).toContain(`<select id="${id}"`);
    expect(html).toContain('<option value="a">Newest</option>');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain("aria-invalid");
    expect(html).toContain("focus-visible:outline-focus-ring");
  });
  it("Error: aria-invalid + describedby error text", () => {
    const html = r(h(Select, { label: "Sort", options, error: "Pick one" }));
    expect(html).toContain('aria-invalid="true"');
    const eid = idOf(html, /aria-describedby="([^"]+)"/);
    expect(html).toContain(`id="${eid}"`);
    expect(html).toContain("Pick one");
  });
  it("Disabled: native disabled", () => {
    expect(r(h(Select, { label: "Sort", options, disabled: true }))).toContain('disabled=""');
  });
});
