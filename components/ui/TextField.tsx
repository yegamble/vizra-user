import { useId, type InputHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `TextField` (`9:42`, page `4:23`): `State` = Default | Hover | Focus |
 * Error | Disabled. A persistent visible `<label>` (never placeholder-as-label);
 * helper and error are linked with `aria-describedby`; Error carries
 * `icon/CircleAlert` + text + `aria-invalid`, never colour alone. Callers pass
 * the correct `autoComplete` token.
 */
export const FIELD_BASE_CLASS =
  "h-control w-full rounded-md border bg-bg-elevated px-3 text-body text-ink placeholder:text-ink-3 hover:border-ink-3 disabled:bg-bg-tint disabled:text-ink-3 disabled:cursor-not-allowed";
export const FIELD_ERROR_CLASS = "border-danger";
export const FIELD_DEFAULT_CLASS = "border-line";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "aria-invalid" | "aria-describedby"> {
  readonly label: string;
  readonly helper?: string;
  /** When set, the field is in the Error state. */
  readonly error?: string;
}

export function TextField({ label, helper, error, type = "text", ...rest }: TextFieldProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${FIELD_BASE_CLASS} ${error ? FIELD_ERROR_CLASS : FIELD_DEFAULT_CLASS} ${FOCUS_RING_CLASS}`}
      />
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
