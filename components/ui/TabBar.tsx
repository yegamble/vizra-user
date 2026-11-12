import { Icon } from "@/components/icons/Icon";
import type { IconName } from "@/components/icons/registry";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `TabBar Item` (`15:31`) and `TabBar` (`15:32`, 390×72), page `4:28`.
 * `Selected` = No | Yes (→ `aria-current="page"`, accent colour plus a
 * weight change, never colour alone); `State` = Default | Focus (focus-visible
 * ring). Items are plain `<a>` per the shell convention (TopBar.tsx). The
 * caller supplies every item, label and href; nothing here is a route.
 */
export interface TabBarItemProps {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly selected: boolean;
}

export function TabBarItem({ href, icon, label, selected }: TabBarItemProps) {
  return (
    <a
      href={href}
      aria-current={selected ? "page" : undefined}
      data-selected={selected ? "yes" : "no"}
      className={`flex min-h-touch-min min-w-touch-min flex-1 flex-col items-center justify-center gap-1 rounded-sm text-caption ${
        selected ? "font-semibold text-accent" : "text-ink-2"
      } ${FOCUS_RING_CLASS}`}
    >
      <Icon name={icon} size="lg" />
      <span>{label}</span>
    </a>
  );
}

export interface TabBarProps {
  /** Accessible name of the `<nav>`. */
  readonly label: string;
  readonly items: readonly TabBarItemProps[];
}

export function TabBar({ label, items }: TabBarProps) {
  return (
    <nav aria-label={label} className="h-[72px] w-full border-t border-line-2 bg-bg-frost backdrop-blur-[20px]">
      <ul className="flex h-full items-stretch px-2">
        {items.map((item) => (
          <li key={item.href} className="flex flex-1">
            <TabBarItem {...item} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
