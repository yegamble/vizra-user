import type { ReactNode } from "react";

import { Icon } from "@/components/icons/Icon";

/**
 * Figma `Toast / Inline status` (`17:40`, page `4:30`): `Tone` = Success |
 * Error | Info. For REAL outcomes only: the message is required and comes from
 * the caller — there is no default text. Success/Info are a polite live
 * status; Error is `role="alert"`, never auto-dismisses (this component has
 * no timer) and must carry its recovery action.
 */
export const TOAST_TONE = {
  success: { cls: "border-success bg-success-soft text-success-ink", icon: "success" },
  info: { cls: "border-line bg-bg-elevated text-ink", icon: "info" },
  error: { cls: "border-danger bg-danger-soft text-danger-ink", icon: "error" },
} as const;

export type ToastProps =
  | { readonly tone: "success" | "info"; readonly message: string; readonly action?: ReactNode }
  | { readonly tone: "error"; readonly message: string; readonly action: ReactNode };

export function liveRoleOf(tone: ToastProps["tone"]) {
  return tone === "error"
    ? ({ role: "alert" } as const)
    : ({ role: "status", "aria-live": "polite" } as const);
}

export function Toast({ tone, message, action }: ToastProps) {
  const t = TOAST_TONE[tone];
  return (
    <div {...liveRoleOf(tone)} data-tone={tone} className={`flex items-center gap-3 rounded-md border p-3 shadow-2 ${t.cls}`}>
      <Icon name={t.icon} />
      <p className="flex-1 text-body">{message}</p>
      {action}
    </div>
  );
}
