import { Icon } from "@/components/icons/Icon";

/**
 * Figma `Avatar` (`14:56`, page `4:27`): `Size` = XS | SM | MD | LG
 * (24/32/40/64); `Type` = Image | Initials | Fallback. The caller supplies the
 * person's name (the accessible name) and, for Image, the image URL. No
 * default name, no default image.
 */
export const AVATAR_SIZE_CLASS = {
  xs: "size-6 text-caption",
  sm: "size-8 text-caption",
  md: "size-10 text-label",
  lg: "size-16 text-title-3",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE_CLASS;

export interface AvatarProps {
  readonly name: string;
  readonly size?: AvatarSize;
  /** Image type when present; otherwise Initials, or Fallback when the name has no letters. */
  readonly src?: string;
}

/** Up to two initials from the name; empty when the name has no letter or digit. */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => Array.from(part).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();
}

export function Avatar({ name, size = "md", src }: AvatarProps) {
  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-tint text-ink-2 ${AVATAR_SIZE_CLASS[size]}`;
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- caller-supplied, already-authorised URL
    return <img src={src} alt={name} className={`${base} object-cover`} />;
  }
  const initials = initialsOf(name);
  return (
    <span role="img" aria-label={name} data-type={initials ? "initials" : "fallback"} className={base}>
      {initials ? <span aria-hidden="true">{initials}</span> : <Icon name="person" size={size === "lg" ? "lg" : "sm"} />}
    </span>
  );
}
