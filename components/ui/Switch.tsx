import { useId, type InputHTMLAttributes } from "react";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Switch` (`10:144`, page `4:24`): `Checked` = Off | On; `State` =
 * Default | Hover | Focus | Disabled. Native-first: `<input type=checkbox
 * role="switch">`. The native checked state supplies `aria-checked`, Space
 * toggles, form submission and `disabled` work with no script — a
 * `<button aria-checked>` would need all three hand-built. Thumb position is
 * the visual cue (never colour alone); the Off track has a `line` boundary.
 */
export const SWITCH_TRACK_CLASS =
  "relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border border-line bg-bg-tint transition-colors motion-reduce:transition-none checked:border-accent checked:bg-accent hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-60 " +
  "before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:bg-bg-elevated before:shadow-1 before:transition-transform motion-reduce:before:transition-none checked:before:translate-x-4";

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "type" | "role"> {
  readonly label: string;
}

export function Switch({ label, ...rest }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex min-h-touch-min items-center gap-2">
      <input {...rest} id={id} type="checkbox" role="switch" className={`${SWITCH_TRACK_CLASS} ${FOCUS_RING_CLASS}`} />
      <label htmlFor={id} className="text-body text-ink">
        {label}
      </label>
    </div>
  );
}
