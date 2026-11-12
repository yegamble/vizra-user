import type { ButtonHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Chip` (`11:54`, page `4:25`): `Selected` = No | Yes; `State` =
 * Default | Hover | Focus | Disabled. A native toggle `<button aria-pressed>`;
 * Selected adds `icon/Check`, never colour alone (README §5). The design draws
 * the pill at 32px (`size/control-sm`); the hit area is extended to 44px
 * (`size/touch-min`, WCAG 2.2 2.5.8) exactly as IconButton does.
 */
export const CHIP_CLASS = {
  no: "border-line bg-bg-elevated text-ink group-hover:bg-bg-tint",
  yes: "border-accent bg-accent-soft text-accent-ink group-hover:bg-accent-soft",
} as const;

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "type" | "aria-pressed"> {
  readonly label: string;
  readonly selected: boolean;
}

export function Chip({ label, selected, ...rest }: ChipProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={selected}
      className={`group inline-flex min-h-touch-min items-center rounded-full disabled:cursor-not-allowed ${FOCUS_RING_CLASS}`}
    >
      <span
        className={`inline-flex h-control-sm items-center gap-1 rounded-full border px-3 text-label group-disabled:bg-bg-tint group-disabled:text-ink-3 ${CHIP_CLASS[selected ? "yes" : "no"]}`}
      >
        {selected ? <Icon name="confirm" size="sm" /> : null}
        <span>{label}</span>
      </span>
    </button>
  );
}
