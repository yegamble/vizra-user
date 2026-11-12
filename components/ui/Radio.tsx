import { useId, type InputHTMLAttributes } from "react";

import { FOCUS_RING_CLASS } from "./Button";

/**
 * Figma `Radio` (`10:103`, page `4:24`): `Checked` = Off | On; `State` =
 * Default | Hover | Focus | Disabled. Native radios in a real
 * `<fieldset>`/`<legend>` (README §5) so the group is programmatically named
 * and arrow-key selection is native.
 */
export const RADIO_CLASS =
  "size-5 shrink-0 rounded-full border border-line accent-accent hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-60";

export interface RadioOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface RadioGroupProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "type" | "value" | "checked" | "name"> {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly RadioOption[];
  readonly value?: string;
}

export function RadioGroup({ legend, name, options, value, disabled, ...rest }: RadioGroupProps) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1">
      <legend className="text-label text-ink">{legend}</legend>
      {options.map((o, i) => (
        <div key={o.value} className="flex min-h-touch-min items-center gap-2">
          <input
            {...rest}
            id={`${id}-${i}`}
            type="radio"
            name={name}
            value={o.value}
            checked={value === undefined ? undefined : value === o.value}
            disabled={o.disabled}
            className={`${RADIO_CLASS} ${FOCUS_RING_CLASS}`}
          />
          <label htmlFor={`${id}-${i}`} className="text-body text-ink">
            {o.label}
          </label>
        </div>
      ))}
    </fieldset>
  );
}
