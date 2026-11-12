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

import { Checkbox, applyMixed } from "./Checkbox";
import { RadioGroup } from "./Radio";
import { Switch } from "./Switch";

describe("Checkbox (Figma 10:66)", () => {
  it("Checked=Off: native unchecked checkbox, labelled, line boundary", () => {
    const html = r(h(Checkbox, { label: "Public", checked: "off", onChange: () => {} }));
    const id = idOf(html, /<label for="([^"]+)"/);
    expect(html).toContain(`id="${id}" type="checkbox"`);
    expect(html).not.toContain('checked=""');
    expect(html).toContain("border-line");
    expect(html).toContain("focus-visible:outline-focus-ring");
    expect(html).not.toContain("aria-checked");
  });
  it("Checked=On: native checked", () => {
    expect(r(h(Checkbox, { label: "Public", checked: "on", onChange: () => {} }))).toContain('checked=""');
  });
  it("Checked=Mixed: not checked, indeterminate set via the DOM property", () => {
    const html = r(h(Checkbox, { label: "All", checked: "mixed", onChange: () => {} }));
    expect(html).not.toContain('checked=""');
    expect(html).toContain('data-checked="mixed"');
    const el = { indeterminate: false } as HTMLInputElement;
    applyMixed(el, true);
    expect(el.indeterminate).toBe(true);
    applyMixed(el, false);
    expect(el.indeterminate).toBe(false);
  });
  it("State=Disabled: native disabled", () => {
    expect(r(h(Checkbox, { label: "Public", checked: "off", disabled: true }))).toContain('disabled=""');
  });
});

describe("Radio (Figma 10:103)", () => {
  const options = [{ value: "l", label: "Landscape" }, { value: "p", label: "Portrait", disabled: true }];
  it("group is a fieldset named by its legend; radios share a name and have labels", () => {
    const html = r(h(RadioGroup, { legend: "Orientation", name: "o", options, value: "l", onChange: () => {} }));
    expect(html).toMatch(/^<fieldset[^>]*><legend[^>]*>Orientation<\/legend>/);
    expect(html.match(/type="radio"[^>]*name="o"/g)).toHaveLength(2);
    for (const id of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${id[1]}"`);
  });
  it("Checked=On/Off: only the selected value is checked", () => {
    const html = r(h(RadioGroup, { legend: "Orientation", name: "o", options, value: "l", onChange: () => {} }));
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/checked="" value="l"/);
  });
  it("State=Disabled: per option and whole group", () => {
    expect(r(h(RadioGroup, { legend: "O", name: "o", options }))).toMatch(/disabled=""[^>]*value="p"/);
    expect(r(h(RadioGroup, { legend: "O", name: "o", options, disabled: true }))).toMatch(/^<fieldset disabled=""/);
  });
});

describe("Switch (Figma 10:144)", () => {
  it("native checkbox with role=switch and a visible label; thumb position cue", () => {
    const html = r(h(Switch, { label: "Show EXIF" }));
    const id = idOf(html, /<label for="([^"]+)"/);
    expect(html).toContain(`id="${id}" type="checkbox" role="switch"`);
    expect(html).toContain("checked:before:translate-x-4");
    expect(html).toContain("border-line");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("focus-visible:outline-focus-ring");
  });
  it("Checked=On/Off maps to native checked", () => {
    expect(r(h(Switch, { label: "x", checked: true, onChange: () => {} }))).toContain('checked=""');
    expect(r(h(Switch, { label: "x", checked: false, onChange: () => {} }))).not.toContain('checked=""');
  });
  it("State=Disabled: native disabled", () => {
    expect(r(h(Switch, { label: "x", disabled: true }))).toContain('disabled=""');
  });
});

import { Chip } from "./Chip";
import { Tabs, nextTabIndex } from "./Tabs";

describe("Chip (Figma 11:54)", () => {
  it("Selected=No: native toggle button, aria-pressed=false, no check icon", () => {
    const html = r(h(Chip, { label: "Landscape", selected: false }));
    expect(html).toMatch(/^<button type="button" aria-pressed="false"/);
    expect(html).toContain("<span>Landscape</span>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("focus-visible:outline-focus-ring");
  });
  it("Selected=Yes: aria-pressed=true plus a decorative check icon (not colour alone)", () => {
    const html = r(h(Chip, { label: "Landscape", selected: true }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
  it("State=Disabled: native disabled", () => {
    expect(r(h(Chip, { label: "x", selected: false, disabled: true }))).toContain('disabled=""');
  });
  it("hit area is 44px (touch-min) while the drawn pill stays 32px (control-sm)", () => {
    const html = r(h(Chip, { label: "x", selected: false }));
    expect(html).toMatch(/^<button[^>]*class="[^"]*min-h-touch-min/);
    expect(html).toMatch(/<span class="[^"]*h-control-sm/);
  });
});

describe("Tab (Figma 11:79)", () => {
  const tabs = [{ id: "a", label: "Photos" }, { id: "b", label: "Albums" }, { id: "c", label: "Faves" }];
  it("tablist named; Selected=Yes/No via aria-selected, roving tabindex, indicator + weight", () => {
    const html = r(h(Tabs, { label: "Profile sections", tabs, selectedId: "b", onSelect: () => {} }));
    expect(html).toMatch(/^<div role="tablist" aria-label="Profile sections"/);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-selected="true"[^>]*tabindex="0"[^>]*border-accent font-semibold/);
    expect(html).toContain("focus-visible:outline-focus-ring");
    for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) expect(m[1]).toContain("-panel-");
  });
  it("keyboard: arrows wrap, Home/End jump, other keys ignored", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("Enter", 1, 3)).toBeNull();
  });
});
