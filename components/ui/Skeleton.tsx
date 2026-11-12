/**
 * Figma `Skeleton` (`17:72`, page `4:30`): `Shape` = Line | Block | Circle.
 * Decorative (`aria-hidden`); the caller announces loading with `aria-busy`
 * on the region. A static tint — no pulse, no sweep (FIRST-SLICE library §motion).
 */
export const SKELETON_SHAPE_CLASS = {
  line: "h-4 w-full rounded-sm",
  block: "h-full w-full rounded-md",
  circle: "aspect-square h-full rounded-full",
} as const;

export function Skeleton({ shape }: { readonly shape: keyof typeof SKELETON_SHAPE_CLASS }) {
  return <span aria-hidden="true" data-shape={shape} className={`block bg-bg-tint ${SKELETON_SHAPE_CLASS[shape]}`} />;
}
