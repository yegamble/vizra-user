import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhotoCard, type PhotoCardProps } from "./PhotoCard";
import { TabBar, TabBarItem } from "./TabBar";

const r = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
const noop = () => {};
const actions = [
  { icon: "favorite", label: "Favorite Harbour at dusk", onClick: noop, pressed: false },
  { icon: "add-to-album", label: "Add Harbour at dusk to an album", onClick: noop },
] as const;
const ASPECTS = [["landscape", "aspect-[3/2]"], ["square", "aspect-square"], ["portrait", "aspect-[4/5]"]] as const;

describe("PhotoCard (Figma 12:263)", () => {
  for (const [aspect, cls] of ASPECTS) {
    it(`Aspect=${aspect} State=Default: img with alt/size, object-contain, actions in the bar below`, () => {
      const html = r(h(PhotoCard, { state: "default", aspect, title: "Harbour at dusk", src: "/p/1.jpg", alt: "Boats moored at dusk", width: 1200, height: 800, actions }));
      expect(html).toContain(cls);
      expect(html).toMatch(/<img src="\/p\/1.jpg" alt="Boats moored at dusk" width="1200" height="800"/);
      expect(html).toContain("object-contain");
      expect(html).not.toMatch(/object-(cover|fill)/);
      // actions follow the image inside figcaption, not an overlay
      expect(html.indexOf("<img")).toBeLessThan(html.indexOf("<figcaption"));
      expect(html).toMatch(/<figcaption[^>]*>.*<button[^>]*aria-label="Favorite Harbour at dusk"/);
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain('aria-label="Add Harbour at dusk to an album"');
      expect(html).not.toContain("group-hover:opacity");
    });
    it(`Aspect=${aspect} State=Sensitive: no <img>, no src, named reveal button`, () => {
      const html = r(h(PhotoCard, { state: "sensitive", aspect, title: "Hidden photo", warning: "Sensitive content", revealLabel: "Show photo", onReveal: noop, actions }));
      expect(html).toContain(cls);
      expect(html).not.toContain("<img");
      expect(html).not.toMatch(/\ssrc=/);
      expect(html).toContain("Sensitive content");
      expect(html).toMatch(/<button[^>]*>.*Show photo<\/span><\/button>/);
    });
    it(`Aspect=${aspect} State=Loading: Skeleton, aria-busy, no <img>`, () => {
      const html = r(h(PhotoCard, { state: "loading", aspect, title: "Loading", actions }));
      expect(html).toContain(cls);
      expect(html).not.toContain("<img");
      expect(html).not.toMatch(/\ssrc=/);
      expect(html).toContain('data-shape="block"');
      expect(html).toContain('aria-busy="true"');
    });
  }
  it("rejects an empty alt at runtime", () => {
    expect(() => r(h(PhotoCard, { state: "default", aspect: "square", title: "t", src: "/x.jpg", alt: "  ", width: 1, height: 1, actions: [] }))).toThrow(/alt/);
  });
  it("alt and src are required at the type level", () => {
    // @ts-expect-error -- alt is required for state "default"
    const missingAlt: PhotoCardProps = { state: "default", aspect: "square", title: "t", src: "/x.jpg", width: 1, height: 1, actions: [] };
    // @ts-expect-error -- a sensitive card cannot carry a src
    const sensitiveSrc: PhotoCardProps = { state: "sensitive", aspect: "square", title: "t", warning: "w", revealLabel: "r", onReveal: noop, actions: [], src: "/x.jpg" };
    expect([missingAlt, sensitiveSrc]).toHaveLength(2);
  });
});

describe("TabBar Item (Figma 15:31) / TabBar (15:32)", () => {
  it("Selected=Yes: aria-current=page, accent + weight; label is the name", () => {
    const html = r(h(TabBarItem, { href: "/a", icon: "home", label: "Home", selected: true }));
    expect(html).toMatch(/<a href="\/a" aria-current="page"/);
    expect(html).toContain("text-accent");
    expect(html).toContain("font-semibold");
    expect(html).toContain("<span>Home</span>");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
  it("Selected=No: no aria-current; State=Focus via focus-visible ring; 44px target", () => {
    const html = r(h(TabBarItem, { href: "/b", icon: "albums", label: "Albums", selected: false }));
    expect(html).not.toContain("aria-current");
    expect(html).toContain("focus-visible:outline-2");
    expect(html).toContain("min-h-touch-min");
    expect(html).toContain("min-w-touch-min");
  });
  it("TabBar: named nav, 72px, caller items, exactly one current", () => {
    const html = r(h(TabBar, { label: "Primary", items: [
      { href: "/a", icon: "home", label: "Home", selected: true },
      { href: "/b", icon: "search", label: "Search", selected: false },
    ] }));
    expect(html).toMatch(/^<nav aria-label="Primary"/);
    expect(html).toContain("h-[72px]");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(2);
  });
});
