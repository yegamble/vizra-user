"use client";

import { useCallback, useId, type InputHTMLAttributes } from "react";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Checkbox` (`10:66`, page `4:24`): `Checked` = Off | On | Mixed;
 * `State` = Default | Hover | Focus | Disabled. Native `<input type=checkbox>`
 * (Space toggles natively). Mixed uses the DOM `indeterminate` property, which
 * the accessibility tree reports as `mixed` — no `aria-checked` on a native
 * input. The Off boundary is `line` at regular stroke (README §5: 3.49:1).
 */
export type CheckboxChecked = "off" | "on" | "mixed";

export const CHECKBOX_CLASS =
  "size-5 shrink-0 rounded-sm border border-line accent-accent hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-60";

export function applyMixed(el: HTMLInputElement | null, mixed: boolean): void {
  if (el) el.indeterminate = mixed;
}

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "type" | "checked" | "defaultChecked"> {
  readonly label: string;
  readonly checked: CheckboxChecked;
}

export function Checkbox({ label, checked, ...rest }: CheckboxProps) {
  const id = useId();
  const mixed = checked === "mixed";
  const ref = useCallback((el: HTMLInputElement | null) => applyMixed(el, mixed), [mixed]);
  return (
    <div className="flex min-h-touch-min items-center gap-2">
      <input
        {...rest}
        ref={ref}
        id={id}
        type="checkbox"
        checked={checked === "on"}
        data-checked={checked}
        className={`${CHECKBOX_CLASS} ${FOCUS_RING_CLASS}`}
      />
      <label htmlFor={id} className="text-body text-ink">
        {label}
      </label>
    </div>
  );
}
