/**
 * design/tokens.css against the accepted design's own claims.
 *
 * This is not a copy of the file compared with itself. It checks the
 * STRUCTURE the design specifies (counts per group, what dark may redefine,
 * the two dark blocks agreeing, nothing Apple, nothing Figma-only) and then
 * re-derives the design's CONTRAST TABLE from the shipped hex values: every
 * audited pair must meet its WCAG minimum in both modes and land on the
 * figure the design published (docs/design/figma/README.md §4, meta repo) to
 * within 1%. A mistyped hex digit that moves a ratio by more than that fails
 * here; a last-digit slip that moves it less is below what this can see.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const globals = readFileSync(path.join(here, "..", "app", "globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no "${selector}" block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of body.matchAll(/(--vz-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1] as string;
    if (map.has(name)) throw new Error(`${name} is declared twice in one block`);
    map.set(name, (match[2] as string).replace(/\s+/g, " ").trim());
  }
  return map;
}

const light = declarations(block(":root"));
const darkExplicit = declarations(block(':root[data-theme="dark"]'));
const darkSystem = declarations(block(':root:not([data-theme="light"])'));

/** The 36 roles of Figma's `Color` collection: 29 aliases, 4 alpha, 3 shadow. */
const COLOR_ROLES = [
  "bg", "bg-elevated", "bg-tint", "ink", "ink-2", "ink-3", "line", "line-2",
  "accent", "accent-hover", "accent-pressed", "accent-soft", "accent-ink", "on-accent",
  "danger", "danger-hover", "danger-pressed", "danger-soft", "danger-ink", "on-danger",
  "success", "success-soft", "success-ink", "on-success",
  "warn", "warn-soft", "warn-ink", "on-warn", "focus-ring",
  "scrim", "bg-frost", "on-media-scrim", "on-media",
  "shadow-1", "shadow-2", "shadow-3",
].map((role) => `--vz-${role}`);

const names = (prefix: string) => [...light.keys()].filter((name) => name.startsWith(prefix));

describe("token file structure", () => {
  it("defines the 36 colour roles in light", () => {
    expect(COLOR_ROLES).toHaveLength(36);
    for (const role of COLOR_ROLES) expect(light.has(role), `${role} missing in light`).toBe(true);
  });

  it("dark redefines exactly the 36 colour roles and nothing else", () => {
    expect([...darkExplicit.keys()].sort()).toEqual([...COLOR_ROLES].sort());
  });

  it("the explicit and the system-preference dark blocks are identical", () => {
    expect([...darkSystem.entries()]).toEqual([...darkExplicit.entries()]);
  });

  it("the system-preference block is inside prefers-color-scheme: dark", () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/,
    );
  });

  it("has the scale the design declares: 11 spacing, 5 radii, 3 strokes, 7 sizes, 27 type metrics, 3 motion, 3 elevations", () => {
    expect(names("--vz-space-")).toHaveLength(11);
    expect(names("--vz-radius-")).toHaveLength(5);
    expect(names("--vz-stroke-")).toHaveLength(3);
    expect(names("--vz-size-")).toHaveLength(7);
    expect(names("--vz-type-")).toHaveLength(27);
    expect(names("--vz-motion-")).toHaveLength(3);
    expect(names("--vz-elevation-")).toHaveLength(3);
  });

  it("spacing is the 4px grid", () => {
    for (const step of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16]) {
      expect(light.get(`--vz-space-${step}`)).toBe(`${step * 0.25}rem`);
    }
  });

  it("the theme-invariant on-media roles do not change between modes", () => {
    for (const role of ["--vz-on-media", "--vz-on-media-scrim"]) {
      expect(darkExplicit.get(role)).toBe(light.get(role));
    }
  });

  it("the frosted bar stays at the measured 92% floor in both modes", () => {
    expect(light.get("--vz-bg-frost")).toMatch(/\/ 0\.92\)$/);
    expect(darkExplicit.get("--vz-bg-frost")).toMatch(/\/ 0\.92\)$/);
  });

  it("names no Apple font and mirrors no Figma-only value", () => {
    const stacks = `${light.get("--vz-font-sans")} ${light.get("--vz-font-mono")}`;
    expect(stacks).not.toMatch(/SF Pro|SF Mono|-apple-system|BlinkMacSystemFont|San Francisco|Helvetica Neue|Menlo|Monaco/i);
    expect(stacks).not.toMatch(/\bInter\b/);
    expect(css).not.toMatch(/meter|figma-proxy/i);
  });

  it("emits no primitive ramp as a custom property", () => {
    expect([...light.keys()].filter((name) => /--vz-(neutral|blue|red|green|amber)-/.test(name))).toEqual([]);
  });
});

