import type { IconName } from "@/components/icons/registry";
import { Icon } from "@/components/icons/Icon";

import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Skeleton } from "./Skeleton";

/**
 * Figma `PhotoCard` (`12:263`, page `4:26`): `Aspect` = Landscape 3:2 |
 * Square 1:1 | Portrait 4:5; `State` = Default | Sensitive | Loading.
 *
 * Presentational only: every value is caller-supplied, nothing has a default
 * that looks like data. Departures (figma README §6):
 *  1. actions live in a persistent bar BELOW the image, never a hover overlay;
 *  2. the frame keeps the aspect ratio and the image is `object-contain`
 *     (cover/fill cropping is forbidden);
 *  3. favourite is a binary `aria-pressed` toggle; rating (1–5 radiogroup)
 *     is a separate control and is not drawn as a button here.
 *
 * PRIVACY: `state: "sensitive"` renders NO `<img>` and no `src` at all — not a
 * blurred original. The image is requested only after the caller's `onReveal`
 * flips the card to `state: "default"`. `state: "loading"` renders a Skeleton
 * and makes no image request either.
 */
export const PHOTO_CARD_ASPECT_CLASS = {
  landscape: "aspect-[3/2]",
  square: "aspect-square",
  portrait: "aspect-[4/5]",
} as const;

export type PhotoCardAspect = keyof typeof PHOTO_CARD_ASPECT_CLASS;

export interface PhotoCardAction {
  readonly icon: IconName;
  /** Required accessible name of the native button. */
  readonly label: string;
  readonly onClick: () => void;
  /** Toggles only (favourite); sets `aria-pressed`. */
  readonly pressed?: boolean;
}

interface Common {
  readonly aspect: PhotoCardAspect;
  /** Visible title under the image; caller-supplied. */
  readonly title: string;
  readonly actions: readonly PhotoCardAction[];
}

export type PhotoCardProps =
  | (Common & {
      readonly state: "default";
      readonly src: string;
      /** Required, non-empty. */
      readonly alt: string;
      readonly width: number;
      readonly height: number;
    })
  | (Common & {
      readonly state: "sensitive";
      /** Why it is covered, e.g. the caller's content-warning copy. */
      readonly warning: string;
      readonly revealLabel: string;
      readonly onReveal: () => void;
    })
  | (Common & { readonly state: "loading" });

export function PhotoCard(props: PhotoCardProps) {
  const { aspect, title, actions, state } = props;
  if (state === "default" && props.alt.trim() === "") {
    throw new Error("PhotoCard: alt must be non-empty");
  }
  return (
    <figure
      data-state={state}
      data-aspect={aspect}
      aria-busy={state === "loading" ? true : undefined}
      className="flex flex-col overflow-hidden rounded-md border border-line-2 bg-bg-elevated"
    >
      <div className={`relative w-full bg-bg-tint ${PHOTO_CARD_ASPECT_CLASS[aspect]}`}>
        {state === "default" && (
          // eslint-disable-next-line @next/next/no-img-element -- presentational; caller owns the URL and its authorization
          <img
            src={props.src}
            alt={props.alt}
            width={props.width}
            height={props.height}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        )}
        {state === "sensitive" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-on-media-scrim p-4 text-center text-on-media">
            <Icon name="hidden" size="lg" />
            <p className="text-body">{props.warning}</p>
            <Button kind="secondary" label={props.revealLabel} onClick={props.onReveal} />
          </div>
        )}
        {state === "loading" && (
          <div className="absolute inset-0">
            <Skeleton shape="block" />
          </div>
        )}
      </div>
      <figcaption className="flex min-h-touch-min items-center gap-2 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-body text-ink">{title}</span>
        {actions.map((a) => (
          <IconButton
            key={a.label}
            kind="quiet"
            icon={a.icon}
            label={a.label}
            pressed={a.pressed}
            onClick={a.onClick}
            disabled={state === "loading"}
          />
        ))}
      </figcaption>
    </figure>
  );
}
