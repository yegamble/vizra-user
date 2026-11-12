import type { ButtonHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";
import type { IconName } from "@/components/icons/registry";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `IconButton` (`8:104`, page `4:22`): `Kind` = Secondary | Quiet |
 * Danger | On media; `State` = Default | Hover | Pressed | Focus | Disabled.
 * The accessible name is on the BUTTON (`label` → `aria-label`), never on the
 * SVG. Hit box 44×44 (`size-touch-min`), visible pill 40×40 (`size-control`).
 * A toggle passes `pressed`, which sets `aria-pressed`; its label stays stable.
 */
export const ICON_BUTTON_KIND_CLASS = {
  secondary: "bg-bg-elevated text-ink border border-line group-hover:bg-bg-tint group-active:bg-bg-tint",
  quiet: "bg-transparent text-ink-2 group-hover:bg-bg-tint group-active:bg-bg-tint",
  danger: "bg-transparent text-danger-ink group-hover:bg-danger-soft group-active:bg-danger-soft",
  onMedia: "bg-on-media-scrim text-on-media",
} as const;

export type IconButtonKind = keyof typeof ICON_BUTTON_KIND_CLASS;

/** On a photograph the ring becomes the dual ring (README §4 Focus-visible). */
const ON_MEDIA_FOCUS =
  "focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--vz-on-media-scrim),0_0_0_4px_var(--vz-on-media)]";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "aria-label"> {
  readonly kind?: IconButtonKind;
  readonly icon: IconName;
  /** Required accessible name. */
  readonly label: string;
  /** Present only for toggles; sets `aria-pressed`. */
  readonly pressed?: boolean;
}

export function IconButton({
  kind = "secondary",
  icon,
  label,
  pressed,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      data-kind={kind}
      className={`group inline-flex size-touch-min items-center justify-center rounded-full disabled:cursor-not-allowed ${
        kind === "onMedia" ? ON_MEDIA_FOCUS : FOCUS_RING_CLASS
      }`}
    >
      <span
        className={`inline-flex size-control items-center justify-center rounded-full group-disabled:bg-bg-tint group-disabled:text-ink-3 ${ICON_BUTTON_KIND_CLASS[kind]}`}
      >
        <Icon name={icon} />
      </span>
    </button>
  );
}
