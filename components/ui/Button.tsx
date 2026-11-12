import type { ButtonHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";
import type { IconName } from "@/components/icons/registry";

/**
 * Figma `Button` (`7:146`, page `4:21`): `Kind` = Primary | Secondary | Quiet |
 * Danger; `State` = Default | Hover | Pressed | Focus | Disabled | Loading.
 * Hover/Pressed/Focus are CSS states (`hover:`, `active:`, the global
 * `:focus-visible` ring from tokens); Disabled and Loading are props.
 * Native `<button>` only — navigation uses `<a>`, never this component.
 */
export const BUTTON_KIND_CLASS = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
  secondary: "bg-bg-elevated text-ink border border-line hover:bg-bg-tint active:bg-bg-tint",
  quiet: "bg-transparent text-accent-ink hover:bg-accent-soft active:bg-accent-soft",
  danger: "bg-danger text-on-danger hover:bg-danger-hover active:bg-danger-pressed",
} as const;

export type ButtonKind = keyof typeof BUTTON_KIND_CLASS;

/** Disabled: `bg-tint` + `ink-3` so the text stays readable (README §5). */
export const BUTTON_DISABLED_CLASS = "disabled:bg-bg-tint disabled:text-ink-3 disabled:border-transparent disabled:cursor-not-allowed";
export const FOCUS_RING_CLASS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  readonly kind?: ButtonKind;
  /** The visible text — it is the accessible name and does not change while loading. */
  readonly label: string;
  readonly leadingIcon?: IconName;
  readonly loading?: boolean;
}

export function Button({
  kind = "primary",
  label,
  leadingIcon,
  loading = false,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const inert = disabled || loading;
  return (
    <button
      {...rest}
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      data-kind={kind}
      className={`inline-flex h-control min-w-touch-min items-center justify-center gap-2 rounded-md px-4 text-label ${BUTTON_KIND_CLASS[kind]} ${BUTTON_DISABLED_CLASS} ${FOCUS_RING_CLASS}`}
    >
      {loading ? (
        <Icon name="loading" className="animate-spin motion-reduce:animate-none" />
      ) : leadingIcon ? (
        <Icon name={leadingIcon} />
      ) : null}
      <span>{label}</span>
    </button>
  );
}
