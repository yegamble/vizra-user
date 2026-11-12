"use client";

import { useId, useRef, type KeyboardEvent } from "react";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Tab` (`11:79`, page `4:25`): `Selected` = No | Yes; `State` =
 * Default | Hover | Focus. WAI-ARIA tablist with roving tabindex: only the
 * selected tab is in the Tab order; Left/Right wrap, Home/End jump, and
 * selection follows focus. Selected adds a 2px indicator plus a weight change,
 * never colour alone (README §5). Panels are owned by the caller and labelled
 * via `tabPanelId`.
 */
export const TAB_CLASS = {
  no: "border-transparent font-medium text-ink-2 hover:text-ink",
  yes: "border-accent font-semibold text-ink",
} as const;

/** Next index for a key, or null if the key is not a tablist key. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export interface TabsProps {
  readonly label: string;
  readonly tabs: readonly TabItem[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}

export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`;

export function Tabs({ label, tabs, selectedId, onSelect }: TabsProps) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, tabs.findIndex((t) => t.id === selectedId));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabIndex(e.key, current, tabs.length);
    if (next === null) return;
    e.preventDefault();
    onSelect(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-4 border-b border-line">
      {tabs.map((t, i) => {
        const selected = i === current;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={tabPanelId(base, t.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            className={`-mb-px min-h-touch-min border-b-2 px-1 text-label ${TAB_CLASS[selected ? "yes" : "no"]} ${FOCUS_RING_CLASS}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
