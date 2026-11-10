import { ICONS, type IconName } from "./registry";

/** `size/icon-sm` 16 (inline), `size/icon` 20 (controls), `size/icon-lg` 24. */
const SIZE_CLASS = {
  sm: "size-icon-sm",
  md: "size-icon",
  lg: "size-icon-lg",
} as const;

export type IconSize = keyof typeof SIZE_CLASS;

export interface IconProps {
  /** A key of the registry. An unknown name does not typecheck. */
  readonly name: IconName;
  readonly size?: IconSize;
  readonly className?: string;
}

/**
 * A DECORATIVE glyph. It is always hidden from assistive technology and never
 * focusable: the accessible name belongs on the button or link that contains
 * it (`aria-label`, or visible text), never on the SVG. That is why this
 * component takes no `label`, `title` or `aria-*` prop — there is no way to
 * use it as the only name of a control.
 *
 * It inherits `currentColor`, so its colour is the text token of its parent.
 * The stroke is Lucide's 2px on the 24px grid and scales with the icon.
 */
export function Icon({ name, size = "md", className }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      className={
        className
          ? `${SIZE_CLASS[size]} shrink-0 ${className}`
          : `${SIZE_CLASS[size]} shrink-0`
      }
    />
  );
}
