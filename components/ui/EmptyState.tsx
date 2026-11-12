import type { ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";

/**
 * Figma `EmptyState` (`17:95`, page `4:30`): `Kind` = Empty | No results.
 * All copy comes from the caller; the optional action is the caller's real control.
 */
export interface EmptyStateProps {
  readonly kind: "empty" | "noResults";
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}

export function EmptyState({ kind, title, body, action }: EmptyStateProps) {
  return (
    <div data-kind={kind} className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="text-ink-3">
        <Icon name={kind === "empty" ? "photo" : "search"} size="lg" />
      </span>
      <h2 className="text-title-3 text-ink">{title}</h2>
      <p className="max-w-prose text-body text-ink-2">{body}</p>
      {action}
    </div>
  );
}
