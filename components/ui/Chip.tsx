import type { ButtonHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Chip` (`11:54`, page `4:25`): `Selected` = No | Yes; `State` =
 * Default | Hover | Focus | Disabled. A native toggle `<button aria-pressed>`;
 * Selected adds `icon/Check`, never colour alone (README §5).
 */
export const CHIP_CLASS = {
  no: "border-line bg-bg-elevated text-ink hover:bg-bg-tint",
  yes: "border-accent bg-accent-soft text-accent-ink hover:bg-accent-soft",
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
      className={`inline-flex h-control-sm items-center gap-1 rounded-full border px-3 text-label disabled:cursor-not-allowed disabled:bg-bg-tint disabled:text-ink-3 ${CHIP_CLASS[selected ? "yes" : "no"]} ${FOCUS_RING_CLASS}`}
    >
      {selected ? <Icon name="confirm" size="sm" /> : null}
      <span>{label}</span>
    </button>
  );
}
