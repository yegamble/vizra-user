import { useId, type SelectHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";

import { FOCUS_RING_CLASS } from "./Button";
import { FIELD_BASE_CLASS, FIELD_DEFAULT_CLASS, FIELD_ERROR_CLASS } from "./TextField";

/**
 * Figma `Select` (`9:139`, page `4:23`): `State` = Default | Hover | Focus |
 * Error | Disabled — TextField contract on a native `<select>` (native keyboard
 * and listbox semantics); the chevron is decorative.
 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "id" | "aria-invalid" | "aria-describedby" | "children"> {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly helper?: string;
  readonly error?: string;
}

export function Select({ label, options, helper, error, ...rest }: SelectProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <div className="relative">
        <select
          {...rest}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`${FIELD_BASE_CLASS} appearance-none pr-10 ${error ? FIELD_ERROR_CLASS : FIELD_DEFAULT_CLASS} ${FOCUS_RING_CLASS}`}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-2">
          <Icon name="expand" size="sm" />
        </span>
      </div>
      {helper ? (
        <p id={helperId} className="text-caption text-ink-2">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-caption text-danger-ink">
          <Icon name="error" size="sm" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