describe("Tailwind wiring (app/globals.css)", () => {
  it("imports the token file and removes Tailwind's stock palette, radii, shadows and type scale", () => {
    expect(globals).toContain('@import "../design/tokens.css";');
    for (const namespace of ["color", "radius", "shadow", "text"]) {
      expect(globals).toContain(`--${namespace}-*: initial;`);
    }
  });

  it("maps every themed colour role, and only to a token that exists", () => {
    const mapped = [...globals.matchAll(/var\((--vz-[a-z0-9-]+)\)/g)].map((match) => match[1] as string);
    expect(mapped.length).toBeGreaterThan(60);
    for (const name of mapped) expect(light.has(name), `globals.css uses undefined ${name}`).toBe(true);
    const shadowOnly = new Set(["--vz-shadow-1", "--vz-shadow-2", "--vz-shadow-3"]);
    for (const role of COLOR_ROLES.filter((name) => !shadowOnly.has(name))) {
      expect(globals, `${role} is not mapped into the Tailwind theme`).toContain(
        `--color-${role.slice("--vz-".length)}: var(${role});`,
      );
    }
  });

  it("keeps the designed focus ring and a reduced-motion rule", () => {
    expect(globals).toMatch(/:focus-visible \{\s*outline: var\(--vz-stroke-focus\) solid var\(--vz-focus-ring\);\s*outline-offset: 2px;/);
    expect(globals).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globals).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

// ── Contrast, re-derived from the shipped values ──────────────────────────

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/.exec(hex);
  if (!match) throw new Error(`not an opaque hex colour: ${hex}`);
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt((match[1] as string).slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, WCAG minimum, published light, published dark] */
const PAIRS: ReadonlyArray<readonly [string, string, number, number, number]> = [
  ["ink", "bg", 4.5, 18.02, 17.53],
  ["ink", "bg-elevated", 4.5, 18.81, 15.88],
  ["ink", "bg-tint", 4.5, 16.75, 13.82],
  ["ink", "accent-soft", 4.5, 16.27, 12.53],
  ["ink-2", "bg", 4.5, 9.59, 11.71],
  ["ink-2", "bg-elevated", 4.5, 10.01, 10.6],
  ["ink-2", "bg-tint", 4.5, 8.91, 9.23],
  ["ink-3", "bg", 4.5, 5.28, 6.64],
  ["ink-3", "bg-tint", 4.5, 4.9, 5.23],
  ["ink-3", "bg-elevated", 4.5, 5.51, 6.01],
  ["ink-3", "accent-soft", 4.5, 4.76, 4.74],
  ["accent", "bg", 4.5, 4.72, 7.7],
  ["accent", "bg-elevated", 4.5, 4.93, 6.97],
  ["on-accent", "accent", 4.5, 4.93, 8.1],
  ["on-accent", "accent-hover", 4.5, 6.63, 10.07],
  ["on-accent", "accent-pressed", 4.5, 8.57, 6.96],
  ["accent-ink", "accent-soft", 4.5, 9.58, 5.5],
  ["line", "bg", 3, 3.49, 4.11],
  ["line", "bg-elevated", 3, 3.64, 3.72],
  ["line", "bg-tint", 3, 3.24, 3.24],
  ["focus-ring", "bg", 3, 6.36, 7.7],
  ["danger", "bg", 4.5, 5.18, 6.64],
  ["danger", "bg-elevated", 4.5, 5.41, 6.01],
  ["on-danger", "danger", 4.5, 5.41, 6.98],
  ["on-danger", "danger-hover", 4.5, 7.23, 9.55],
  ["danger-ink", "danger-soft", 4.5, 8.57, 4.87],
  ["success", "bg", 4.5, 4.95, 8.8],
  ["success", "bg-elevated", 4.5, 5.17, 7.96],
  ["on-success", "success", 4.5, 5.17, 9.25],
  ["success-ink", "success-soft", 4.5, 7.69, 6.13],
  ["warn", "bg", 4.5, 4.92, 10.1],
  ["warn", "bg-elevated", 4.5, 5.13, 9.14],
  ["on-warn", "warn", 4.5, 5.13, 10.62],
  ["warn-ink", "warn-soft", 4.5, 7.61, 7.24],
];

describe.each([
  ["light", light, 3],
  ["dark", darkExplicit, 4],
] as const)("contrast in %s", (_mode, tokens, column) => {
  it.each(PAIRS)("%s on %s is at least %s:1 and matches the published figure", (...pair) => {
    const [foreground, background, minimum] = pair;
    const published = pair[column];
    const ratio = contrast(
      tokens.get(`--vz-${foreground}`) as string,
      tokens.get(`--vz-${background}`) as string,
    );
    expect(ratio).toBeGreaterThanOrEqual(minimum);
    // Within 1%: the design computed its table from unrounded OKLCH, the
    // shipped values are the 8-bit sRGB hex, and the two differ by up to 0.7%.
    expect(Math.abs(ratio - published) / published).toBeLessThan(0.01);
  });
});
