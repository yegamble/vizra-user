import type { ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";

/**
 * Figma `Banner` (`17:68`, page `4:30`): `Tone` = Info | Warn | Danger. The
 * honest surface for "unavailable here": names why and who can change it.
 * Tone is carried by icon + text, never colour alone. A persistent region,
 * not a live announcement; announce changes with `Toast`.
 */
export const BANNER_TONE = {
  info: { cls: "border-line bg-accent-soft text-accent-ink", icon: "info" },
  warn: { cls: "border-warn bg-warn-soft text-warn-ink", icon: "warning" },
  danger: { cls: "border-danger bg-danger-soft text-danger-ink", icon: "error" },
} as const;

export interface BannerProps {
  readonly tone: keyof typeof BANNER_TONE;
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}

export function Banner({ tone, title, body, action }: BannerProps) {
  const t = BANNER_TONE[tone];
  return (
    <section data-tone={tone} aria-label={title} className={`flex items-start gap-3 rounded-md border p-4 ${t.cls}`}>
      <Icon name={t.icon} />
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-label">{title}</p>
        <p className="text-body text-ink">{body}</p>
        {action}
      </div>
    </section>
  );
}
