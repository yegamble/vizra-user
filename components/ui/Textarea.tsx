import { useId, type TextareaHTMLAttributes } from "react";

import { Icon } from "@/components/icons/Icon";

import { FOCUS_RING_CLASS } from "./Button";
import { FIELD_DEFAULT_CLASS, FIELD_ERROR_CLASS } from "./TextField";

/**
 * Figma `Textarea` (`9:83`, page `4:23`): `State` = Default | Hover | Focus |
 * Error | Disabled — same contract as TextField: persistent visible `<label>`,
 * helper/error via `aria-describedby`, Error = icon + text + `aria-invalid`.
 */
export const TEXTAREA_BASE_CLASS =
  "min-h-24 w-full rounded-md border bg-bg-elevated px-3 py-2 text-body text-ink placeholder:text-ink-3 hover:border-ink-3 disabled:bg-bg-tint disabled:text-ink-3 disabled:cursor-not-allowed";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id" | "aria-invalid" | "aria-describedby"> {
  readonly label: string;
  readonly helper?: string;
  readonly error?: string;
}

export function Textarea({ label, helper, error, ...rest }: TextareaProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <textarea
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${TEXTAREA_BASE_CLASS} ${error ? FIELD_ERROR_CLASS : FIELD_DEFAULT_CLASS} ${FOCUS_RING_CLASS}`}
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
